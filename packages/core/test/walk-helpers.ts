import type { SampleDoc } from '../fixtures'
import type { AccountInput } from '../fixtures/relative'
import { daysBetween } from '../src/dates'
import type { CardModule, DebtMove } from '../src/engine/debts'
import { expandPlan, spreadShares } from '../src/engine/events'
import type { LineItem, Walk, WalkResult } from '../src/engine/types'
import { walk, type WalkOptions } from '../src/engine/walk'
import { buildSnapshot, ledgerSum, snapshotIndex, type Snapshot } from '../src/snapshot'

export function walked(snapshot: Snapshot, options: WalkOptions = {}): Walk {
  const result: WalkResult = walk(snapshot, options)
  if (!result.ok) throw new Error(`The walk failed: ${result.errors.map((e) => e.message).join('; ')}`)
  return result
}

// End-of-day balance on one walked day.
export function balanceOn(w: Walk, accountId: string, day: string): number {
  const balances = w.balances.get(accountId)
  const value = balances?.[daysBetween(w.as_of, day)]
  if (value === undefined) throw new Error(`No balance for '${accountId}' on ${day}`)
  return value
}

export const topUpLines = (w: Walk): LineItem[] => w.lines.filter((l) => l.source === 'top_up')

// [date, from, to, gross sent, net landed] for each top-up pair.
export function topUpPairs(w: Walk): [string, string, string, number, number][] {
  const lines = topUpLines(w)
  return lines
    .filter((l) => l.amount_minor < 0)
    .map((out) => {
      const into = lines.find((l) => l.id === out.pair_id)
      if (!into) throw new Error(`Top-up '${out.id}' has no landed leg`)
      return [out.date, out.account_id, into.account_id, -out.amount_minor, into.amount_minor]
    })
}

// Stands in for the card payment figures in these tests: pays what is left of each entered statement on its due date, or on as_of once that passed.
export const payEnteredStatements: CardModule = {
  kind: 'credit_card',
  walk({ snapshot, accounts }) {
    const index = snapshotIndex(snapshot)
    const asOf = snapshot.as_of
    const moves: DebtMove[] = []
    for (const card of accounts) {
      const statement = (index.statementsByAccount.get(card.id) ?? []).filter((s) => s.cut_date <= asOf).at(-1)
      if (!statement || card.funded_from_account_id === null) continue
      const paid = (index.rowsByAccount.get(card.id) ?? []).filter((t) => t.posted_on > statement.cut_date && t.amount_minor > 0).reduce((sum, t) => sum + t.amount_minor, 0)
      const left = statement.total_due_minor - paid
      if (left <= 0) continue
      const late = statement.due_date < asOf
      moves.push({ id: `pay:${card.id}:${statement.cut_date}`, kind: 'payment', order: 4, date: late ? asOf : statement.due_date, account_id: card.id, from_account_id: card.funded_from_account_id, amount_minor: left, overdue: late, occurrence_ids: [] })
    }
    return { moves, summary: null }
  },
}

// Bank and Savings (EUR) and Pesos (PHP) cash accounts opened on 1 Jan 2026, with no floors, funders, plan or rows until `edit` adds them.
export function cashHousehold(asOf: string, edit?: (doc: SampleDoc) => void): Snapshot {
  const doc: SampleDoc = {
    version: 1,
    household: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-IE', track_from: '2026-01-01' },
    accounts: [
      { id: 'bank', name: 'Bank', kind: 'cash', currency: 'EUR', opening_balance_minor: 500000, opening_date: '2026-01-01', fx_fee_pct: 0.005, sort_order: 0 },
      { id: 'savings', name: 'Savings', kind: 'cash', currency: 'EUR', opening_balance_minor: 100000, opening_date: '2026-01-01', sort_order: 1 },
      { id: 'pesos', name: 'Pesos', kind: 'cash', currency: 'PHP', opening_balance_minor: 1000000, opening_date: '2026-01-01', sort_order: 2 },
    ],
    categories: [{ id: 'food', name: 'Food' }],
    plan_items: [],
    statements: [],
    transactions: [],
  }
  edit?.(doc)
  return buildSnapshot(doc, asOf, [
    { quote: 'EUR', rate: 1, day: asOf },
    { quote: 'PHP', rate: 70, day: asOf },
  ])
}

export function account(doc: SampleDoc, id: string): AccountInput {
  const found = doc.accounts.find((a) => a.id === id)
  if (!found) throw new Error(`No account '${id}' in the test household`)
  return found
}

// What an account holds at the end of a day from its start and the plan's events alone, before any top-up or debt move; a transfer counts at the bare rate, so keep it to one currency.
export function knownBalance(snapshot: Snapshot, accountId: string, day: string): number {
  const asOf = snapshot.as_of
  let sum = ledgerSum(snapshot, accountId, asOf)
  for (const e of expandPlan(snapshot).events) {
    if ((e.date < asOf ? asOf : e.date) > day) continue
    if (e.account_id === accountId) sum += e.kind === 'allowance' ? spreadShares(e).slice(0, daysBetween(e.date, day) + 1).reduce((a, b) => a + b, 0) : e.amount_minor
    else if (e.to_account_id === accountId) sum -= e.amount_minor
  }
  return sum
}
