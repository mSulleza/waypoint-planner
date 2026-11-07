import {
  addDays,
  cardsOf,
  convert,
  debtFigures,
  expandPlan,
  firstOfMonth,
  itemSchedule,
  lastDayOfMonth,
  loansOf,
  minorDigits,
  monthKey,
  nextLoanPayment,
  occurrenceId,
  parseAmount,
  snapshotIndex,
  suggestFor,
  toRatesPerEur,
  validateLink,
  type Account,
  type BatchTransaction,
  type Category,
  type Occurrence,
  type PostBatchInput,
  type Snapshot,
  type TransactionKind,
  type Walk,
} from '@waypoint/core'
import type { ReceiptRead } from '../../ai/pdf-read'
import type { Edit } from '../../data/edits'
import { amountText, isDay } from '../../data/field-text'
import { shortDay } from '../../data/status'
import { lastAccountId } from '../../shell/shell.model'
import { addCategory, readCategoryName } from '../settings/settings.model'

export { amountText, isDay }

// Spec §7 Add sheet: Out, In or Move, one post_batch per save.
export type Mode = 'out' | 'in' | 'move'

export const MODES: readonly { value: Mode; label: string }[] = [
  { value: 'out', label: 'Out' },
  { value: 'in', label: 'In' },
  { value: 'move', label: 'Move' },
]

// What Record, Pay, quick add and the next action pass in the address. amount is in minor units of the paying account's currency (the receiving one for In).
export interface AddParams {
  mode?: string
  from?: string
  to?: string
  amount?: string
  plan_item_id?: string
  period?: string
}

export interface Link {
  plan_item_id: string
  period: string
}

// Everything as the person typed or picked it; readDraft parses each amount once, in the household locale.
export interface Draft {
  mode: Mode
  // Out: the paying account; In: the receiving one; Move: where money leaves.
  account: string | null
  // Move only: where money lands.
  to: string | null
  // Out and In: the amount; Move: what was sent, in the account's currency.
  amount: string
  // Move across currencies: what landed, in the to account's currency.
  received: string
  refund: boolean
  category: string | null
  date: string
  // Move: the day the incoming leg posted, the same day to 5 days later.
  arrives: string
  note: string
  link: Link | null
  // 'Paid more than due' as the person set it; null follows the card's figures.
  over: boolean | null
  // A loan payment's escrow, saved as an expense that settles the escrow bill.
  escrow: boolean
  escrow_amount: string
}

export type Field = 'amount' | 'received' | 'account' | 'to' | 'date' | 'arrives' | 'escrow' | 'note' | 'link'

export type Errors = Partial<Record<Field, string>>

// The incoming leg may post up to this many days after the outgoing one (the transfer_pair check).
export const ARRIVAL_DAYS = 5
export const NOTE_MAX = 140

const open = (a: Account) => a.archived_at === null
const bySortOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// Out and In take cash accounts and cards; Move leaves a cash account for any other account.
export function accountChoices(snapshot: Snapshot, mode: Mode, role: 'account' | 'to', from: string | null = null): Account[] {
  const accounts = snapshot.doc.accounts.filter(open)
  const list = role === 'account' ? accounts.filter((a) => (mode === 'move' ? a.kind === 'cash' : a.kind !== 'loan')) : accounts.filter((a) => a.id !== from)
  return list.sort(bySortOrder)
}

export interface CardPay {
  card_id: string
  currency: string
  // The current cycle's left to pay and remaining due (spec §6.4), read from core, never re-derived.
  left_minor: number
  remaining_minor: number
  owed_minor: number
  // Charges posted on the card since the cut: owed minus remaining due.
  charges_minor: number
  // The latest cut passed with no entered statement, so post_batch still measures from the last one entered.
  provisional: boolean
  cut_date: string
  due_date: string
}

export function cardPay(snapshot: Snapshot, walk: Walk, cardId: string): CardPay | null {
  const card = snapshotIndex(snapshot).accounts.get(cardId)
  const replay = cardsOf(walk)?.get(cardId)
  if (card?.kind !== 'credit_card' || !replay) return null
  const figures = debtFigures(snapshot, walk).cards.find((c) => c.account_id === cardId)
  const current = replay.statements.find((s) => s.id === replay.current_id)
  if (!figures || !current) return null
  return {
    card_id: cardId,
    currency: card.currency,
    left_minor: figures.payment?.left_to_pay_minor ?? 0,
    remaining_minor: figures.remaining_due_minor,
    owed_minor: figures.owed_minor,
    charges_minor: figures.owed_minor - figures.remaining_due_minor,
    provisional: current.provisional,
    cut_date: current.cut_date,
    due_date: current.due_date,
  }
}

export interface Over {
  // What post_batch receives as allow_over.
  allow: boolean
  // Ticked by the figures: the amount is above the remaining due but no more than left to pay.
  auto: boolean
  // Of the amount, what pays charges since the statement, and what pays more the plan sends this cycle (charges planned before the pay day).
  charged_minor: number
  planned_minor: number
}

// 'Paid more than due' ticks itself when left to pay exceeds the remaining due, so the prefilled amount never errors; above both it waits for the person.
export function overState(pay: CardPay | null, received: number | null, choice: boolean | null): Over {
  if (pay === null || pay.provisional || received === null || received <= pay.remaining_minor || received > Math.max(pay.left_minor, pay.remaining_minor)) {
    return { allow: choice ?? false, auto: false, charged_minor: 0, planned_minor: 0 }
  }
  const above = received - Math.max(0, pay.remaining_minor)
  const charged = Math.min(above, Math.max(0, pay.charges_minor))
  return { allow: choice ?? true, auto: true, charged_minor: charged, planned_minor: above - charged }
}

export interface Escrow {
  occurrence_id: string
  plan_item_id: string
  period: string
  name: string
  account_id: string
  amount_minor: number
}

export interface LoanPay {
  loan_id: string
  currency: string
  // The scheduled payment still owed on its day.
  due_minor: number
  on: string
  overdue: boolean
  // Within the 7 days that count toward it, or overdue: only then is the amount prefilled.
  in_window: boolean
  escrow: Escrow | null
}

const OPEN_STATES = new Set(['due', 'overdue', 'partly_settled'])

// The loan's next payment from its schedule, and an open bill on the paying account due the same day, which a lender's debit includes as escrow.
export function loanPay(snapshot: Snapshot, walk: Walk, loanId: string, fromId: string | null, windowDays = 7): LoanPay | null {
  const loan = snapshotIndex(snapshot).accounts.get(loanId)
  const schedule = loansOf(walk)?.get(loanId)
  if (loan?.kind !== 'loan' || !schedule) return null
  const asOf = snapshot.as_of
  const next = nextLoanPayment(schedule, asOf)
  if (!next) return null
  const plan = expandPlan(snapshot)
  const bill = fromId === null ? undefined : plan.occurrences.find((o) => o.flow === 'bill' && o.account_id === fromId && o.open_minor > 0 && o.state !== null && OPEN_STATES.has(o.state) && (o.date === next.on || o.scheduled_on === next.on))
  const item = bill ? snapshotIndex(snapshot).planItems.get(bill.plan_item_id) : undefined
  return {
    loan_id: loanId,
    currency: loan.currency,
    due_minor: next.left_minor,
    on: next.on,
    overdue: next.overdue,
    in_window: next.overdue || addDays(next.on, -windowDays) <= asOf,
    escrow: bill && item ? { occurrence_id: bill.id, plan_item_id: bill.plan_item_id, period: bill.period, name: item.name, account_id: bill.account_id, amount_minor: bill.open_minor } : null,
  }
}

export interface Opening {
  draft: Draft
  // An amount came prefilled, so with the eye on the sheet keeps it masked and does not focus it.
  prefilled: boolean
  // Pay on a card whose cut passed with no statement opens the Statement sheet first.
  statement_first: string | null
}

function readMinor(text: string | undefined): number | null {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null
}

// The occurrence Record names, when it exists in the plan.
function recordOf(snapshot: Snapshot, params: AddParams): Occurrence | null {
  if (!params.plan_item_id || !params.period) return null
  return expandPlan(snapshot).byId.get(occurrenceId(params.plan_item_id, params.period)) ?? null
}

function modeOfFlow(o: Occurrence): Mode {
  if (o.flow === 'bill' || o.flow === 'card_bill') return 'out'
  if (o.flow === 'income' || o.flow === 'draw') return 'in'
  return 'move'
}

// How the sheet opens: the address first, then the occurrence Record names, then the account this device used last (else where money last went out), and the card or loan figures.
export function openDraft(snapshot: Snapshot, walk: Walk | null, params: AddParams, lastAccount: string | null, locale: string): Opening {
  const index = snapshotIndex(snapshot)
  const record = recordOf(snapshot, params)
  const asked = MODES.find((m) => m.value === params.mode)?.value
  const mode: Mode = asked ?? (record ? modeOfFlow(record) : 'out')

  // The first wanted id that is open to this role, else the first cash account there.
  const first = (role: 'account' | 'to', wanted: readonly (string | null | undefined)[], from: string | null = null): string | null => {
    const ids = accountChoices(snapshot, mode, role, from)
    return wanted.find((id): id is string => typeof id === 'string' && ids.some((a) => a.id === id)) ?? null
  }
  let to: string | null = null
  let account: string | null
  if (mode === 'move') {
    to = first('to', [params.to, record?.flow === 'transfer' ? record.to_account_id : record?.flow === 'debt_transfer' ? record.account_id : null])
    const funder = to === null ? null : (index.accounts.get(to)?.funded_from_account_id ?? null)
    const fallback = accountChoices(snapshot, mode, 'account').find((a) => a.id !== to)?.id ?? null
    account = first('account', [params.from, record?.flow === 'transfer' ? record.account_id : null, funder, lastAccount, lastAccountId(snapshot.doc)].filter((id) => id !== to)) ?? fallback
  } else {
    const fallback = accountChoices(snapshot, mode, 'account').find((a) => a.kind === 'cash')?.id ?? null
    account = first('account', [mode === 'in' ? (params.to ?? params.from) : params.from, record?.account_id, lastAccount, lastAccountId(snapshot.doc)]) ?? fallback
  }

  const currencyOf = (id: string | null) => (id === null ? null : (index.accounts.get(id)?.currency ?? null))
  const sendCurrency = currencyOf(account)
  const landCurrency = mode === 'move' ? currencyOf(to) : sendCurrency
  const across = mode === 'move' && sendCurrency !== null && landCurrency !== null && sendCurrency !== landCurrency
  const text = (minor: number | null, currency: string | null) => (minor === null || currency === null || minor <= 0 ? '' : amountText(minor, currency, locale))

  const given = readMinor(params.amount)
  const toAccount = to === null ? undefined : index.accounts.get(to)
  const pay = given === null ? debtPrefill(snapshot, walk, account, to, locale) : null
  const statementFirst = pay?.provisional && params.to === toAccount?.id ? (toAccount?.id ?? null) : null
  let amount = pay?.amount ?? text(given, sendCurrency)
  let received = pay?.received ?? ''
  if (given === null && !pay && record && record.open_minor > 0) {
    if (across) received = text(record.open_minor, landCurrency)
    else amount = text(record.open_minor, sendCurrency)
  }

  const link = record ? { plan_item_id: record.plan_item_id, period: record.period } : null
  const draft: Draft = {
    mode,
    account,
    to,
    amount,
    received,
    refund: false,
    category: mode === 'out' && link === null ? defaultCategory(snapshot, snapshot.as_of) : null,
    date: snapshot.as_of,
    arrives: snapshot.as_of,
    note: '',
    link,
    over: null,
    escrow: pay?.escrow ?? false,
    escrow_amount: pay?.escrow_amount ?? '',
  }
  return { draft: { ...draft, link: linkFits(snapshot, draft) ? draft.link : null }, prefilled: amount !== '' || received !== '', statement_first: statementFirst }
}

// A new mode keeps the account when the mode takes it, else falls back to the last account or the first cash account; a link that no longer fits is dropped.
export function switchMode(snapshot: Snapshot, draft: Draft, mode: Mode, lastAccount: string | null): Draft {
  const ids = accountChoices(snapshot, mode, 'account').map((a) => a.id)
  const fallback = accountChoices(snapshot, mode, 'account').find((a) => a.kind === 'cash')?.id ?? null
  const account = [draft.account, lastAccount].find((id): id is string => id !== null && ids.includes(id)) ?? fallback
  const category = mode === 'out' && draft.category === null && draft.link === null ? defaultCategory(snapshot, draft.date) : draft.category
  return fitLink(snapshot, { ...draft, mode, account, to: mode === 'move' && draft.to !== account ? draft.to : null, over: null, category })
}

// The category an expense most likely takes: the only budget this month, else the one tagged last; null when neither says.
export function defaultCategory(snapshot: Snapshot, day: string): string | null {
  const offer = categoryOffer(snapshot, day, null)
  if (offer.budgeted.length === 1) return offer.budgeted[0]?.id ?? null
  const latest = offer.chips[0]
  return latest && snapshot.doc.transactions.some((t) => t.category_id === latest.id) ? latest.id : null
}

// Drops a link the draft can no longer settle, after an account or mode change.
export function fitLink(snapshot: Snapshot, draft: Draft): Draft {
  return draft.link === null || linkFits(snapshot, draft) ? draft : { ...draft, link: null }
}

export interface DebtPrefill {
  amount: string
  received: string
  escrow: boolean
  escrow_amount: string
  // The card's cut passed with no entered statement: nothing is prefilled.
  provisional: boolean
}

// A payment into a card prefills left to pay; into a loan, inside its payment window, the payment and any escrow due that day. The amount goes in Received across currencies.
export function debtPrefill(snapshot: Snapshot, walk: Walk | null, from: string | null, to: string | null, locale: string): DebtPrefill | null {
  const index = snapshotIndex(snapshot)
  const [source, target] = [from === null ? undefined : index.accounts.get(from), to === null ? undefined : index.accounts.get(to)]
  if (!walk || !source || !target || target.kind === 'cash') return null
  const across = source.currency !== target.currency
  const put = (minor: number) => (across ? { amount: '', received: amountText(minor, target.currency, locale) } : { amount: amountText(minor, source.currency, locale), received: '' })
  if (target.kind === 'credit_card') {
    const pay = cardPay(snapshot, walk, target.id)
    if (!pay) return null
    if (pay.provisional || pay.left_minor <= 0) return { amount: '', received: '', escrow: false, escrow_amount: '', provisional: pay.provisional }
    return { ...put(pay.left_minor), escrow: false, escrow_amount: '', provisional: false }
  }
  const pay = loanPay(snapshot, walk, target.id, source.id)
  if (!pay?.in_window) return null
  return { ...put(pay.due_minor), escrow: pay.escrow !== null, escrow_amount: pay.escrow ? amountText(pay.escrow.amount_minor, source.currency, locale) : '', provisional: false }
}

// The row kind the draft saves on its paying (or only) account.
export function rowKind(draft: Pick<Draft, 'mode' | 'refund'>): TransactionKind {
  if (draft.mode === 'out') return 'expense'
  if (draft.mode === 'in') return draft.refund ? 'refund' : 'income'
  return 'transfer'
}

// A receipt read from its PDF, as if typed: money out of an account in the receipt's currency (the one chosen, when it is), its total, its day, the shop and what was bought as the note, and the category DeepSeek suggested when it is still open. A plan link follows from the amount, as it does when typing.
export function receiptDraft(snapshot: Snapshot, draft: Draft, read: ReceiptRead, locale: string): { draft: Draft } | { mismatch: string } {
  const chosen = draft.account === null ? undefined : snapshot.doc.accounts.find((a) => a.id === draft.account)
  const account = chosen?.currency === read.currency ? chosen : accountChoices(snapshot, 'out', 'account').find((a) => a.currency === read.currency)
  if (!account) return { mismatch: `This receipt is in ${read.currency}, and no open account here is.` }
  const category = read.category_id !== null && snapshot.doc.categories.some((c) => c.id === read.category_id && c.archived_at === null) ? read.category_id : draft.category
  const note = [read.merchant, read.summary].filter((t) => t !== '').join(' · ').slice(0, NOTE_MAX)
  return { draft: { ...draft, mode: 'out', account: account.id, amount: amountText(read.total_minor, account.currency, locale), date: read.date ?? draft.date, arrives: read.date ?? draft.arrives, category, note, link: null } }
}

// Under Filled from: whose receipt it is and what to check before Save.
export function receiptFilledNote(read: ReceiptRead): string {
  const pages = read.truncated ? ' Only its first pages were read.' : ''
  const day = read.date === null ? ' It printed no day, so pick one.' : ''
  return `${read.merchant !== '' ? `${read.merchant}. ` : ''}Check the amount, day, account and category before you save.${day}${pages}`
}

// Budget tags go only on expenses and refunds (invariant 20).
export function takesCategory(draft: Pick<Draft, 'mode' | 'refund'>): boolean {
  const kind = rowKind(draft)
  return kind === 'expense' || kind === 'refund'
}

// The link still fits the draft by the check_link rule: kind, account and, for a transfer, where the other leg lands.
export function linkFits(snapshot: Snapshot, draft: Pick<Draft, 'mode' | 'refund' | 'account' | 'to' | 'link'>): boolean {
  if (draft.link === null || draft.account === null) return false
  const index = snapshotIndex(snapshot)
  const item = index.planItems.get(draft.link.plan_item_id)
  if (!item) return false
  const kind = rowKind(draft)
  const tx = { id: 'row', kind, account_id: draft.account, amount_minor: kind === 'expense' || kind === 'transfer' ? -1 : 1, transfer_id: kind === 'transfer' ? 'move' : null }
  const partner = kind === 'transfer' && draft.to !== null ? { id: 'in', kind, account_id: draft.to, amount_minor: 1, transfer_id: 'move' } : null
  return validateLink(tx, partner, item, snapshot.doc.accounts).length === 0
}

export interface CategoryOffer {
  // The chips: the 3 categories tagged most recently, or the month's budgeted ones when none was tagged yet.
  chips: Category[]
  // Every active category for 'All categories': the month's budgeted ones first, then the rest, so a new one can be found again.
  all: Category[]
  // The categories with an allowance in the month (invariant 20).
  budgeted: Category[]
  // The chosen category has no allowance in the month: still saved, it just counts against no budget (invariant 19).
  unbudgeted: boolean
}

export const CHIP_COUNT = 3

// The month's budget lines are the categories of allowances with an occurrence in the month of the transaction's date (invariant 20).
export function categoryOffer(snapshot: Snapshot, day: string, chosen: string | null): CategoryOffer {
  // While a typed day does not read yet, today's month stands in.
  const month = isDay(day) ? day : snapshot.as_of
  const [from, to] = [firstOfMonth(month), lastDayOfMonth(month)]
  const budgeted = new Set<string>()
  for (const item of snapshot.doc.plan_items) {
    if (item.kind !== 'allowance' || item.category_id === null || item.confidence === 'upside') continue
    const skipped = new Set(item.skip_periods)
    if (itemSchedule(item, null, from, to).some(([period]) => !skipped.has(period))) budgeted.add(item.category_id)
  }
  const lastUsed = new Map<string, string>()
  for (const t of snapshot.doc.transactions) {
    if (t.category_id === null) continue
    const seen = lastUsed.get(t.category_id)
    if (seen === undefined || t.posted_on > seen) lastUsed.set(t.category_id, t.posted_on)
  }
  const recent = (a: Category, b: Category) => {
    const [ua, ub] = [lastUsed.get(a.id) ?? '', lastUsed.get(b.id) ?? '']
    return ua !== ub ? (ua > ub ? -1 : 1) : a.name.localeCompare(b.name)
  }
  const active = snapshot.doc.categories.filter((c) => c.archived_at === null)
  const inBudget = active.filter((c) => budgeted.has(c.id)).sort(recent)
  const all = [...inBudget, ...active.filter((c) => !budgeted.has(c.id)).sort(recent)]
  const used = active.filter((c) => lastUsed.has(c.id)).sort(recent)
  const chips = (used.length > 0 ? used : inBudget).slice(0, CHIP_COUNT)
  const pick = chosen === null ? undefined : snapshot.doc.categories.find((c) => c.id === chosen)
  // A category picked from the full list, or kept from another month, stays in view.
  if (pick && !chips.some((c) => c.id === pick.id)) chips.push(pick)
  return { chips, all, budgeted: inBudget, unbudgeted: chosen !== null && !budgeted.has(chosen) }
}

export type NewCategory =
  // The add_category write Settings sends, on the id made when the field opened.
  | { edit: Edit }
  // A name in use offers that category, unless it is archived.
  | { error: string; existing: Category | null; use: Category | null }

// 'New category…' in the picker: the name read as Settings reads it, saved by Settings' write.
export function newCategory(snapshot: Snapshot, text: string, id: string, household: string): NewCategory {
  const read = readCategoryName(snapshot, text, null)
  if (!('error' in read)) return { edit: addCategory(id, read.name, household) }
  const existing = read.existing ?? null
  if (existing && existing.archived_at !== null) return { error: `${existing.name} is archived. Unarchive it in Settings to use it.`, existing, use: null }
  return { error: read.error, existing, use: existing }
}

// The one line under the category chips. A row that settles a plan item counts against no budget (spec §4), so it needs no category.
export function categoryNote(snapshot: Snapshot, draft: Pick<Draft, 'category' | 'link'>, offer: CategoryOffer, month: string): string | null {
  if (draft.link !== null) return 'A payment that settles a plan item counts against no budget, so a category is optional.'
  if (offer.budgeted.length === 0) return `No budgets in ${month}. A category tags the spending and counts against no budget.`
  if (offer.unbudgeted) return `No ${snapshot.doc.categories.find((c) => c.id === draft.category)?.name ?? ''} budget in ${month}. It saves with the tag and counts against no budget.`
  if (draft.category === null) return 'No category: this counts as extra spending on top of your budgets.'
  return null
}

export interface Settles {
  occurrence: Occurrence
  name: string
  // Already part of the draft (Record, or a tapped suggestion); otherwise only offered.
  chosen: boolean
}

// The occurrence the draft settles, or the one core's suggestion rule pairs it with (spec §6.6).
export function settles(snapshot: Snapshot, draft: Draft, amountMinor: number | null): Settles | null {
  const plan = expandPlan(snapshot)
  const index = snapshotIndex(snapshot)
  const named = (o: Occurrence | undefined, chosen: boolean): Settles | null => {
    const item = o ? index.planItems.get(o.plan_item_id) : undefined
    return o && item ? { occurrence: o, name: item.name, chosen } : null
  }
  if (draft.link) return named(plan.byId.get(occurrenceId(draft.link.plan_item_id, draft.link.period)), true)
  if (draft.account === null || amountMinor === null || amountMinor <= 0 || !isDay(draft.date)) return null
  const kind = rowKind(draft)
  const signed = kind === 'expense' || kind === 'transfer' ? -amountMinor : amountMinor
  const found = suggestFor(plan.occurrences, { id: 'draft', account_id: draft.account, kind, amount_minor: signed, posted_on: draft.date, plan_item_id: null }, draft.mode === 'move' ? draft.to : null)
  return found ? named(plan.byId.get(found.occurrence_id), false) : null
}

export interface DayChoice {
  value: string
  title: string
}

// Today and yesterday as chips; any other day is typed.
export function dayChoices(asOf: string): DayChoice[] {
  return [
    { value: asOf, title: 'Today' },
    { value: addDays(asOf, -1), title: 'Yesterday' },
  ]
}

// The incoming leg's day: the outgoing leg's, or up to 5 days later.
export function arrivalDays(date: string): string[] {
  return isDay(date) ? Array.from({ length: ARRIVAL_DAYS + 1 }, (_, i) => addDays(date, i)) : []
}

export interface Rate {
  from: string
  to: string
  // One unit of `from` in its minor units and what it bought of `to`, the stronger currency as the unit.
  unit_minor: number
  quote_minor: number
  // How far the real rate sits below the ECB rate of the day (a fee or spread), as a fraction; negative when above. null without a rate.
  below_ecb: number | null
}

// The rate a cross-currency move really got, from its two amounts, and how it compares with the day's ECB rate.
export function realRate(snapshot: Snapshot, sent: number, from: string, received: number, to: string): Rate | null {
  if (sent <= 0 || received <= 0 || from === to) return null
  const [fromUnit, toUnit] = [10 ** minorDigits(from), 10 ** minorDigits(to)]
  // received per sent, both in major units.
  const real = received / toUnit / (sent / fromUnit)
  const ecb = convert(fromUnit, from, to, toRatesPerEur(snapshot.rates))
  const below = ecb === null || ecb <= 0 ? null : 1 - real / (ecb / toUnit)
  return real >= 1
    ? { from, to, unit_minor: fromUnit, quote_minor: Math.round(real * toUnit), below_ecb: below }
    : { from: to, to: from, unit_minor: toUnit, quote_minor: Math.round(fromUnit / real), below_ecb: below }
}

// One save's ids (data/writes newBatchIds): the outgoing leg or the only row, the incoming leg, and a third row such as a loan payment's escrow.
export interface BatchIds {
  batch_id: string
  rows: readonly [string, string, string]
  transfer_id: string
}

export interface Reading {
  errors: Errors
  // null while any field has an error.
  input: PostBatchInput | null
  // The amounts as read, for the card figures and the rate line.
  amount_minor: number | null
  received_minor: number | null
}

function example(locale: string, currency: string): string {
  const digits = minorDigits(currency)
  return digits === 0 ? '1250' : amountText(125050 * 10 ** (digits - 2), currency, locale)
}

// Every field read at once, then one post_batch input core accepts; the ids are the sheet's, so a retry sends the same batch.
export function readDraft(snapshot: Snapshot, draft: Draft, options: { locale: string; ids: BatchIds; allow_over: boolean; escrow: Escrow | null }): Reading {
  const index = snapshotIndex(snapshot)
  const { locale, ids } = options
  const errors: Errors = {}
  const fail = (field: Field, message: string) => {
    errors[field] ??= message
    return null
  }
  const accountOf = (id: string | null) => (id === null ? undefined : index.accounts.get(id))
  const account = accountOf(draft.account)
  if (!account) fail('account', draft.mode === 'in' ? 'Pick the account it landed in.' : 'Pick the account it left.')
  const to = draft.mode === 'move' ? accountOf(draft.to) : undefined
  if (draft.mode === 'move' && !to) fail('to', 'Pick the account it went to.')
  else if (to && to.id === account?.id) fail('to', 'Pick a different account.')

  const amountOf = (field: Field, text: string, currency: string | undefined): number | null => {
    if (currency === undefined) return null
    const minor = parseAmount(text, locale, currency)
    if (minor === null) return fail(field, text.trim() === '' ? 'Enter an amount.' : `Enter an amount in figures, such as ${example(locale, currency)}.`)
    if (minor <= 0) return fail(field, 'Enter more than 0.')
    return minor
  }
  const amount = amountOf('amount', draft.amount, account?.currency)
  const across = to !== undefined && account !== undefined && to.currency !== account.currency
  const received = draft.mode !== 'move' ? amount : across ? amountOf('received', draft.received, to?.currency) : amount

  const asOf = snapshot.as_of
  if (!isDay(draft.date)) fail('date', 'Pick a date.')
  else if (draft.date > asOf) fail('date', 'Pick today or an earlier day.')
  else if (account && draft.date < account.opening_date) fail('date', `${account.name} opened on ${shortDay(account.opening_date, locale, true)}; pick that day or later.`)
  if (draft.mode === 'move' && isDay(draft.date)) {
    if (!isDay(draft.arrives) || draft.arrives < draft.date || draft.arrives > addDays(draft.date, ARRIVAL_DAYS)) fail('arrives', `Pick the day it left or up to ${ARRIVAL_DAYS} days later.`)
    else if (to && draft.arrives < to.opening_date) fail('arrives', `${to.name} opened on ${shortDay(to.opening_date, locale, true)}; pick that day or later.`)
  }
  const note = draft.note.trim()
  if (note.length > NOTE_MAX) fail('note', `Use at most ${NOTE_MAX} characters.`)
  if (draft.link !== null && !linkFits(snapshot, draft)) fail('link', 'This entry cannot settle that plan item.')
  const category = takesCategory(draft) && draft.category !== null && snapshot.doc.categories.some((c) => c.id === draft.category) ? draft.category : null

  const escrow = draft.mode === 'move' && to?.kind === 'loan' && draft.escrow ? options.escrow : null
  const escrowAmount = escrow ? amountOf('escrow', draft.escrow_amount, account?.currency) : null

  if (Object.keys(errors).length > 0 || !account || amount === null || received === null) return { errors, input: null, amount_minor: amount, received_minor: received }

  const linkName = draft.link ? (index.planItems.get(draft.link.plan_item_id)?.name ?? '') : ''
  const description = (note || linkName).slice(0, NOTE_MAX)
  const row = (fields: Pick<BatchTransaction, 'id' | 'account_id' | 'posted_on' | 'amount_minor' | 'kind'> & Partial<BatchTransaction>): BatchTransaction => ({
    category_id: null,
    description,
    transfer_id: null,
    plan_item_id: null,
    period: null,
    external_id: null,
    ...fields,
  })
  const link = draft.link ? { plan_item_id: draft.link.plan_item_id, period: draft.link.period } : {}
  const rows: BatchTransaction[] = []
  if (draft.mode === 'move' && to) {
    rows.push(row({ id: ids.rows[0], account_id: account.id, posted_on: draft.date, amount_minor: -amount, kind: 'transfer', transfer_id: ids.transfer_id, ...link }))
    rows.push(row({ id: ids.rows[1], account_id: to.id, posted_on: draft.arrives, amount_minor: received, kind: 'transfer', transfer_id: ids.transfer_id }))
    if (escrow && escrowAmount !== null) {
      rows.push(row({ id: ids.rows[2], account_id: escrow.account_id, posted_on: draft.date, amount_minor: -escrowAmount, kind: 'expense', description: escrow.name.slice(0, NOTE_MAX), plan_item_id: escrow.plan_item_id, period: escrow.period }))
    }
  } else {
    const kind = rowKind(draft)
    rows.push(row({ id: ids.rows[0], account_id: account.id, posted_on: draft.date, amount_minor: kind === 'expense' ? -amount : amount, kind, category_id: category, ...link }))
  }
  // usePostBatch checks it against core's postBatchInput before it leaves the device.
  const input: PostBatchInput = { batch_id: ids.batch_id, ...(draft.mode === 'move' && to?.kind === 'credit_card' ? { allow_over: options.allow_over } : {}), rows }
  return { errors, input, amount_minor: amount, received_minor: received }
}

export interface SaveFailure {
  kind: string
  code: string | null
  message: string
  detail: unknown
  technical: string | null
}

export interface Problem {
  // Where it shows: under the amount the server refused, or above Save.
  field: 'amount' | 'received' | 'form'
  text: string
  // An amount the text names, drawn through <Money> so the eye masks it.
  money: { minor: number; currency: string } | null
  technical: string | null
}

const detailOf = (detail: unknown): Record<string, unknown> => (typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {})

// The server's refusal in the sheet's words: over_remainder under the card amount with the remaining due, already_recorded naming the row.
export function problemOf(snapshot: Snapshot, failure: SaveFailure, input: PostBatchInput | null, locale: string): Problem {
  const index = snapshotIndex(snapshot)
  const detail = detailOf(failure.detail)
  const technical = failure.technical
  const rowOf = (id: unknown) => input?.rows.find((r) => r.id === id)
  if (failure.code === 'over_remainder') {
    const card = index.accounts.get(String(detail.account_id ?? ''))
    const leg = rowOf(detail.id)
    const out = input?.rows.find((r) => r.transfer_id !== null && r.transfer_id === leg?.transfer_id && r.amount_minor < 0)
    const across = out !== undefined && leg !== undefined && index.accounts.get(out.account_id)?.currency !== index.accounts.get(leg.account_id)?.currency
    const remaining = typeof detail.remaining_minor === 'number' ? detail.remaining_minor : null
    const said = remaining === null || !card ? 'This is more than the card’s remaining due.' : remaining > 0 ? 'This is more than the remaining due of {money}.' : remaining === 0 ? 'Nothing is left due on this statement.' : 'Nothing is left due on this statement; the card is {money} in credit.'
    return {
      field: across ? 'received' : 'amount',
      text: `${said} Tick Paid more than due to record it anyway.`,
      money: remaining !== null && remaining !== 0 && card ? { minor: Math.abs(remaining), currency: card.currency } : null,
      technical,
    }
  }
  if (failure.code === 'already_recorded') {
    const ids = Array.isArray(detail.ids) ? detail.ids : []
    const named = ids.map((id) => {
      const r = rowOf(id)
      const account = r ? index.accounts.get(r.account_id)?.name : undefined
      return r ? `${r.description ? `‘${r.description}’` : `the ${r.kind}`} on ${account ?? 'its account'} dated ${shortDay(r.posted_on, locale, true)}` : String(id)
    })
    return { field: 'form', text: `Already recorded: ${named.join('; ') || 'this row'}. Nothing was saved.`, money: null, technical }
  }
  if (failure.code === 'id_conflict' || failure.code === 'partial_replay') return { field: 'form', text: 'This entry was saved before with other details. Close the sheet and check the ledger; nothing new was saved.', money: null, technical }
  if (failure.code === 'unknown_account') return { field: 'form', text: 'An account in this entry is no longer in the household. Nothing was saved.', money: null, technical }
  if (failure.code === 'bad_input') return { field: 'form', text: 'This entry did not pass the checks, so nothing was saved.', money: null, technical }
  if (failure.kind === 'network') return { field: 'form', text: 'Waypoint could not reach the server. Try again; a retry never saves twice.', money: null, technical }
  const message = /[.!?]$/.test(failure.message) ? failure.message : `${failure.message}.`
  return { field: 'form', text: `${message} Nothing was saved.`, money: null, technical }
}

// The transaction month, for the budget note.
export const monthOf = monthKey
