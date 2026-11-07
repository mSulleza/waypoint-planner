import { daysInMonth, monthKey } from './dates'
import { expandPlan } from './engine/events'
import { convert, exceedsScaled } from './money'
import { toRatesPerEur } from './rates'
import type { Snapshot } from './snapshot'
import { THRESHOLDS, type BudgetWord } from './thresholds'

// Budget pace rows on Today: at most this many.
export const TODAY_BUDGET_ROWS = 3

// One category's allowances this month against the spending tagged to it, from the engine's own netting.
export interface BudgetRow {
  category_id: string
  month: string
  // The netting's currency: the allowance accounts' own, or the base currency when they differ.
  currency: string
  budget_minor: number
  // Signed: refunds give budget back; rows in other currencies count at today's rate.
  spent_minor: number
  // budget − spent, below zero once overspent.
  left_minor: number
  // The day of the month as_of falls on, the days from as_of to month end, and the month's length.
  days_elapsed: number
  days_left: number
  days_in_month: number
  // What is left over the remaining days, today included; 0 once nothing is left.
  per_day_minor: number
  // spent ÷ days elapsed, against budget ÷ days in month, rounded for display.
  rate_so_far_minor: number
  planned_rate_minor: number
  // null when a rate is missing, so the pace cannot be read.
  word: BudgetWord | null
  // The account carrying most of the category's allowances, for its alert.
  account_id: string
  // The budget in the base currency at today's rate, to rank rows; null without a rate.
  budget_base_minor: number | null
  occurrence_ids: readonly string[]
  missing_rates: readonly string[]
}

// Spending fast in days 1 to 7 only when spent > budget × (day + 7) ÷ days in month; from day 8 when spent ÷ day > pace × budget ÷ days in month.
export function budgetWord(spent: number, budget: number, day: number, days: number): BudgetWord {
  const fast = day <= THRESHOLDS.first_week.days ? spent * days > budget * (day + THRESHOLDS.first_week.days) : exceedsScaled(spent * days, THRESHOLDS.spending_fast.pace, budget * day)
  return fast ? THRESHOLDS.spending_fast.word : THRESHOLDS.spending_fast.otherwise
}

// Every allowance category this month, read from the netting the walk spends, so the pace and the projection never disagree.
export function budgetRows(snapshot: Snapshot): readonly BudgetRow[] {
  const plan = expandPlan(snapshot)
  const asOf = snapshot.as_of
  const month = monthKey(asOf)
  const day = Number(asOf.slice(8, 10))
  const days = daysInMonth(asOf)
  const left = days - day + 1
  const rates = toRatesPerEur(snapshot.rates)
  const base = snapshot.doc.household.base_currency
  const rows: BudgetRow[] = []
  for (const b of plan.budgets) {
    if (b.month !== month) continue
    // A category whose spending lines are all skipped is done for the month.
    const lines = b.occurrence_ids.map((id) => plan.byId.get(id)).filter((o) => o !== undefined && o.amount_minor > 0 && !o.skipped)
    if (lines.length === 0) continue
    const weight = new Map<string, number>()
    for (const o of lines) if (o) weight.set(o.account_id, (weight.get(o.account_id) ?? 0) + o.amount_minor)
    const accountId = [...weight].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0] ?? ''
    const remaining = b.budget_minor - b.spent_minor
    rows.push(
      Object.freeze({
        category_id: b.category_id,
        month,
        currency: b.currency,
        budget_minor: b.budget_minor,
        spent_minor: b.spent_minor,
        left_minor: remaining,
        days_elapsed: day,
        days_left: left,
        days_in_month: days,
        per_day_minor: remaining > 0 ? Math.floor(remaining / left) : 0,
        rate_so_far_minor: Math.round(b.spent_minor / day),
        planned_rate_minor: Math.round(b.budget_minor / days),
        word: b.missing_rates.length > 0 ? null : budgetWord(b.spent_minor, b.budget_minor, day, days),
        account_id: accountId,
        budget_base_minor: convert(b.budget_minor, b.currency, base, rates),
        occurrence_ids: b.occurrence_ids,
        missing_rates: b.missing_rates,
      }),
    )
  }
  return Object.freeze(rows)
}

// Today's budget pace: 'Spending fast' first, then the largest budgets, at most three.
export function todayBudgets(rows: readonly BudgetRow[]): readonly BudgetRow[] {
  const fast = (r: BudgetRow) => (r.word === THRESHOLDS.spending_fast.word ? 0 : 1)
  const size = (r: BudgetRow) => r.budget_base_minor ?? -Infinity
  return Object.freeze([...rows].sort((a, b) => fast(a) - fast(b) || size(b) - size(a) || (a.category_id < b.category_id ? -1 : 1)).slice(0, TODAY_BUDGET_ROWS))
}
