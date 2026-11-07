import { budgetRows, type BudgetRow } from './budget'
import { addDays, dayNumber, daysBetween, daysInMonth, firstOfMonth, lastDayOfMonth } from './dates'
import { convert } from './money'
import { toRatesPerEur, type RatesPerEur } from './rates'
import { snapshotIndex, type Snapshot } from './snapshot'
import { THRESHOLDS, type BudgetWord } from './thresholds'

// Spec §7 Budgets: each budget's week, Monday to Sunday inside the month, against a plan shaped by the days the category is usually spent on.

// The pattern reads up to 8 weeks before this one; 4 weeks of an even week pull it in, so a short history only tilts it.
export const PATTERN_WEEKS = 8
export const PATTERN_PRIOR_WEEKS = 4
// A weekday at 1.5 times an even share or more is a peak; the words name at most two.
const PEAK = 1.5
const MAX_PEAKS = 2
// Weekly once spent in at least half the weeks seen, or with under 2 weeks seen; otherwise the spending comes in lumps and keeps its month pace.
const WEEKLY_SHARE = 0.5
const WEEKLY_FROM_DAYS = 14
// Shares are parts per million, so the plan splits a budget exactly in integers.
export const SHARE_PARTS = 1_000_000

const mulDiv = (a: number, b: number, c: number) => (c === 0 ? 0 : Number((BigInt(a) * BigInt(b)) / BigInt(c)))

// 0 for Monday to 6 for Sunday; epoch day 0, 1 Jan 1970, was a Thursday.
export const weekday = (day: string): number => (((dayNumber(day) + 3) % 7) + 7) % 7
export const mondayOf = (day: string): string => addDays(day, -weekday(day))

export type Rhythm = 'weekly' | 'monthly'

export interface WeekPattern {
  // Each weekday's share of a week's spending, Monday first, in parts per million that sum to SHARE_PARTS.
  shares: readonly number[]
  // Days of history read: from the household's first tagged row, at most 8 weeks, ending the Sunday before this week.
  days_seen: number
  // The Monday-to-Sunday weeks those days touch, and how many of them had spending.
  weeks_seen: number
  weeks_spent: number
  // Weekdays at 1.5 times an even share or more, largest first, at most two.
  peaks: readonly number[]
  // The median of the days with spending, in the budget's currency; null under 3 such days.
  usual_day_minor: number | null
  rhythm: Rhythm
}

export interface PaceWeek {
  from: string
  to: string
  // The month's budget for these days, split by the pattern.
  budget_minor: number
  spent_minor: number
  state: 'past' | 'current' | 'future'
}

export interface WeekPaceRow {
  category_id: string
  currency: string
  month: BudgetRow
  pattern: WeekPattern
  // This month's weeks, Monday to Sunday cut at the month's ends; `current` indexes the one as_of falls in.
  weeks: readonly PaceWeek[]
  current: number
  // The pattern's plan from the week's first day through as_of.
  plan_by_today_minor: number
  // Spending above this reads Spending fast: the week's budget, or less once a usual day is known.
  limit_minor: number
  // A weekly row reads its week; a monthly one keeps the month's word.
  word: BudgetWord | null
  // What is left of the month, spent evenly from today, as 7 days; 0 once nothing is left.
  per_week_minor: number
}

export interface WeekTotal {
  currency: string
  weeks: readonly PaceWeek[]
  plan_by_today_minor: number
  limit_minor: number
  usual_day_minor: number | null
  word: BudgetWord
  per_week_minor: number
}

export interface WeekPace {
  as_of: string
  // This week inside the month, and as_of's day in it, 1 on its first.
  from: string
  to: string
  day: number
  days: number
  // Weekly rows first, then monthly ones, each by budget size in the base currency.
  rows: readonly WeekPaceRow[]
  // The weekly rows together in the base currency; null without one, or when a rate is missing.
  total: WeekTotal | null
}

// Unlinked rows with a category, as spending per day in `currencyOf` the category; refunds count against it, as in the budget.
function dailySpend(snapshot: Snapshot, rates: RatesPerEur, currencyOf: ReadonlyMap<string, string>): { daily: Map<string, Map<string, number>>; missing: Set<string>; first: string | null } {
  const { accounts } = snapshotIndex(snapshot)
  const daily = new Map<string, Map<string, number>>()
  const missing = new Set<string>()
  let first: string | null = null
  for (const t of snapshot.doc.transactions) {
    if (t.category_id === null || t.plan_item_id !== null) continue
    if (first === null || t.posted_on < first) first = t.posted_on
    const currency = currencyOf.get(t.category_id)
    if (currency === undefined) continue
    const value = convert(-t.amount_minor, accounts.get(t.account_id)?.currency ?? snapshot.doc.household.base_currency, currency, rates)
    if (value === null) {
      missing.add(t.category_id)
      continue
    }
    const days = daily.get(t.category_id) ?? new Map<string, number>()
    days.set(t.posted_on, (days.get(t.posted_on) ?? 0) + value)
    daily.set(t.category_id, days)
  }
  return { daily, missing, first }
}

const sumDays = (daily: ReadonlyMap<string, number> | undefined, from: string, to: string) => {
  let total = 0
  if (daily) for (const [day, value] of daily) if (day >= from && day <= to) total += value
  return total
}

function median(values: readonly number[]): number | null {
  if (values.length < THRESHOLDS.week_pace.usual_from_days) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : Math.floor(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
}

// One category's weekdays over the days from `start` to `end`, pulled toward an even week by PATTERN_PRIOR_WEEKS.
export function weekPattern(daily: ReadonlyMap<string, number> | undefined, start: string | null, end: string): WeekPattern {
  const days = start === null || start > end ? 0 : daysBetween(start, end) + 1
  const sums = [0, 0, 0, 0, 0, 0, 0]
  const spentDays: number[] = []
  const weeks = new Set<string>()
  const spentWeeks = new Set<string>()
  for (let i = 0; i < days && start !== null; i++) {
    const day = addDays(start, i)
    weeks.add(mondayOf(day))
    const value = daily?.get(day) ?? 0
    if (value <= 0) continue
    const d = weekday(day)
    sums[d] = (sums[d] ?? 0) + value
    spentDays.push(value)
    spentWeeks.add(mondayOf(day))
  }
  const total = sums.reduce((a, b) => a + b, 0)
  const seen = days / 7
  const weights = sums.map((s) => (total > 0 ? (seen * (s / total) + PATTERN_PRIOR_WEEKS / 7) / (seen + PATTERN_PRIOR_WEEKS) : 1 / 7))
  const shares = weights.map((w) => Math.round(w * SHARE_PARTS))
  // Rounding leaves the parts a few off a million; the largest share takes the difference.
  const largest = shares.indexOf(Math.max(...shares))
  shares[largest] = (shares[largest] ?? 0) + SHARE_PARTS - shares.reduce((a, b) => a + b, 0)
  const peaks = shares
    .map((share, day) => ({ share, day }))
    .filter((p) => p.share * 7 >= PEAK * SHARE_PARTS)
    .sort((a, b) => b.share - a.share || a.day - b.day)
    .slice(0, MAX_PEAKS)
    .map((p) => p.day)
  const rhythm: Rhythm = days < WEEKLY_FROM_DAYS || spentWeeks.size >= WEEKLY_SHARE * weeks.size ? 'weekly' : 'monthly'
  return { shares, days_seen: days, weeks_seen: weeks.size, weeks_spent: spentWeeks.size, peaks, usual_day_minor: median(spentDays), rhythm }
}

// What the plan spends from the 1st through `day`, the budget split over the month's days by weekday share; the month's last day gives the whole budget.
export function monthPlan(budget: number, shares: readonly number[], month: string): (day: string) => number {
  const first = firstOfMonth(month)
  const through: number[] = []
  let sum = 0
  for (let i = 0; i < daysInMonth(month); i++) {
    sum += shares[weekday(addDays(first, i))] ?? 0
    through.push(sum)
  }
  return (day) => {
    const i = daysBetween(first, day)
    return i < 0 ? 0 : mulDiv(budget, through[Math.min(i, through.length - 1)] ?? 0, sum)
  }
}

// A part-week shorter than this at a month's start or end joins the week beside it, so no week is 1 to 3 days long.
const SHORTEST_WEEK = 4

// The month's weeks, Monday to Sunday cut at its first and last days.
export function monthWeeks(asOf: string): { from: string; to: string }[] {
  const last = lastDayOfMonth(asOf)
  const out: { from: string; to: string }[] = []
  for (let from = firstOfMonth(asOf); from <= last; ) {
    const sunday = addDays(mondayOf(from), 6)
    const to = sunday < last ? sunday : last
    out.push({ from, to })
    from = addDays(to, 1)
  }
  const length = (w: { from: string; to: string }) => daysBetween(w.from, w.to) + 1
  const [head, second] = out
  if (head && second && length(head) < SHORTEST_WEEK) out.splice(0, 2, { from: head.from, to: second.to })
  const [before, tail] = out.slice(-2)
  if (before && tail && length(tail) < SHORTEST_WEEK) out.splice(-2, 2, { from: before.from, to: tail.to })
  return out
}

const stateOf = (week: { from: string; to: string }, asOf: string): PaceWeek['state'] => (week.to < asOf ? 'past' : week.from > asOf ? 'future' : 'current')

const fastOr = (spent: number, limit: number): BudgetWord => (spent > limit ? THRESHOLDS.week_pace.word : THRESHOLDS.week_pace.otherwise)

const evenWeek = (left: number, daysLeft: number) => (left > 0 && daysLeft > 0 ? Math.floor((left * 7) / daysLeft) : 0)

// Every budget this month by the week: the plan for each week from the category's own weekdays, what was spent in it, and this week's word.
export function weekPace(snapshot: Snapshot): WeekPace {
  const asOf = snapshot.as_of
  const base = snapshot.doc.household.base_currency
  const rates = toRatesPerEur(snapshot.rates)
  const months = budgetRows(snapshot)
  const { daily, missing, first } = dailySpend(snapshot, rates, new Map(months.map((m) => [m.category_id, m.currency])))
  const end = addDays(mondayOf(asOf), -1)
  const earliest = addDays(mondayOf(asOf), -7 * PATTERN_WEEKS)
  const start = first === null ? null : first > earliest ? first : earliest
  const spans = monthWeeks(asOf)
  const current = spans.findIndex((w) => w.from <= asOf && asOf <= w.to)
  const span = spans[current] ?? { from: asOf, to: asOf }

  const rows = months.map((month): WeekPaceRow => {
    const own = daily.get(month.category_id)
    const pattern = weekPattern(own, start, end)
    const plan = monthPlan(month.budget_minor, pattern.shares, asOf)
    const weeks = spans.map((w) => ({ ...w, budget_minor: plan(w.to) - plan(addDays(w.from, -1)), spent_minor: sumDays(own, w.from, w.to), state: stateOf(w, asOf) }))
    const week = weeks[current] ?? { budget_minor: 0, spent_minor: 0 }
    const planByToday = plan(asOf) - plan(addDays(span.from, -1))
    const limit = pattern.usual_day_minor === null ? week.budget_minor : Math.min(week.budget_minor, planByToday + pattern.usual_day_minor)
    const unread = month.word === null || missing.has(month.category_id)
    return {
      category_id: month.category_id,
      currency: month.currency,
      month,
      pattern,
      weeks,
      current,
      plan_by_today_minor: planByToday,
      limit_minor: limit,
      word: unread ? null : pattern.rhythm === 'weekly' ? fastOr(week.spent_minor, limit) : month.word,
      per_week_minor: evenWeek(month.left_minor, month.days_left),
    }
  })
  const size = (r: WeekPaceRow) => r.month.budget_base_minor ?? -Infinity
  const rhythm = (r: WeekPaceRow) => (r.pattern.rhythm === 'weekly' ? 0 : 1)
  const sorted = [...rows].sort((a, b) => rhythm(a) - rhythm(b) || size(b) - size(a) || (a.category_id < b.category_id ? -1 : 1))
  return { as_of: asOf, from: span.from, to: span.to, day: daysBetween(span.from, asOf) + 1, days: daysBetween(span.from, span.to) + 1, rows: sorted, total: weekTotal(sorted, daily, start, end, base, rates) }
}

// The weekly rows in the base currency: their weeks and plans summed, and a usual day read from their spending together.
function weekTotal(rows: readonly WeekPaceRow[], daily: ReadonlyMap<string, ReadonlyMap<string, number>>, start: string | null, end: string, base: string, rates: RatesPerEur): WeekTotal | null {
  const weekly = rows.filter((r) => r.pattern.rhythm === 'weekly')
  if (weekly.length === 0 || weekly.some((r) => r.word === null)) return null
  const toBase = (minor: number, currency: string) => convert(minor, currency, base, rates)
  const together = new Map<string, number>()
  let failed = false
  const add = (value: number | null) => {
    if (value === null) failed = true
    return value ?? 0
  }
  for (const r of weekly) for (const [day, value] of daily.get(r.category_id) ?? []) together.set(day, (together.get(day) ?? 0) + add(toBase(value, r.currency)))
  const first = weekly[0]
  if (!first) return null
  const weeks = first.weeks.map((w, i) => ({
    ...w,
    budget_minor: weekly.reduce((t, r) => t + add(toBase(r.weeks[i]?.budget_minor ?? 0, r.currency)), 0),
    spent_minor: weekly.reduce((t, r) => t + add(toBase(r.weeks[i]?.spent_minor ?? 0, r.currency)), 0),
  }))
  const planByToday = weekly.reduce((t, r) => t + add(toBase(r.plan_by_today_minor, r.currency)), 0)
  const perWeek = weekly.reduce((t, r) => t + add(toBase(r.per_week_minor, r.currency)), 0)
  if (failed) return null
  const usual = weekPattern(together, start, end).usual_day_minor
  const week = weeks[first.current] ?? { budget_minor: 0, spent_minor: 0 }
  const limit = usual === null ? week.budget_minor : Math.min(week.budget_minor, planByToday + usual)
  return { currency: base, weeks, plan_by_today_minor: planByToday, limit_minor: limit, usual_day_minor: usual, word: fastOr(week.spent_minor, limit), per_week_minor: perWeek }
}
