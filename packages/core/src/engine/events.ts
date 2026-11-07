import { addDays, dayNumber, firstOfMonth, lastDayOfMonth, monthKey } from '../dates'
import type { Transaction } from '../schema/rows'
import { snapshotIndex, type Snapshot } from '../snapshot'
import { netAllowances, taggedSpend } from './allowances'
import { historyFrom, horizonEnd, latestCut, occurrencesOf } from './occurrences'
import { suggest } from './suggest'
import { ORDER, type CategoryBudget, type EngineEvent, type EventKind, type ExpandedPlan, type Occurrence, type OrderClass } from './types'

function planned(o: Occurrence, kind: EventKind, order: OrderClass, date: string, amount: number, overdue = false): EngineEvent {
  return { id: o.id, kind, order, date, until: date, account_id: o.account_id, to_account_id: o.to_account_id, amount_minor: amount, occurrence_ids: [o.id], row_id: null, overdue }
}

// What an open occurrence still moves (spec §6.3); null when it counts nothing.
function occurrenceEvent(o: Occurrence, asOf: string, suggested: ReadonlySet<string>): EngineEvent | null {
  if (o.state === null || o.open_minor <= 0) return null
  const late = o.state === 'overdue'
  switch (o.flow) {
    case 'income':
    case 'draw':
      // An unconfirmed draw is on the debt if it came, and a suggested row may be this money already in; late income counts on carried_to.
      if (o.state === 'unconfirmed' || suggested.has(o.id)) return null
      return planned(o, o.flow, ORDER.money_in, o.carried_to ?? o.date, o.open_minor)
    case 'transfer':
      if (suggested.has(o.id)) return null
      return planned(o, 'transfer', ORDER.cash_transfer, late ? asOf : o.date, -o.open_minor, late)
    case 'bill':
      return planned(o, 'bill', ORDER.spending, late ? asOf : o.date, -o.open_minor, late)
    case 'card_bill':
      // A past card charge keeps its date, so the card's replay bills it at the first cut on or after it.
      return planned(o, 'card_bill', ORDER.spending, o.date, -o.open_minor)
    case 'installment':
      return planned(o, 'installment', ORDER.cut, o.date, -o.open_minor)
    default:
      return null
  }
}

function rowOrder(t: Transaction, cashLegs: (transferId: string) => boolean): OrderClass {
  switch (t.kind) {
    case 'income':
    case 'refund':
    case 'drawdown':
      return ORDER.money_in
    case 'expense':
      return ORDER.spending
    case 'adjustment':
      return t.amount_minor > 0 ? ORDER.money_in : ORDER.spending
    case 'transfer':
      return t.transfer_id !== null && cashLegs(t.transfer_id) ? ORDER.cash_transfer : ORDER.payment
  }
}

const byEventOrder = (a: EngineEvent, b: EngineEvent) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const plans = new WeakMap<Snapshot, ExpandedPlan>()

// Occurrences, suggestions, category budgets and the dated event list from as_of to the horizon end, once per snapshot object.
export function expandPlan(snapshot: Snapshot): ExpandedPlan {
  const cached = plans.get(snapshot)
  if (cached) return cached
  const index = snapshotIndex(snapshot)
  const asOf = snapshot.as_of
  const end = horizonEnd(asOf)
  const occurrences = occurrencesOf(snapshot, end)
  const suggestions = suggest(snapshot, occurrences)
  const suggested = new Set(suggestions.map((s) => s.occurrence_id))
  const byId = new Map<string, Occurrence>()
  for (const o of occurrences) byId.set(o.id, o)
  const events: EngineEvent[] = []
  for (const o of occurrences) {
    const event = occurrenceEvent(o, asOf, suggested)
    if (event) events.push(event)
  }

  const thisMonth = monthKey(asOf)
  const linesByMonth = new Map<string, Occurrence[]>()
  for (const o of occurrences) {
    const month = o.period.slice(0, 7)
    if (o.flow !== 'allowance' || month < thisMonth) continue
    const list = linesByMonth.get(month)
    if (list) list.push(o)
    else linesByMonth.set(month, [o])
  }
  const spend = taggedSpend(snapshot)
  const budgets: CategoryBudget[] = []
  for (const month of [...linesByMonth.keys()].sort()) {
    for (const budget of netAllowances(snapshot, month, linesByMonth.get(month) ?? [], spend)) {
      budgets.push(budget)
      for (const share of budget.shares) {
        if (share.amount_minor <= 0) continue
        let from = month === thisMonth ? asOf : firstOfMonth(month)
        // Spending on a card up to its latest cut is already on that statement.
        if (index.accounts.get(share.account_id)?.kind === 'credit_card') {
          const afterCut = addDays(latestCut(snapshot, share.account_id), 1)
          if (afterCut > from) from = afterCut
        }
        const until = lastDayOfMonth(month)
        if (from > until) continue
        const ids = budget.occurrence_ids.filter((id) => byId.get(id)?.account_id === share.account_id)
        events.push({ id: `allowance:${share.account_id}:${budget.category_id}:${month}`, kind: 'allowance', order: ORDER.spending, date: from, until, account_id: share.account_id, to_account_id: null, amount_minor: -share.amount_minor, occurrence_ids: ids, row_id: null, overdue: false })
      }
    }
  }

  const cashLegs = (transferId: string) => (index.transfers.get(transferId) ?? []).every((leg) => index.accounts.get(leg.account_id)?.kind === 'cash')
  for (const t of snapshot.doc.transactions) {
    if (t.posted_on <= asOf || t.posted_on > end) continue
    events.push({ id: `row:${t.id}`, kind: 'row', order: rowOrder(t, cashLegs), date: t.posted_on, until: t.posted_on, account_id: t.account_id, to_account_id: null, amount_minor: t.amount_minor, occurrence_ids: [], row_id: t.id, overdue: false })
  }

  events.sort(byEventOrder)
  for (const list of [occurrences, suggestions, budgets, events]) {
    for (const row of list) Object.freeze(row)
    Object.freeze(list)
  }
  const plan: ExpandedPlan = {
    as_of: asOf,
    history_from: historyFrom(snapshot),
    horizon_end: end,
    occurrences,
    byId,
    suggestions,
    budgets,
    events,
  }
  // Shared by every caller of this snapshot, so nobody may edit it.
  plans.set(snapshot, Object.freeze(plan))
  return plan
}

// An allowance's amount on each day from date to until, earlier days taking the odd minor units so the days sum exactly.
export function spreadShares(event: Pick<EngineEvent, 'date' | 'until' | 'amount_minor'>): number[] {
  const shares = new Float64Array(dayNumber(event.until) - dayNumber(event.date) + 1)
  addShares(event, shares, 0)
  return Array.from(shares)
}

// Adds each day's share, times `sign`, into `into` from index `at` until its end; the walk and the card replay use it so no array is made per allowance.
export function addShares(event: Pick<EngineEvent, 'date' | 'until' | 'amount_minor'>, into: Float64Array, at: number, sign: 1 | -1 = 1): void {
  const days = dayNumber(event.until) - dayNumber(event.date) + 1
  const total = Math.abs(event.amount_minor)
  let before = 0
  for (let i = 0; i < days && at + i < into.length; i++) {
    const upTo = Math.floor(((i + 1) * total + days - 1) / days)
    const share = event.amount_minor < 0 ? -(upTo - before) || 0 : upTo - before
    into[at + i] = (into[at + i] ?? 0) + sign * share
    before = upTo
  }
}
