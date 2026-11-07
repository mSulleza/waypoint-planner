import {
  alerts as coreAlerts,
  budgetRows,
  cardsOf,
  expandPlan,
  monthFigures,
  monthKey,
  moneyPart,
  reviewList,
  snapshotIndex,
  textPart,
  validateLink,
  WARNING_WORDS,
  type Alert,
  type CardStatement,
  type CategoryBudget,
  type Copy,
  type Flow,
  type FxBreakeven,
  type Occurrence,
  type ReviewItem,
  type Snapshot,
  type Transaction,
  type TransactionKind,
  type Walk,
} from '@waypoint/core'
import type { Edit } from '../../data/edits'
import { estimateLabel } from '../debts/debts.model'
import { RECORD_PAYMENT, RECORD_TRANSFER, routeLink, type TodayLink } from '../today/today.model'
import { FLAG_WORDS } from './breakdown.model'
import { monthKind, type MonthKind } from './months.model'

// Spec §7 Months > To-do: alerts first, then only rows a person can act on, settled ones kept so a mark can be undone (invariant 174).

export const TODO_SECTIONS = ['cards', 'bills', 'income', 'transfers', 'budgets'] as const
export type TodoSection = (typeof TODO_SECTIONS)[number]

export const SECTION_TITLES: Record<TodoSection, string> = { cards: 'Cards', bills: 'Bills', income: 'Income', transfers: 'Transfers', budgets: 'Budgets' }

// Skip reads differently on a budget, where it means no more spending this month, and on income, where the money is not coming.
export const DONE_FOR_MONTH = 'Done for this month'
export const WONT_COME = 'Won’t come'

// A state as a word, with the status tone that colours its icon; null tones read in text-2.
export interface RowWord {
  text: string
  tone: 'negative' | 'caution' | 'positive' | null
  // A day the screen writes after the text: 'Late, expected 1 Nov'.
  on?: string
}

export interface LinkedRow {
  row_id: string
  transfer_id: string | null
  account_id: string
  // Where the other leg of a transfer landed.
  partner_account_id: string | null
  posted_on: string
  // Positive, in the row's account currency.
  amount_minor: number
  currency: string
  description: string | null
  kind: TransactionKind
  unlink: Edit
  remove: Edit
}

export interface ItemRow {
  type: 'item'
  // The occurrence id.
  id: string
  section: Exclude<TodoSection, 'cards'>
  flow: Flow
  plan_item_id: string
  period: string
  date: string
  // Late income counts on this day, the first of next month; null otherwise.
  carried_to: string | null
  // The paying account; the receiving one for income.
  account_id: string
  // A cash-to-cash transfer's receiving account.
  to_account_id: string | null
  currency: string
  amount_minor: number
  linked_minor: number
  open_minor: number
  // Settled, skipped, on a statement or a lapsed budget: nothing left to do, though a mark can still be undone.
  done: boolean
  words: readonly RowWord[]
  links: readonly LinkedRow[]
  // Rows the suggestion rule pairs with it (spec §6.6), which Link lists first.
  suggested: number
  // A budget's category this month: what it allows and what was spent against it, in the netting's currency.
  budget: { currency: string; budget_minor: number; spent_minor: number } | null
  // The one button on the row; the rest sit in its sheet.
  primary: 'record' | 'link' | 'skip' | null
  // The Add sheet linked to this occurrence; null when the sheet cannot take it.
  record: TodayLink | null
  can_link: boolean
  skip: { label: string; edit: Edit } | null
  unskip: { label: string; edit: Edit } | null
}

export interface CardRow {
  type: 'card'
  id: string
  section: 'cards'
  account_id: string
  currency: string
  statement_id: string
  cut_date: string
  due_date: string
  // A cut with no statement entered asks for it; otherwise the cycle's payment (spec §6.4), read from the walk.
  task: 'enter_statement' | 'pay'
  left_minor: number | null
  done: boolean
  // 'Pay by 16 Oct · statement of 20 Sep'.
  detail: Copy
  // Installments and payments planned into the card that fold into this one payment.
  notes: readonly Copy[]
  words: readonly RowWord[]
  // The Statement sheet's words for each part that differs, such as 'Installments differ from your plan'.
  warnings: readonly string[]
  primary: { label: string; link: TodayLink } | null
  // Debt detail, with the statement, installments and the next cycles.
  detail_link: TodayLink
}

// An engine top-up: a transfer the person makes at their bank, not a plan item, so it takes no link, skip or edit (invariant 108).
export interface TopUpRow {
  type: 'top_up'
  // The leg leaving the source.
  id: string
  section: 'transfers'
  date: string
  from_account_id: string
  to_account_id: string
  // 'Top up Pesos from Main'.
  title: Copy
  // 'Brings Pesos up to its floor', or 'Pesos stays under its floor: this is all Main can spare', after the day.
  detail: Copy
  // What leaves the source, in its currency.
  currency: string
  sent_minor: number
  // What lands, when the currencies differ; null otherwise.
  landed: { currency: string; minor: number } | null
  // Recording it changes the walk, which drops or resizes it, so it is never done.
  done: false
  words: readonly RowWord[]
  primary: { label: string; link: TodayLink }
}

export type TodoRow = ItemRow | CardRow | TopUpRow

export interface TodoAlert {
  alert: Alert
  tone: 'negative' | 'caution' | 'neutral'
  // A review item of a row listed below opens that row; anything else opens its route.
  open: { kind: 'row'; row_id: string } | { kind: 'link'; link: TodayLink }
}

export interface TodoGroup {
  section: TodoSection
  rows: readonly TodoRow[]
  // Rows still to settle.
  open: number
}

export interface TodoModel {
  month: string
  kind: MonthKind
  alerts: readonly TodoAlert[]
  groups: readonly TodoGroup[]
  // Nothing listed: 'Nothing to settle in <month>'. The first month the plan is checked, when this one comes before it.
  empty: { tracked_from: string | null } | null
}

export interface TodoInputs {
  snapshot: Snapshot
  // A full walk with the card and loan modules (core runEngine).
  walk: Walk
  // null only in a one-currency household.
  breakeven: FxBreakeven | null
  month: string
}

const SECTION_OF: Partial<Record<Flow, ItemRow['section']>> = { bill: 'bills', card_bill: 'bills', income: 'income', draw: 'income', transfer: 'transfers', allowance: 'budgets' }
const LINKABLE = new Set<Flow>(['bill', 'card_bill', 'income', 'draw', 'transfer'])
const OPEN = new Set(['due', 'overdue', 'late', 'unconfirmed', 'partly_settled'])
const TONES = { critical: 'negative', warning: 'caution', info: 'neutral' } as const

function wordsOf(o: Occurrence, estimated: boolean, suggested: number): RowWord[] {
  const words: RowWord[] = []
  if (o.state === 'overdue') words.push({ text: 'Overdue', tone: 'negative' })
  // A possible match holds late income out of the projection, so it has no day to name.
  else if (o.state === 'late') words.push(o.carried_to && suggested === 0 ? { text: 'Late, expected', tone: 'caution', on: o.carried_to } : { text: 'Late', tone: 'caution' })
  else if (o.state === 'unconfirmed') words.push({ text: 'Unconfirmed', tone: 'caution' })
  else if (o.state === 'partly_settled') words.push({ text: 'Partly settled', tone: null })
  else if (o.state === 'settled' && o.skipped) words.push(o.flow === 'allowance' ? { text: DONE_FOR_MONTH, tone: 'positive' } : { text: SECTION_OF[o.flow] === 'income' ? WONT_COME : 'Skipped', tone: null })
  else if (o.state === 'settled') words.push({ text: 'Settled', tone: 'positive' })
  else if (o.state === 'on_statement') words.push({ text: 'On statement', tone: null })
  else if (o.state === 'lapsed') words.push({ text: 'Lapsed', tone: null })
  if (estimated && !(o.state === 'settled' || o.state === 'on_statement')) words.push({ text: 'Estimated', tone: null })
  if (suggested > 0) words.push({ text: suggested === 1 ? 'Possible match' : `${suggested} possible matches`, tone: null })
  return words
}

const recordLink = (o: Occurrence): TodayLink => ({ pathname: '/add', params: { plan_item_id: o.plan_item_id, period: o.period } })

function itemRow(snapshot: Snapshot, o: Occurrence, suggested: number, budgets: ReadonlyMap<string, CategoryBudget>): ItemRow | null {
  const section = SECTION_OF[o.flow]
  if (!section || o.state === null) return null
  const index = snapshotIndex(snapshot)
  const item = index.planItems.get(o.plan_item_id)
  const account = index.accounts.get(o.account_id)
  if (!item || !account) return null
  const open = OPEN.has(o.state)
  const allowance = o.flow === 'allowance'
  // The Add sheet records In and Out on cash and cards only, so a planned draw onto a loan is linked by hand.
  const recordable = LINKABLE.has(o.flow) && account.kind !== 'loan'
  const links = o.links.map((t): LinkedRow => {
    const partner = t.transfer_id === null ? undefined : index.transfers.get(t.transfer_id)?.find((leg) => leg.id !== t.id)
    return {
      row_id: t.id,
      transfer_id: t.transfer_id,
      account_id: t.account_id,
      partner_account_id: partner?.account_id ?? null,
      posted_on: t.posted_on,
      amount_minor: Math.abs(t.amount_minor),
      currency: index.accounts.get(t.account_id)?.currency ?? account.currency,
      description: t.description,
      kind: t.kind,
      unlink: { kind: 'unlink', row_id: t.id, plan_item_id: o.plan_item_id, period: o.period },
      remove: { kind: 'delete', row_id: t.id, transfer_id: t.transfer_id },
    }
  })
  const skips = item.skip_periods
  const income = section === 'income'
  const primary = !open ? null : allowance ? 'skip' : suggested > 0 ? 'link' : recordable ? 'record' : 'link'
  // Once done for the month the budget no longer counts, so its figures would read as zero.
  const budget = allowance && open && o.category_id !== null ? budgets.get(o.category_id) : undefined
  return {
    type: 'item',
    id: o.id,
    section,
    flow: o.flow,
    plan_item_id: o.plan_item_id,
    period: o.period,
    date: o.date,
    carried_to: o.carried_to,
    account_id: o.account_id,
    to_account_id: o.to_account_id,
    currency: account.currency,
    amount_minor: o.amount_minor,
    linked_minor: o.linked_minor,
    open_minor: o.open_minor,
    done: !open,
    words: wordsOf(o, item.confidence === 'estimated', suggested),
    links,
    suggested,
    budget: budget ? { currency: budget.currency, budget_minor: budget.budget_minor, spent_minor: budget.spent_minor } : null,
    primary,
    record: open && recordable ? recordLink(o) : null,
    can_link: open && LINKABLE.has(o.flow),
    skip: open && !o.skipped ? { label: allowance ? DONE_FOR_MONTH : income ? (o.linked_minor > 0 ? 'The rest won’t come' : WONT_COME) : o.linked_minor > 0 ? 'Skip the rest' : 'Skip', edit: { kind: 'skips', plan_item_id: o.plan_item_id, before: skips, after: [...skips, o.period] } } : null,
    unskip: o.skipped ? { label: allowance || income ? 'Undo' : 'Undo skip', edit: { kind: 'skips', plan_item_id: o.plan_item_id, before: skips, after: skips.filter((p) => p !== o.period) } } : null,
  }
}

// The one cycle of a card whose payment leaves cash in the month, by its pay day; the earliest when two do (an overdue one paid today).
function cycleIn(statements: readonly CardStatement[], month: string): CardStatement | undefined {
  return statements.find((s) => s.pay_on !== null && s.payment !== null && monthKey(s.pay_on) === month)
}

function cardRow(snapshot: Snapshot, cardId: string, s: CardStatement, review: readonly ReviewItem[]): CardRow {
  const asOf = snapshot.as_of
  const card = snapshotIndex(snapshot).accounts.get(cardId)
  const currency = card?.currency ?? snapshot.doc.household.base_currency
  const base = { type: 'card' as const, id: `card:${cardId}`, section: 'cards' as const, account_id: cardId, currency, statement_id: s.id, cut_date: s.cut_date, due_date: s.due_date, detail_link: { pathname: '/debts/[accountId]', params: { accountId: cardId } } as TodayLink }
  const warnings = review.filter((r) => r.kind === 'statement_warning' && r.statement_id === s.id).map((r) => WARNING_WORDS[r.id.slice(r.id.lastIndexOf(':') + 1) as keyof typeof WARNING_WORDS])
  if (s.provisional) {
    return {
      ...base,
      task: 'enter_statement',
      left_minor: null,
      done: false,
      detail: [textPart('Enter the statement cut on '), { date: s.cut_date }],
      notes: [],
      words: [],
      warnings,
      primary: { label: 'Enter statement', link: { pathname: '/statement', params: { account: cardId } } },
    }
  }
  const pay = s.payment
  const left = pay?.left_to_pay_minor ?? 0
  const state = pay?.state ?? 'nothing_due'
  const cut = s.cut_date > asOf
  // No statement yet: the amount is the preset's estimate from the opening balance.
  const estimate = estimateLabel(snapshot, s)
  const words: RowWord[] = []
  if (state === 'to_pay' && s.due_date < asOf) words.push({ text: 'Overdue', tone: 'negative' })
  if (state === 'paid') words.push({ text: 'Paid', tone: 'positive' })
  if (state === 'nothing_due') words.push({ text: 'Nothing due', tone: null })
  const notes: Copy[] = []
  if (s.installments_minor > 0) notes.push([textPart('Includes '), moneyPart(s.installments_minor, currency), textPart(' of installments')])
  const planned = (pay?.items_minor ?? 0) + (pay?.extra_minor ?? 0)
  if (planned > 0) notes.push([textPart('Includes '), moneyPart(planned, currency), textPart(' of extra payments from your plan')])
  return {
    ...base,
    task: 'pay',
    left_minor: left,
    done: state !== 'to_pay',
    detail: estimate && state === 'to_pay' ? [textPart(`${estimate} · pay by `), { date: s.due_date }] : [textPart(state === 'to_pay' ? 'Pay by ' : 'Due '), { date: s.due_date }, textPart(cut ? ' · statement on ' : ' · statement of '), { date: s.cut_date }],
    notes,
    words,
    warnings,
    // A cycle that has not cut yet is paid once it has a statement.
    primary: state === 'to_pay' && !cut ? { label: RECORD_PAYMENT, link: { pathname: '/add', params: { mode: 'move', to: cardId } } } : null,
  }
}

// The month's top-ups from the walk, one row per pair, with the walk's flags as Breakdown words them.
function topUpRows(snapshot: Snapshot, walk: Walk, month: string): TopUpRow[] {
  const index = snapshotIndex(snapshot)
  const byId = new Map(walk.lines.map((l) => [l.id, l]))
  const currencyOf = (id: string) => index.accounts.get(id)?.currency ?? snapshot.doc.household.base_currency
  return walk.lines.flatMap((out): TopUpRow[] => {
    const into = out.pair_id === null ? undefined : byId.get(out.pair_id)
    if (out.source !== 'top_up' || out.amount_minor >= 0 || !into || monthKey(out.date) !== month) return []
    const [from, to] = [out.account_id, into.account_id]
    const figures = monthFigures(walk, to, month)
    const floor = figures?.floor_set ? 'its floor' : 'zero'
    // A top-up runs only while the account is under its floor, so ending the day short of it means the source could spare no more.
    const after = walk.balances.get(to)?.[walk.days.indexOf(out.date)] ?? 0
    const reason: Copy = after >= (figures?.floor_minor ?? 0) ? [textPart('Brings '), { account: to }, textPart(` up to ${floor}`)] : [{ account: to }, textPart(` stays under ${floor}: this is all `), { account: from }, textPart(' can spare')]
    return [
      {
        type: 'top_up',
        id: out.id,
        section: 'transfers',
        date: out.date,
        from_account_id: from,
        to_account_id: to,
        title: [textPart('Top up '), { account: to }, textPart(' from '), { account: from }],
        detail: [{ date: out.date }, textPart(' · '), ...reason],
        currency: currencyOf(from),
        sent_minor: -out.amount_minor,
        landed: currencyOf(to) === currencyOf(from) ? null : { currency: currencyOf(to), minor: into.amount_minor },
        done: false,
        words: out.flags.map((f) => ({ text: FLAG_WORDS[f], tone: null })),
        primary: { label: RECORD_TRANSFER, link: { pathname: '/add', params: { mode: 'move', from, to, amount: String(-out.amount_minor) } } },
      },
    ]
  })
}

function monthOfAlert(a: Alert, review: readonly ReviewItem[]): string | undefined {
  return 'month' in a.subject ? a.subject.month : review.find((r) => r.id === (a.subject as { review_id: string }).review_id)?.month
}

const byDateThenName = (names: ReadonlyMap<string, string>) => (a: ItemRow, b: ItemRow) => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  const [na, nb] = [names.get(a.plan_item_id) ?? '', names.get(b.plan_item_id) ?? '']
  return na !== nb ? na.localeCompare(nb) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// One month's To-do from one snapshot and its full walk: this month lists every alert, future months included (Today's 'N more' lands here); another month its own.
export function todoModel({ snapshot, walk, breakeven, month }: TodoInputs): TodoModel {
  const key = monthKey(month)
  const kind = monthKind(key, snapshot.as_of)
  const plan = expandPlan(snapshot)
  const review = reviewList(snapshot, walk)
  const all = coreAlerts({ snapshot, walk, review, breakeven, budgets: budgetRows(snapshot) })

  const suggested = new Map<string, number>()
  for (const s of plan.suggestions) suggested.set(s.occurrence_id, (suggested.get(s.occurrence_id) ?? 0) + 1)
  const budgets = new Map(plan.budgets.filter((b) => b.month === key).map((b) => [b.category_id, b]))
  const items = plan.occurrences.filter((o) => o.period.slice(0, 7) === key).flatMap((o) => itemRow(snapshot, o, suggested.get(o.id) ?? 0, budgets) ?? [])
  items.sort(byDateThenName(new Map([...snapshotIndex(snapshot).planItems].map(([id, p]) => [id, p.name]))))

  const cards: CardRow[] = []
  const replays = cardsOf(walk)
  const ordered = [...snapshot.doc.accounts].filter((a) => a.kind === 'credit_card' && a.archived_at === null).sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1))
  for (const card of ordered) {
    const cycle = cycleIn(replays?.get(card.id)?.statements ?? [], key)
    if (cycle) cards.push(cardRow(snapshot, card.id, cycle, review))
  }

  // Top-ups join the transfers by day, after the plan's own on the same day; a past month has none, as the walk starts today.
  const moves = [...items, ...topUpRows(snapshot, walk, key)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const rows: TodoRow[] = [...cards, ...moves]
  const listed = new Set(items.map((r) => r.id))
  const shown = kind === 'current' ? all : all.filter((a) => monthOfAlert(a, review) === key)
  const alertsShown = shown.map((alert): TodoAlert => {
    const item = review.find((r) => r.id === alert.id)
    const open: TodoAlert['open'] =
      item?.occurrence_id && listed.has(item.occurrence_id)
        ? { kind: 'row', row_id: item.occurrence_id }
        : item?.kind === 'overdue_outflow' && item.occurrence_id === null
          ? { kind: 'link', link: { pathname: '/add', params: { mode: 'move', to: item.account_id } } }
          : { kind: 'link', link: routeLink(alert.route, key) }
    return { alert, tone: TONES[alert.severity], open }
  })

  const groups = TODO_SECTIONS.map((section) => {
    const list = rows.filter((r) => r.section === section)
    return { section, rows: list, open: list.filter((r) => !r.done).length }
  }).filter((g) => g.rows.length > 0)
  const tracked = monthKey(plan.history_from)
  return {
    month: key,
    kind,
    alerts: alertsShown,
    groups,
    empty: rows.length === 0 && alertsShown.length === 0 ? { tracked_from: key < tracked ? tracked : null } : null,
  }
}

export interface Candidate {
  row_id: string
  account_id: string
  partner_account_id: string | null
  posted_on: string
  // Positive, in the account's currency.
  amount_minor: number
  currency: string
  description: string | null
  kind: TransactionKind
  // The suggestion rule pairs it with this occurrence.
  suggested: boolean
  edit: Edit
}

// Link's picker: the account's unlinked rows dated in the occurrence's month, or for late income from that month to this one, that may settle it, at any amount; suggestions first, then the nearest day and amount.
export function linkChoices(snapshot: Snapshot, occurrenceId: string): Candidate[] {
  const plan = expandPlan(snapshot)
  const index = snapshotIndex(snapshot)
  const o = plan.byId.get(occurrenceId)
  const item = o ? index.planItems.get(o.plan_item_id) : undefined
  if (!o || !item || !LINKABLE.has(o.flow)) return []
  const month = o.period.slice(0, 7)
  const last = o.state === 'late' ? monthKey(snapshot.as_of) : month
  const pairs = new Map(plan.suggestions.filter((s) => s.occurrence_id === o.id).map((s, i) => [s.row_id, i]))
  const accounts = snapshot.doc.accounts
  const partnerOf = (t: Transaction) => (t.transfer_id === null ? null : (index.transfers.get(t.transfer_id)?.find((leg) => leg.id !== t.id) ?? null))
  const currency = index.accounts.get(o.account_id)?.currency ?? snapshot.doc.household.base_currency
  const found = (index.rowsByAccount.get(o.account_id) ?? []).filter((t) => {
    const posted = t.posted_on.slice(0, 7)
    if (t.plan_item_id !== null || !(pairs.has(t.id) || (posted >= month && posted <= last))) return false
    return validateLink(t, partnerOf(t), item, accounts).length === 0
  })
  const gap = (t: Transaction) => [Math.abs(Date.parse(t.posted_on) - Date.parse(o.date)), Math.abs(Math.abs(t.amount_minor) - o.open_minor)] as const
  found.sort((a, b) => {
    const [pa, pb] = [pairs.get(a.id), pairs.get(b.id)]
    if (pa !== undefined || pb !== undefined) return (pa ?? Infinity) - (pb ?? Infinity)
    const [ga, gb] = [gap(a), gap(b)]
    return ga[0] - gb[0] || ga[1] - gb[1] || (a.id < b.id ? -1 : 1)
  })
  return found.map((t) => ({
    row_id: t.id,
    account_id: t.account_id,
    partner_account_id: partnerOf(t)?.account_id ?? null,
    posted_on: t.posted_on,
    amount_minor: Math.abs(t.amount_minor),
    currency,
    description: t.description,
    kind: t.kind,
    suggested: pairs.has(t.id),
    edit: { kind: 'link', row_id: t.id, plan_item_id: o.plan_item_id, period: o.period },
  }))
}
