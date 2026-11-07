import { approxTotal, type Money, type Total } from '../money'
import type { Rate } from '../rates'
import { snapshotIndex, type Snapshot } from '../snapshot'
import { cardsOf } from './cards'
import { debtMilestones, horizonDebt, type HorizonDebt, type Milestone } from './debt-figures'
import { loansOf } from './loans'
import type { Walk } from './types'
import type { BelowZero } from './walk'

// One cash account from as_of to the horizon end, every walked day read, so no figure rests on a terminal balance.
export interface CashMetrics {
  account_id: string
  currency: string
  // The lowest end-of-day balance, never floored at zero, and the first day it occurs.
  lowest_minor: number
  lowest_on: string
  // Days ending below the floor, and below the target, after top-ups.
  days_under_floor: number
  days_under_target: number
  // Months with a shortfall below the floor that no later top-up that month covers.
  unfixable_gap_months: readonly string[]
  first_below_zero_on: string | null
}

export interface DebtInterest {
  account_id: string
  currency: string
  // Charged at cuts and payment days from as_of to the horizon end.
  interest_to_horizon_minor: number
  // A loan's interest from the horizon end to its payoff; 0 for a card, whose model ends with the horizon.
  interest_after_horizon_minor: number
}

// The card statements a projection starts from: each card's latest entered statement on or before as_of, or its opening balance.
export interface StatementAnchor {
  account_id: string
  statement_id: string
  cut_date: string
  source: 'entered' | 'opening'
}

export interface NetWorthAtHorizon {
  // The horizon's last day.
  on: string
  // Every cash account at the end of that day, in its own currency.
  cash: readonly (Money & { account_id: string })[]
  debts: readonly HorizonDebt[]
  // Cash minus total debt in the base currency at the walk's rates; null when a rate is missing, never a zero.
  total: Total | null
  as_of_statements: readonly StatementAnchor[]
}

export interface WalkMetrics {
  as_of: string
  horizon_end: string
  cash: readonly CashMetrics[]
  // Months in which any cash account has an unfixable gap.
  unfixable_gap_months: readonly string[]
  // The first day any cash account ends below zero: the plan breaks in that month.
  first_below_zero: (BelowZero & { month: string }) | null
  net_worth_at_horizon: NetWorthAtHorizon
  interest: readonly DebtInterest[]
  revolving_cleared: Milestone
  debt_free: Milestone
}

// The headline numbers of one walk (spec §6.8); the walk must have run the card and loan modules when the household has those debts.
export function walkMetrics(snapshot: Snapshot, walk: Walk): WalkMetrics {
  const index = snapshotIndex(snapshot)
  const end = walk.days.length - 1
  const cash: CashMetrics[] = []
  const gapMonths = new Set<string>()
  let first: (BelowZero & { month: string }) | null = null
  const cashAtEnd: (Money & { account_id: string })[] = []
  for (const account of snapshot.doc.accounts) {
    if (account.kind !== 'cash') continue
    const balances = walk.balances.get(account.id)
    const months = walk.figures.get(account.id)
    if (!balances || !months) throw new Error(`The walk has no days for cash account '${account.id}'`)
    let [lowest, lowestAt, below] = [Infinity, 0, -1]
    for (let i = 0; i <= end; i++) {
      const b = balances[i] ?? 0
      if (b < lowest) [lowest, lowestAt] = [b, i]
      if (below < 0 && b < 0) below = i
    }
    const unfixable = months.filter((m) => m.unfixable_gap_minor > 0).map((m) => m.month)
    for (const month of unfixable) gapMonths.add(month)
    const belowOn = below < 0 ? null : (walk.days[below] ?? null)
    if (belowOn !== null && (first === null || belowOn < first.date)) first = { account_id: account.id, date: belowOn, month: belowOn.slice(0, 7) }
    cash.push({
      account_id: account.id,
      currency: account.currency,
      lowest_minor: lowest,
      lowest_on: walk.days[lowestAt] ?? walk.as_of,
      days_under_floor: months.reduce((sum, m) => sum + m.days_under_floor, 0),
      days_under_target: months.reduce((sum, m) => sum + m.days_under_target, 0),
      unfixable_gap_months: Object.freeze(unfixable),
      first_below_zero_on: belowOn,
    })
    cashAtEnd.push({ account_id: account.id, minor: balances[end] ?? 0, currency: account.currency })
  }

  const debts = horizonDebt(snapshot, walk)
  const rates: Rate[] = snapshot.rates.map((r) => ({ quote: r.quote, rate: walk.rates[r.quote] ?? r.rate, day: r.day }))
  const total = approxTotal([...cashAtEnd.map(({ minor, currency }) => ({ minor, currency })), ...debts.map((d) => ({ minor: 0 - d.total_debt_minor, currency: d.currency }))], snapshot.doc.household.base_currency, rates)

  const replays = cardsOf(walk)
  const schedules = loansOf(walk)
  const anchors: StatementAnchor[] = []
  const interest: DebtInterest[] = []
  for (const account of snapshot.doc.accounts) {
    if (account.kind === 'loan') {
      const schedule = schedules?.get(account.id)
      if (!schedule) throw new Error(`The walk has no schedule for loan '${account.id}'`)
      interest.push({ account_id: account.id, currency: account.currency, interest_to_horizon_minor: schedule.interest_minor, interest_after_horizon_minor: schedule.interest_after_horizon_minor })
    }
    if (account.kind !== 'credit_card') continue
    const replay = replays?.get(account.id)
    const anchor = replay?.statements.find((s) => s.id === replay.anchor_id)
    if (!replay || !anchor) throw new Error(`The walk has no replay for card '${account.id}'`)
    anchors.push({ account_id: account.id, statement_id: anchor.id, cut_date: anchor.cut_date, source: anchor.source === 'entered' ? 'entered' : 'opening' })
    const printed = new Map((index.statementsByAccount.get(account.id) ?? []).map((s) => [s.id, s.interest_minor]))
    let charged = 0
    for (const s of replay.statements) {
      if (s.cut_date < walk.as_of) continue
      charged += (s.source === 'entered' ? printed.get(s.id) : null) ?? s.model?.interest_minor ?? 0
    }
    interest.push({ account_id: account.id, currency: account.currency, interest_to_horizon_minor: charged, interest_after_horizon_minor: 0 })
  }

  const { revolving_cleared, debt_free } = debtMilestones(snapshot, walk)
  return Object.freeze({
    as_of: walk.as_of,
    horizon_end: walk.horizon_end,
    cash: Object.freeze(cash.map((c) => Object.freeze(c))),
    unfixable_gap_months: Object.freeze([...gapMonths].sort()),
    first_below_zero: first,
    net_worth_at_horizon: Object.freeze({
      on: walk.days[end] ?? walk.horizon_end,
      cash: Object.freeze(cashAtEnd),
      debts: Object.freeze(debts),
      total,
      as_of_statements: Object.freeze(anchors),
    }),
    interest: Object.freeze(interest),
    revolving_cleared,
    debt_free,
  })
}
