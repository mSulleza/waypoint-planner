import type { BudgetRow, BudgetWord, Snapshot } from '@waypoint/core'
import { weekPace, type PaceWeek, type WeekPattern } from '@waypoint/core/pace'

// Spec §7 Budgets: this week for every weekly budget, against a plan shaped by the days it is usually spent on, then the month's weeks; budgets spent in lumps keep their month.

export interface WeekBar {
  // Spent over the week's budget, 0 to 1, and the plan by today over it, where the mark sits.
  spent: number
  mark: number
  // Caution while spending fast; Cobalt text colour otherwise.
  fill: 'caution' | 'brandText'
}

export interface StripWeek extends PaceWeek {
  // The column's fill, spent over budget from 0 to 1, and whether the week went past its budget.
  share: number
  over: boolean
}

// How a budget's week is spread: by its peak days, evenly with the days seen, or evenly until 2 weeks are recorded.
export type PatternKind = 'peaks' | 'even' | 'learning'

export interface WeekLine {
  // null for the weekly budgets together.
  category_id: string | null
  currency: string
  budget_minor: number
  spent_minor: number
  // Below zero once the week is overspent.
  left_minor: number
  plan_by_today_minor: number
  usual_day_minor: number | null
  word: BudgetWord | null
  bar: WeekBar
  // What is left of the month as an even week from today.
  per_week_minor: number
  pattern: PatternKind
  peaks: readonly number[]
  weeks: readonly StripWeek[]
}

export interface BudgetsModel {
  as_of: string
  month: string
  // This week inside the month, and as_of's day in it.
  from: string
  to: string
  day: number
  days: number
  total: WeekLine | null
  weekly: readonly WeekLine[]
  monthly: readonly BudgetRow[]
}

// Under 2 weeks of history the plan is an even week (core's weekPattern).
const LEARNING_DAYS = 14

const share = (part: number, whole: number) => (whole > 0 ? Math.min(1, Math.max(0, part / whole)) : part > 0 ? 1 : 0)

const strip = (weeks: readonly PaceWeek[]): StripWeek[] => weeks.map((w) => ({ ...w, share: share(w.spent_minor, w.budget_minor), over: w.spent_minor > w.budget_minor }))

const patternKind = (p: Pick<WeekPattern, 'days_seen' | 'peaks'>): PatternKind => (p.days_seen < LEARNING_DAYS ? 'learning' : p.peaks.length > 0 ? 'peaks' : 'even')

function line(fields: { category_id: string | null; currency: string; weeks: readonly PaceWeek[]; current: number; plan_by_today_minor: number; usual_day_minor: number | null; word: BudgetWord | null; per_week_minor: number; pattern: Pick<WeekPattern, 'days_seen' | 'peaks'> }): WeekLine {
  const week = fields.weeks[fields.current] ?? { budget_minor: 0, spent_minor: 0 }
  return {
    category_id: fields.category_id,
    currency: fields.currency,
    budget_minor: week.budget_minor,
    spent_minor: week.spent_minor,
    left_minor: week.budget_minor - week.spent_minor,
    plan_by_today_minor: fields.plan_by_today_minor,
    usual_day_minor: fields.usual_day_minor,
    word: fields.word,
    bar: { spent: share(week.spent_minor, week.budget_minor), mark: share(fields.plan_by_today_minor, week.budget_minor), fill: fields.word === 'Spending fast' ? 'caution' : 'brandText' },
    per_week_minor: fields.per_week_minor,
    pattern: patternKind(fields.pattern),
    peaks: fields.pattern.peaks,
    weeks: strip(fields.weeks),
  }
}

export function budgetsModel(snapshot: Snapshot): BudgetsModel {
  const pace = weekPace(snapshot)
  const weekly = pace.rows.filter((r) => r.pattern.rhythm === 'weekly')
  const current = weekly[0]?.current ?? 0
  const total = pace.total
  return {
    as_of: pace.as_of,
    month: pace.as_of.slice(0, 7),
    from: pace.from,
    to: pace.to,
    day: pace.day,
    days: pace.days,
    // The total's pattern words would repeat its rows', so it states none.
    total: total ? line({ category_id: null, currency: total.currency, weeks: total.weeks, current, plan_by_today_minor: total.plan_by_today_minor, usual_day_minor: total.usual_day_minor, word: total.word, per_week_minor: total.per_week_minor, pattern: { days_seen: LEARNING_DAYS, peaks: [] } }) : null,
    weekly: weekly.map((r) => line({ category_id: r.category_id, currency: r.currency, weeks: r.weeks, current: r.current, plan_by_today_minor: r.plan_by_today_minor, usual_day_minor: r.pattern.usual_day_minor, word: r.word, per_week_minor: r.per_week_minor, pattern: r.pattern })),
    monthly: pace.rows.filter((r) => r.pattern.rhythm === 'monthly').map((r) => r.month),
  }
}

// Weekday names from Monday, in the reader's language: 19 Oct 2026 was a Monday.
export function weekdayName(day: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 19 + day)))
}

// The month's own name, for 'keeps October on budget'.
export function monthName(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))
}

// 'Most on Friday', 'Most on Saturday and Thursday', or how an even week came about.
export function patternWords(l: Pick<WeekLine, 'pattern' | 'peaks'>, locale: string): string {
  if (l.pattern === 'learning') return 'Spread evenly until 2 weeks are recorded'
  if (l.pattern === 'even') return 'Spread through the week'
  return `Most on ${l.peaks.map((d) => weekdayName(d, locale)).join(' and ')}`
}
