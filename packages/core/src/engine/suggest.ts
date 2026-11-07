import { dayFromNumber, dayNumber } from '../dates'
import type { Transaction } from '../schema/rows'
import { snapshotIndex, type Snapshot } from '../snapshot'
import { SUGGEST_DAYS, SUGGEST_PCT, type Flow, type Occurrence, type Suggestion } from './types'

const OPEN = new Set(['due', 'overdue', 'late', 'unconfirmed', 'partly_settled'])

// The fields the pairing rule reads, so a row the Add sheet has not saved yet pairs by the same rule.
export type SuggestRow = Pick<Transaction, 'id' | 'account_id' | 'kind' | 'amount_minor' | 'posted_on' | 'plan_item_id'>

// Which flows a row's kind can settle; drawdowns, adjustments and incoming legs settle nothing here.
function settles(row: SuggestRow): readonly Flow[] {
  if (row.kind === 'expense') return ['bill', 'card_bill']
  if (row.kind === 'income' || row.kind === 'refund') return ['income', 'draw']
  if (row.kind === 'transfer' && row.amount_minor < 0) return ['transfer']
  return []
}

function firstOnOrAfter(list: readonly Occurrence[], day: string): number {
  let [lo, hi] = [0, list.length]
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid]?.date ?? '') < day) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Nearest date, then nearest amount, then occurrence id so the pick never depends on input order.
function nearer(a: Suggestion, b: Suggestion): boolean {
  if (a.days_apart !== b.days_apart) return a.days_apart < b.days_apart
  const [ga, gb] = [Math.abs(a.amount_gap_minor), Math.abs(b.amount_gap_minor)]
  return ga !== gb ? ga < gb : a.occurrence_id < b.occurrence_id
}

const openLists = new WeakMap<readonly Occurrence[], Map<string, Occurrence[]>>()

// Open occurrences with something still expected, per account in date order, once per occurrence list.
function openByAccount(occurrences: readonly Occurrence[]): Map<string, Occurrence[]> {
  const known = openLists.get(occurrences)
  if (known) return known
  const open = new Map<string, Occurrence[]>()
  for (const o of occurrences) {
    if (o.state === null || !OPEN.has(o.state) || o.open_minor <= 0) continue
    const list = open.get(o.account_id)
    if (list) list.push(o)
    else open.set(o.account_id, [o])
  }
  openLists.set(occurrences, open)
  return open
}

// Same account, within SUGGEST_DAYS and SUGGEST_PCT of the open amount; nearest date, then nearest amount. landsIn is a transfer's receiving account.
function bestFor(open: ReadonlyMap<string, readonly Occurrence[]>, row: SuggestRow, landsIn: string | null, dayOf: (day: string) => number): Suggestion | null {
  const flows = settles(row)
  const list = open.get(row.account_id)
  if (row.plan_item_id !== null || flows.length === 0 || !list) return null
  const size = Math.abs(row.amount_minor)
  let best: Suggestion | null = null
  const posted = dayNumber(row.posted_on)
  for (let i = firstOnOrAfter(list, dayFromNumber(posted - SUGGEST_DAYS)); i < list.length; i++) {
    const o = list[i] as Occurrence
    const apart = dayOf(o.date) - posted
    if (apart > SUGGEST_DAYS) break
    if (!flows.includes(o.flow) || (o.flow === 'transfer' && o.to_account_id !== landsIn)) continue
    const gap = size - o.open_minor
    if (Math.abs(gap) * 100 > o.open_minor * SUGGEST_PCT) continue
    const candidate = { id: `${row.id}>${o.id}`, row_id: row.id, occurrence_id: o.id, account_id: row.account_id, days_apart: Math.abs(apart), amount_gap_minor: gap }
    if (!best || nearer(candidate, best)) best = candidate
  }
  return best
}

// Each unlinked row suggests at most one open occurrence it could settle: same account, within SUGGEST_DAYS and SUGGEST_PCT of the open amount; nearest date, then nearest amount.
export function suggest(snapshot: Snapshot, occurrences: readonly Occurrence[]): Suggestion[] {
  const index = snapshotIndex(snapshot)
  const open = openByAccount(occurrences)
  // Many rows look at the same days, so each day's number is read once.
  const days = new Map<string, number>()
  const dayOf = (day: string) => {
    let n = days.get(day)
    if (n === undefined) days.set(day, (n = dayNumber(day)))
    return n
  }
  const out: Suggestion[] = []
  for (const row of snapshot.doc.transactions) {
    const landsIn = row.transfer_id === null ? null : (index.transfers.get(row.transfer_id)?.[1].account_id ?? null)
    const best = bestFor(open, row, landsIn, dayOf)
    if (best) out.push(best)
  }
  return out
}

// The open occurrence a row not saved yet would settle, by the same rule as suggest; landsIn is the receiving account of an outgoing transfer leg.
export function suggestFor(occurrences: readonly Occurrence[], row: SuggestRow, landsIn: string | null = null): Suggestion | null {
  return bestFor(openByAccount(occurrences), row, landsIn, dayNumber)
}
