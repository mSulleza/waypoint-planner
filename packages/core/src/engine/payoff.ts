import type { Account } from '../schema/rows'
import { ledgerSum, snapshotIndex, type Snapshot } from '../snapshot'
import { expandPlan } from './events'
import { slotCut } from './occurrences'

// One month's extra for debts from one funding account, in that account's currency.
export interface MonthExtra {
  amount_minor: number
  occurrence_ids: readonly string[]
}

// What payoff order ranks a debt by (spec §6.4).
export interface PayoffRank {
  account_id: string
  // A monthly card rate × 12, or a loan's annual_rate.
  annual_rate: number
  // A card's latest entered statement total minus the installments billed in it, else its opening balance; a loan's balance.
  revolving_minor: number
  sort_order: number
}

// Twelve significant digits, so 3% a month ranks equal to a typed 36% a year.
const rateKey = (rate: number) => Number(rate.toPrecision(12))

export function annualRate(account: Account): number {
  if (account.kind === 'credit_card') return rateKey(account.terms.interest.rate * (account.terms.interest.period === 'month' ? 12 : 1))
  if (account.kind === 'loan') return rateKey(account.terms.annual_rate)
  throw new RangeError(`'${account.id}' is a cash account, which has no payoff rank`)
}

// Measured from the snapshot each time, never remembered: a new statement can change which debt extra money reaches first.
export function payoffRank(snapshot: Snapshot, account: Account): PayoffRank {
  const rank = { account_id: account.id, annual_rate: annualRate(account), sort_order: account.sort_order }
  if (account.kind !== 'credit_card') return { ...rank, revolving_minor: 0 - ledgerSum(snapshot, account.id, snapshot.as_of) }
  const latest = (snapshotIndex(snapshot).statementsByAccount.get(account.id) ?? []).filter((s) => s.cut_date <= snapshot.as_of).at(-1)
  if (!latest) return { ...rank, revolving_minor: 0 - account.opening_balance_minor }
  let installments = latest.installments_minor
  if (installments === null) {
    const slot = slotCut(account.terms.cut_day, latest.cut_date)
    installments = 0
    for (const o of expandPlan(snapshot).occurrences) if (o.flow === 'installment' && o.account_id === account.id && !o.skipped && o.date === slot) installments += o.amount_minor
  }
  return { ...rank, revolving_minor: latest.total_due_minor - installments }
}

const orders = new WeakMap<Snapshot, ReadonlyMap<string, readonly string[]>>()

// Per funding account, the debts it pays in the order extra money reaches them: avalanche by annual rate, then larger revolving balance, then sort order; list by sort order.
export function payoffOrder(snapshot: Snapshot): ReadonlyMap<string, readonly string[]> {
  const cached = orders.get(snapshot)
  if (cached) return cached
  const avalanche = snapshot.doc.household.payoff_order === 'avalanche'
  const byFunder = new Map<string, PayoffRank[]>()
  for (const a of snapshot.doc.accounts) {
    if (a.kind === 'cash' || a.funded_from_account_id === null) continue
    const list = byFunder.get(a.funded_from_account_id) ?? []
    list.push(payoffRank(snapshot, a))
    byFunder.set(a.funded_from_account_id, list)
  }
  const out = new Map<string, readonly string[]>()
  for (const [funder, ranks] of [...byFunder].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    ranks.sort((a, b) => (avalanche ? b.annual_rate - a.annual_rate || b.revolving_minor - a.revolving_minor : 0) || a.sort_order - b.sort_order || (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0))
    out.set(funder, Object.freeze(ranks.map((r) => r.account_id)))
  }
  orders.set(snapshot, out)
  return out
}

const extras = new WeakMap<Snapshot, ReadonlyMap<string, ReadonlyMap<string, MonthExtra>>>()

// Extra for debts per funding account and month, skipped periods left out; a debt's cycle cut in that month sizes its payment with it.
export function extraByMonth(snapshot: Snapshot): ReadonlyMap<string, ReadonlyMap<string, MonthExtra>> {
  const cached = extras.get(snapshot)
  if (cached) return cached
  const out = new Map<string, Map<string, { amount_minor: number; occurrence_ids: string[] }>>()
  for (const o of expandPlan(snapshot).occurrences) {
    if (o.flow !== 'extra' || o.skipped) continue
    const months = out.get(o.account_id) ?? new Map()
    const month = o.scheduled_on.slice(0, 7)
    const found = months.get(month) ?? { amount_minor: 0, occurrence_ids: [] }
    found.amount_minor += o.amount_minor
    found.occurrence_ids.push(o.id)
    months.set(month, found)
    out.set(o.account_id, months)
  }
  for (const months of out.values()) for (const found of months.values()) Object.freeze(found.occurrence_ids)
  extras.set(snapshot, out)
  return out
}
