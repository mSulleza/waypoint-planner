import {
  addDays,
  addMonths,
  firstOfMonth,
  horizonEnd,
  itemSchedule,
  monthKey,
  parseAmount,
  snapshotIndex,
  validatePlanItem,
  type Account,
  type PlanItem,
  type Snapshot,
  type Transaction,
} from '@waypoint/core'
import { ITEM_VALUES, type Edit, type ItemValues, type SplitPatch } from '../../data/edits'
import type { DataError } from '../../data/errors'
import { amountText, isDay } from '../../data/field-text'
import type { FieldErrors, FieldNames } from '../../ui/useZodForm'

// Spec §7 Settings and editors and §4 plan_items: one editor for every kind, with Save, Change from <month>, End and Delete. A change from a month never touches the months before it or their links.

export type ItemKind = PlanItem['kind']
export type Every = PlanItem['every']
export type Roll = PlanItem['roll']
export type Confidence = PlanItem['confidence']

// The three transfers spec §4 tells apart by their accounts: cash to cash, into a debt (paid from the debt's funded-from account), and extra for debts.
export type TransferRoute = 'between' | 'debt' | 'extra'

// The row's columns the editor sets, as useZodForm keys its errors.
export type Field = (typeof ITEM_VALUES)[number]

export interface ItemDraft {
  kind: ItemKind
  route: TransferRoute
  name: string
  // False while the name is the category's, so picking another category renames it.
  named: boolean
  from: string | null
  to: string | null
  category: string | null
  // As typed; parsed once, in readItem.
  amount: string
  every: Every
  starts_on: string
  // Empty for no end.
  ends_on: string
  // An installment's first and last billed months, YYYY-MM; stored as first-of-month dates.
  first_month: string
  last_month: string
  roll: Roll
  confidence: Confidence
  stops_with_income: boolean
}

export const KIND_ORDER: readonly ItemKind[] = ['income', 'bill', 'allowance', 'transfer', 'installment']

export const KIND_WORDS: Record<ItemKind, { title: string; detail: string }> = {
  income: { title: 'Income', detail: 'Pay, a reimbursement or money owed to you, into an account or onto a debt.' },
  bill: { title: 'Bill', detail: 'A dated cost, paid from an account or charged to a card.' },
  allowance: { title: 'Budget', detail: 'A monthly amount for one category, spent through the month.' },
  transfer: { title: 'Transfer', detail: 'Between your accounts, into a debt, or extra for debts.' },
  installment: { title: 'Installment', detail: 'An amount a card bills each month for a fixed term.' },
}

export const ROUTE_ORDER: readonly TransferRoute[] = ['between', 'debt', 'extra']

export const ROUTE_WORDS: Record<TransferRoute, { title: string; detail: string }> = {
  between: { title: 'Between my accounts', detail: 'From one cash account to another.' },
  debt: { title: 'Into a debt', detail: 'Paid from the account set for the debt.' },
  extra: { title: 'Extra for debts', detail: 'Shared in payoff order among the debts an account pays.' },
}

export const EVERY_WORDS: Record<Every, string> = { once: 'Once', week: 'Weekly', '2weeks': 'Every 2 weeks', month: 'Monthly', quarter: 'Every 3 months', year: 'Yearly' }

export const ROLL_WORDS: Record<Roll, string> = { none: 'Keep the date', following: 'Monday after', preceding: 'Friday before' }

export const CONFIDENCE_WORDS: Record<Confidence, { title: string; note: string }> = {
  committed: { title: 'Committed', note: 'Counted in every figure.' },
  estimated: { title: 'Estimated', note: 'Counted in every figure, with an Estimated chip.' },
  upside: { title: 'Upside', note: 'Left out of every figure. Compare shows what it would change.' },
}

// Income and transfers always stop with income and an installment never does, so only a bill or a budget asks.
export const INCOME_STOP_WORDS = {
  keeps: { title: 'Keeps going', note: 'Still paid in Months the money lasts if income stops.' },
  stops: { title: 'Stops', note: 'Left out of Months the money lasts if income stops, like tax on that income or a cost you would cut.' },
} as const

// How a schema sentence names another field.
export const FIELD_NAMES: FieldNames<Field> = { starts_on: 'the first date', ends_on: 'the last date', from_account_id: 'the from account' }

export function routeOf(item: Pick<PlanItem, 'from_account_id' | 'to_account_id'>): TransferRoute {
  return item.from_account_id === null ? 'debt' : item.to_account_id === null ? 'extra' : 'between'
}

const bySortOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const isDebt = (a: Account | undefined) => a !== undefined && a.kind !== 'cash'

// The accounts a field offers: open ones of the kinds the row may use, and the one already chosen even when it is archived.
type Side = 'from' | 'to'

function allowedKinds(draft: Pick<ItemDraft, 'kind' | 'route'>, side: Side): readonly Account['kind'][] {
  switch (draft.kind) {
    case 'income':
      return side === 'to' ? ['cash', 'credit_card', 'loan'] : []
    case 'bill':
    case 'allowance':
      return side === 'from' ? ['cash', 'credit_card'] : []
    case 'installment':
      return side === 'from' ? ['credit_card'] : []
    case 'transfer':
      if (draft.route === 'between') return ['cash']
      if (draft.route === 'debt') return side === 'to' ? ['credit_card', 'loan'] : []
      return side === 'from' ? ['cash'] : []
  }
}

export interface AccountGroup {
  title: string
  accounts: readonly Account[]
}

const GROUP_TITLES: Record<Account['kind'], string> = { cash: 'Cash accounts', credit_card: 'Cards', loan: 'Loans' }

export function accountGroups(snapshot: Snapshot, draft: Pick<ItemDraft, 'kind' | 'route' | 'from' | 'to'>, side: Side): AccountGroup[] {
  const kinds = allowedKinds(draft, side)
  const chosen = side === 'from' ? draft.from : draft.to
  // Cash to cash: the other side's account is not offered again.
  const other = draft.kind === 'transfer' && draft.route === 'between' ? (side === 'from' ? draft.to : draft.from) : null
  const fits = snapshot.doc.accounts.filter((a) => kinds.includes(a.kind) && a.id !== other && (a.archived_at === null || a.id === chosen)).sort(bySortOrder)
  return kinds.map((kind) => ({ title: GROUP_TITLES[kind], accounts: fits.filter((a) => a.kind === kind) })).filter((g) => g.accounts.length > 0)
}

const firstFit = (snapshot: Snapshot, draft: ItemDraft, side: Side, skip: string | null = null) => accountGroups(snapshot, draft, side).flatMap((g) => g.accounts).find((a) => a.id !== skip)?.id ?? null

// Keeps each chosen account the row's kind still allows, and fills an empty required one with the first that fits.
function fitAccounts(snapshot: Snapshot, draft: ItemDraft): ItemDraft {
  const accounts = snapshotIndex(snapshot).accounts
  const keep = (side: Side) => {
    const id = side === 'from' ? draft.from : draft.to
    const kind = id === null ? undefined : accounts.get(id)?.kind
    return kind !== undefined && allowedKinds(draft, side).includes(kind) ? id : null
  }
  const needs = (side: Side) => allowedKinds(draft, side).length > 0
  let from = needs('from') ? keep('from') : null
  let to = needs('to') ? keep('to') : null
  if (needs('from') && from === null) from = firstFit(snapshot, { ...draft, to: null }, 'from')
  if (needs('to') && (to === null || to === from)) to = firstFit(snapshot, { ...draft, from }, 'to', from)
  return { ...draft, from, to }
}

const categoriesOf = (snapshot: Snapshot) => snapshot.doc.categories.filter((c) => c.archived_at === null)

export function categoryChoices(snapshot: Snapshot, chosen: string | null) {
  return snapshot.doc.categories.filter((c) => c.archived_at === null || c.id === chosen).sort((a, b) => a.name.localeCompare(b.name))
}

// The name follows the category until the person types one.
export function pickCategory(snapshot: Snapshot, draft: ItemDraft, categoryId: string): ItemDraft {
  const name = snapshot.doc.categories.find((c) => c.id === categoryId)?.name
  return { ...draft, category: categoryId, name: draft.named || name === undefined ? draft.name : name }
}

// A budget is a monthly amount (spec §4), or once for a one-off credit, never every 3 months; an item saved with another repeat keeps it on offer.
export function everyChoices(kind: ItemKind, allowed: readonly Every[], current: Every): Every[] {
  return kind === 'allowance' ? allowed.filter((e) => e === 'month' || e === 'once' || e === current) : [...allowed]
}

export function withKind(snapshot: Snapshot, draft: ItemDraft, kind: ItemKind): ItemDraft {
  const fitted = fitAccounts(snapshot, { ...draft, kind })
  if (kind !== 'allowance') return fitted
  const next = fitted.every === 'month' || fitted.every === 'once' ? fitted : { ...fitted, every: 'month' as const }
  const category = next.category ?? categoriesOf(snapshot)[0]?.id ?? null
  return category === null ? next : pickCategory(snapshot, next, category)
}

export function withRoute(snapshot: Snapshot, draft: ItemDraft, route: TransferRoute): ItemDraft {
  return fitAccounts(snapshot, { ...draft, route })
}

// Picking one side of a cash-to-cash transfer frees the other when it was the same account.
export function pickAccount(snapshot: Snapshot, draft: ItemDraft, side: Side, id: string): ItemDraft {
  const next = side === 'from' ? { ...draft, from: id } : { ...draft, to: id }
  if (next.from !== null && next.from === next.to) return side === 'from' ? { ...next, to: firstFit(snapshot, next, 'to', id) } : { ...next, from: firstFit(snapshot, next, 'from', id) }
  return next
}

// The account the amount is counted in: the receiving one for income and a payment into a debt, else the paying one (core's occurrences).
export function countedAccount(draft: Pick<ItemDraft, 'kind' | 'route' | 'from' | 'to'>): string | null {
  return draft.kind === 'income' || (draft.kind === 'transfer' && draft.route === 'debt') ? draft.to : draft.from
}

export function amountCurrency(snapshot: Snapshot, draft: Pick<ItemDraft, 'kind' | 'route' | 'from' | 'to'>): string {
  const id = countedAccount(draft)
  return (id === null ? undefined : snapshotIndex(snapshot).accounts.get(id)?.currency) ?? snapshot.doc.household.base_currency
}

const nextMonth = (day: string, by = 1) => monthKey(addMonths(firstOfMonth(day), by))

export function draftOf(snapshot: Snapshot, item: PlanItem, locale: string): ItemDraft {
  const draft: ItemDraft = {
    kind: item.kind,
    route: routeOf(item),
    name: item.name,
    named: true,
    from: item.from_account_id,
    to: item.to_account_id,
    category: item.category_id,
    amount: '',
    every: item.every,
    starts_on: item.starts_on,
    ends_on: item.ends_on ?? '',
    first_month: monthKey(item.starts_on),
    last_month: monthKey(item.ends_on ?? item.starts_on),
    roll: item.roll,
    confidence: item.confidence,
    stops_with_income: item.stops_with_income,
  }
  return { ...draft, amount: amountText(item.amount_minor, amountCurrency(snapshot, draft), locale) }
}

export interface NewItemParams {
  kind?: string
  category?: string
}

// A new item from the plan's Add an item, or Settings' Add a monthly budget with ?kind=allowance&category=<id>.
export function newDraft(snapshot: Snapshot, params: NewItemParams): ItemDraft {
  const asOf = snapshot.as_of
  const kind = KIND_ORDER.find((k) => k === params.kind) ?? 'income'
  const category = categoriesOf(snapshot).find((c) => c.id === params.category)?.id ?? null
  const blank: ItemDraft = {
    kind,
    route: 'between',
    name: '',
    named: false,
    from: null,
    to: null,
    category,
    amount: '',
    every: 'month',
    starts_on: asOf,
    ends_on: '',
    first_month: nextMonth(asOf),
    last_month: nextMonth(asOf, 12),
    roll: 'none',
    confidence: 'committed',
    stops_with_income: false,
  }
  return withKind(snapshot, blank, kind)
}

export type Opened = { kind: 'new'; draft: ItemDraft } | { kind: 'edit'; item: PlanItem; draft: ItemDraft } | { kind: 'missing' }

export function openItem(snapshot: Snapshot, id: string, newId: string, params: NewItemParams, locale: string): Opened {
  const item = snapshotIndex(snapshot).planItems.get(id)
  if (item) return { kind: 'edit', item, draft: draftOf(snapshot, item, locale) }
  return id === newId ? { kind: 'new', draft: newDraft(snapshot, params) } : { kind: 'missing' }
}

// Every transaction linked to the item, oldest period first.
export function linksOf(snapshot: Snapshot, itemId: string): Transaction[] {
  return snapshot.doc.transactions.filter((t) => t.plan_item_id === itemId).sort((a, b) => ((a.period ?? '') < (b.period ?? '') ? -1 : (a.period ?? '') > (b.period ?? '') ? 1 : 0))
}

export interface ReadContext {
  id: string
  locale: string
  // The row as saved, for its skipped periods; null for a new item.
  loaded: PlanItem | null
}

// The draft as planItemRow's input: the amount parsed once, a date only when it reads as one, and the accounts the kind uses.
export function readItem(snapshot: Snapshot, draft: ItemDraft, { id, locale, loaded }: ReadContext): { input: unknown; errors: FieldErrors<Field> } {
  const errors: FieldErrors<Field> = {}
  if (draft.name.trim() === '') errors.name = 'Type a name.'
  const currency = amountCurrency(snapshot, draft)
  const typed = draft.amount.trim()
  const amount = typed === '' ? null : parseAmount(typed, locale, currency)
  if (typed === '') errors.amount_minor = 'Type an amount.'
  else if (amount === null) errors.amount_minor = `Type an amount such as ${amountText(1250, currency, locale)}.`

  const needs = (side: Side) => allowedKinds(draft, side).length > 0
  const from = needs('from') ? draft.from : null
  const to = needs('to') ? draft.to : null
  const pick = draft.kind === 'transfer' && draft.route === 'debt' ? 'Pick a debt.' : 'Pick an account.'
  if (needs('from') && from === null) errors.from_account_id = pick
  if (needs('to') && to === null) errors.to_account_id = pick
  const category = draft.kind === 'allowance' ? draft.category : null
  if (draft.kind === 'allowance' && category === null) errors.category_id = 'Pick a category.'

  const installment = draft.kind === 'installment'
  const starts = installment ? `${draft.first_month}-01` : draft.starts_on.trim()
  const ends = installment ? `${draft.last_month}-01` : draft.ends_on.trim()
  if (!installment && !isDay(starts)) errors.starts_on = 'Pick a date.'
  if (!installment && ends !== '' && !isDay(ends)) errors.ends_on = 'Pick a date, or leave it empty for no end.'
  return {
    input: {
      id,
      kind: draft.kind,
      name: draft.name.trim(),
      from_account_id: from,
      to_account_id: to,
      category_id: category,
      amount_minor: amount ?? 0,
      every: installment ? 'month' : draft.every,
      starts_on: starts,
      ends_on: ends === '' ? null : ends,
      roll: draft.roll,
      confidence: draft.confidence,
      stops_with_income: (draft.kind === 'bill' || draft.kind === 'allowance') && draft.stops_with_income,
      skip_periods: loaded?.skip_periods ?? [],
    },
    errors,
  }
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`

// The routing check_plan_item runs at commit (core validatePlanItem), beside the account field it is about.
export function routeErrors(snapshot: Snapshot, row: PlanItem): FieldErrors<Field> {
  const problems = validatePlanItem(row, snapshot.doc.accounts)
  if (problems.length === 0) return {}
  const field: Field = row.kind === 'income' || (row.kind === 'transfer' && row.from_account_id === null) ? 'to_account_id' : 'from_account_id'
  return { [field]: problems.map(sentence).join(' ') }
}

// The debt's funded-from account: a transfer into the debt is paid from it, and follows it when Settings changes it.
export function paidFrom(snapshot: Snapshot, debtId: string | null): Account | null {
  const index = snapshotIndex(snapshot)
  const debt = debtId === null ? undefined : index.accounts.get(debtId)
  if (!isDebt(debt) || debt.funded_from_account_id === null) return null
  return index.accounts.get(debt.funded_from_account_id) ?? null
}

// The open debts a cash account pays, which extra for debts is shared among.
export function debtsPaidBy(snapshot: Snapshot, cashId: string | null): Account[] {
  return snapshot.doc.accounts.filter((a) => a.kind !== 'cash' && a.archived_at === null && a.funded_from_account_id === cashId).sort(bySortOrder)
}

export const monthCount = (first: string, last: string) => (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5, 7)) - Number(first.slice(5, 7)) + 1

export const monthName = (month: string, locale: string) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`))

const dayName = (day: string, locale: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))

// A period as a person names it: its month, or its date for a weekly item.
export function periodName(item: Pick<PlanItem, 'every'>, period: string, locale: string): string {
  return item.every === 'week' || item.every === '2weeks' ? dayName(period, locale) : monthName(period, locale)
}

// The installment's first billed month moves its last with it, so the term stays.
export function moveFirstMonth(draft: ItemDraft, month: string): ItemDraft {
  const term = monthCount(draft.first_month, draft.last_month)
  const last = monthKey(addMonths(`${month}-01`, Math.max(term, 1) - 1))
  return { ...draft, first_month: month, last_month: last }
}

export interface MonthRange {
  min: string
  max: string
}

// The months a change or an end can start from: this month on, after the item's first month, through the month of its last date (or the projection's end).
export function fromMonths(item: PlanItem, asOf: string): MonthRange | null {
  if (item.every === 'once') return null
  const now = monthKey(asOf)
  const after = nextMonth(item.starts_on)
  const min = now > after ? now : after
  const dates = itemSchedule(item, null, `${min}-01`, horizonEnd(asOf))
  const last = dates.at(-1)
  if (!last) return null
  const max = monthKey(last[1])
  return min <= max ? { min, max } : null
}

export const clampMonth = (month: string, range: MonthRange) => (month < range.min ? range.min : month > range.max ? range.max : month)

// Next month when it is in range: a change made now starts with the month ahead.
export const defaultFromMonth = (range: MonthRange, asOf: string) => clampMonth(nextMonth(asOf), range)

const values = (row: PlanItem): ItemValues => Object.fromEntries(ITEM_VALUES.map((c) => [c, row[c]])) as ItemValues

// The columns that differ between the saved row and the edited one.
export function changedValues(loaded: PlanItem, row: PlanItem): Partial<ItemValues> {
  return Object.fromEntries(ITEM_VALUES.filter((c) => loaded[c] !== row[c]).map((c) => [c, row[c]])) as Partial<ItemValues>
}

// A linked or skipped period the row no longer has an occurrence for; such a link would settle nothing.
export function orphanPeriod(row: PlanItem, periods: readonly string[]): string | null {
  if (periods.length === 0) return null
  const sorted = [...periods].sort()
  const first = sorted[0] as string
  const last = sorted.at(-1) as string
  const from = first < row.starts_on ? first : row.starts_on
  const kept = new Set(itemSchedule(row, null, from, `${monthKey(last)}-31`).map(([period]) => period))
  return sorted.find((p) => !kept.has(p)) ?? null
}

export type Plan<T> = { ok: true; value: T } | { ok: false; reason: string }

const names = (snapshot: Snapshot) => {
  const index = snapshotIndex(snapshot)
  return (id: string | null) => (id === null ? '' : (index.accounts.get(id)?.name ?? id))
}

// Save on a saved item: every column the person changed, guarded on the row as loaded. With links, its accounts stay; a new account goes through Change from.
export function savePlan(snapshot: Snapshot, loaded: PlanItem, row: PlanItem, links: readonly Transaction[], locale: string): Plan<Edit | null> {
  const after = changedValues(loaded, row)
  if (Object.keys(after).length === 0) return { ok: true, value: null }
  if (links.length > 0 && ('from_account_id' in after || 'to_account_id' in after)) {
    const name = names(snapshot)
    const kept = [loaded.from_account_id, loaded.to_account_id].filter((id) => id !== null).map(name).join(' and ')
    return { ok: false, reason: `Payments are linked to it, so Save keeps ${kept}. Change from a month below to use the new account from then on.` }
  }
  const orphan = orphanPeriod(row, [...links.flatMap((t) => (t.period === null ? [] : [t.period])), ...loaded.skip_periods])
  if (orphan !== null) return { ok: false, reason: `${periodName(loaded, orphan, locale)} is linked or skipped, and this change leaves it no date. Change from a month below instead, or unlink it first.` }
  return { ok: true, value: { kind: 'edit_item', id: loaded.id, before: values(loaded), after } }
}

const SPLIT_KEYS = ['amount_minor', 'name', 'from_account_id', 'to_account_id', 'category_id', 'every', 'roll', 'confidence', 'stops_with_income', 'ends_on'] as const

// Change from <month>: split_plan_item ends the item before the month and starts a copy with what changed, moving that month's links and later ones to it.
export function splitPlan(snapshot: Snapshot, loaded: PlanItem, row: PlanItem, links: readonly Transaction[], month: string, locale: string): Plan<{ from: string; patch: SplitPatch }> {
  const patch: SplitPatch = {}
  for (const key of SPLIT_KEYS) if (loaded[key] !== row[key]) Object.assign(patch, { [key]: row[key] })
  if (row.starts_on !== loaded.starts_on) {
    const dayOnly = (loaded.every === 'month' || loaded.every === 'quarter' || loaded.every === 'year') && loaded.kind !== 'installment' && row.starts_on.slice(0, 7) === loaded.starts_on.slice(0, 7)
    if (!dayOnly) return { ok: false, reason: `Change from keeps the ${loaded.kind === 'installment' ? 'first billed month' : 'first date'}; Save changes it.` }
    patch.day = Number(row.starts_on.slice(8, 10))
  }
  if (Object.keys(patch).length === 0) return { ok: false, reason: `Change a field above first; the change starts in ${monthName(month, locale)}.` }
  const from = `${month}-01`
  const start = itemSchedule(loaded, null, from, horizonEnd(snapshot.as_of))[0]?.[1]
  if (start !== undefined && row.ends_on !== null && row.ends_on < start) return { ok: false, reason: `The last date is before ${dayName(start, locale)}, when the change would start.` }
  const moving = 'from_account_id' in patch || 'to_account_id' in patch ? links.find((t) => t.period !== null && t.period >= from) : undefined
  if (moving) {
    const name = names(snapshot)
    return { ok: false, reason: `${periodName(loaded, moving.period ?? from, locale)} has a payment linked on ${name(moving.account_id)}. Change from a later month, or unlink it first.` }
  }
  return { ok: true, value: { from, patch } }
}

// End before <month>: the item's last occurrence is the one before that month; months before it keep their links. `last` is the latest month it can end before.
export function endPlan(loaded: PlanItem, links: readonly Transaction[], month: string, last: string, locale: string): Plan<Edit> {
  const from = `${month}-01`
  const ends = loaded.kind === 'installment' ? addMonths(from, -1) : addDays(from, -1)
  if (loaded.ends_on !== null && loaded.ends_on <= ends) return { ok: false, reason: `It already ends on ${dayName(loaded.ends_on, locale)}.` }
  const linked = links.find((t) => t.period !== null && t.period >= from)
  if (linked?.period) {
    const named = periodName(loaded, linked.period, locale)
    return { ok: false, reason: month < last ? `${named} has a linked payment. Pick a later month, or unlink it first.` : `${named} has a linked payment, so it stays in the plan.` }
  }
  return { ok: true, value: { kind: 'edit_item', id: loaded.id, before: values(loaded), after: { ends_on: ends } } }
}

export interface Problem {
  // The field a refusal is about, shown beside it; null shows it by the buttons.
  field: Field | null
  text: string
}

// A refusal from the server in the editor's words: check_plan_item beside the accounts (its routing), the others by the buttons.
export function itemProblem(error: DataError, row: Pick<PlanItem, 'kind' | 'every' | 'from_account_id'>, locale: string): Problem {
  const detail = typeof error.detail === 'string' ? error.detail : ''
  const accounts: Field = row.kind === 'income' || (row.kind === 'transfer' && row.from_account_id === null) ? 'to_account_id' : 'from_account_id'
  if (error.code === 'check_plan_item') {
    if (detail.startsWith('its linked transactions')) return { field: accounts, text: 'Payments are linked to it, so its accounts stay. Change from a month below to use another account from then on.' }
    return { field: accounts, text: sentence(detail) }
  }
  if (error.code === 'check_link') return { field: accounts, text: 'A payment linked from that month on does not fit the new account. Change from a later month, or unlink it first.' }
  if (error.code === 'bad_split') {
    const orphan = /occurrence (\d{4}-\d{2}-\d{2}) is linked or skipped/.exec(detail)?.[1]
    if (orphan) return { field: null, text: `${periodName(row, orphan, locale)} is linked or skipped, and the changed item has no date there. Unlink or unskip it first.` }
    return { field: null, text: sentence(detail) }
  }
  return { field: null, text: error.message }
}
