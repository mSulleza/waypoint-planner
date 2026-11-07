import { addDays, addMonths, convert, daysBetween, debtMilestones, itemSchedule, lastDayOfMonth, monthKey, toRatesPerEur, type PlanItem, type Snapshot, type Walk } from '@waypoint/core'

// A plan item whose name starts with this, paying money out, is money put into the lending book.
export const LENDING_PREFIX = 'lending:'

// One round, an example default the Return per round slider changes: the loan goes out, then 6 monthly repayments of 20% bring back 120% over 180 days (about 3.3% a month flat).
export const ROUND_RATE = 0.2
export const ROUND_DAYS = 180
export const ROUND_PAYMENTS = 6

export interface Range {
  min: number
  max: number
  step: number
}

// The what-if controls: loss buffer, return per round and salary growth in percent, top-up and income in the base currency's major units a month.
export const RANGES = {
  loss: { min: 0, max: 30, step: 1 },
  topup: { min: 0, max: 3000, step: 100 },
  goal: { min: 1000, max: 10000, step: 100 },
  rate: { min: 10, max: 30, step: 1 },
  growth: { min: 0, max: 10, step: 0.5 },
} as const satisfies Record<string, Range>

export const DEFAULT_LOSS = 15
export const DEFAULT_RATE = Math.round(ROUND_RATE * 100)
export const DEFAULT_GROWTH = 3

// Past this the goal reads as out of reach.
const MAX_YEARS = 30

// The book is a retirement fund: top-ups and relending carry on past the goal, and the view runs this long after it.
export const YEARS_PAST_GOAL = 5

// The milestones the schedule marks on the way to the goal.
const SHARES = [0.25, 0.5, 0.75] as const

export interface Injection {
  day: string
  minor: number
  // The plan item it comes from and its name after 'Lending:'; null and empty for a what-if top-up.
  item_id: string | null
  name: string
  // A top-up that repeats rises with the salary; a one-off loan stays as planned.
  grows: boolean
}

// How much the salary has grown by a day: one raise each January after today.
export const raiseBy = (asOf: string, day: string, growthPct: number): number => (1 + growthPct / 100) ** Math.max(0, Number(day.slice(0, 4)) - Number(asOf.slice(0, 4)))

export function withRaises(injections: readonly Injection[], asOf: string, growthPct: number): Injection[] {
  return injections.map((i) => (i.grows && growthPct > 0 ? { ...i, minor: Math.round(i.minor * raiseBy(asOf, i.day, growthPct)) } : i))
}

// What one round turns the money out into, after that round's share of the yearly loss.
export const roundGrowth = (lossPct: number, rate = ROUND_RATE) => (1 + rate) * (1 - ((lossPct / 100) * ROUND_DAYS) / 365)

// What the book pays a month when each round's gain is taken out and the money out stays the same.
export const monthlyYield = (lossPct: number, rate = ROUND_RATE) => ((roundGrowth(lossPct, rate) - 1) * 365) / 12 / ROUND_DAYS

export const isLending = (item: PlanItem) => item.name.trim().toLowerCase().startsWith(LENDING_PREFIX)

function toBase(snapshot: Snapshot, minor: number, currency: string): number | null {
  const base = snapshot.doc.household.base_currency
  return currency === base ? minor : convert(minor, currency, base, toRatesPerEur(snapshot.rates))
}

function currencyOf(snapshot: Snapshot, accountId: string | null): string | null {
  return snapshot.doc.accounts.find((a) => a.id === accountId)?.currency ?? null
}

// Every planned payment into the book, past and future, in the base currency; an upside item is not planned money.
export function plannedInjections(snapshot: Snapshot, to: string): Injection[] {
  const out: Injection[] = []
  for (const item of snapshot.doc.plan_items) {
    if (!isLending(item) || item.confidence === 'upside' || item.from_account_id === null || (item.kind !== 'bill' && item.kind !== 'transfer')) continue
    const currency = currencyOf(snapshot, item.from_account_id)
    const minor = currency === null ? null : toBase(snapshot, item.amount_minor, currency)
    if (minor === null || minor <= 0) continue
    const skips = new Set(item.skip_periods)
    const name = item.name.trim().slice(LENDING_PREFIX.length).trim()
    const grows = item.every !== 'once'
    for (const [period, day] of itemSchedule(item, null, item.starts_on, to)) if (!skips.has(period)) out.push({ day, minor, item_id: item.id, name, grows })
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
}

// The income to replace: committed monthly income with no end date, in the base currency.
export function incomeGoal(snapshot: Snapshot): number {
  let sum = 0
  for (const item of snapshot.doc.plan_items) {
    if (item.kind !== 'income' || item.every !== 'month' || item.ends_on !== null || item.confidence !== 'committed' || isLending(item)) continue
    const currency = currencyOf(snapshot, item.to_account_id)
    sum += (currency === null ? null : toBase(snapshot, item.amount_minor, currency)) ?? 0
  }
  return sum
}

// Top-ups start the month after the last debt is paid, or next month when nothing is owed or the month is not known.
export function topUpStart(snapshot: Snapshot, walk: Walk): { day: string; after_debts: boolean } {
  const free = debtMilestones(snapshot, walk).debt_free.month
  const next = addMonths(`${monthKey(snapshot.as_of)}-01`, 1)
  const after = free ? addMonths(`${free}-01`, 1) : next
  return after > next ? { day: after, after_debts: true } : { day: next, after_debts: false }
}

export function topUps(monthlyMinor: number, from: string, to: string): Injection[] {
  const out: Injection[] = []
  if (monthlyMinor <= 0) return out
  for (let day = from; day <= to; day = addMonths(day, 1)) out.push({ day, minor: monthlyMinor, item_id: null, name: '', grows: true })
  return out
}

export interface Line {
  // The book each day from start, in whole base minor units.
  values: Float64Array
  // The book that pays today's income each month, before any raise.
  base_target: number
  // The book that pays the income on the goal day, or today's when the goal is not reached, and the first day the line reaches it.
  target: number
  goal_day: string | null
}

export interface Projection {
  start: string
  end: string
  buffered: Line
  lossless: Line
  // How much the salary has grown by each day from start.
  raises: Float64Array
}

// The salary's growth each day from start: it steps up each January after today.
function raiseSteps(start: string, days: number, asOf: string, growthPct: number): Float64Array {
  const out = new Float64Array(days).fill(1)
  if (growthPct <= 0) return out
  let year = Number(asOf.slice(0, 4))
  let factor = 1
  for (;;) {
    const from = daysBetween(start, `${++year}-01-01`)
    if (from >= days) return out
    factor *= 1 + growthPct / 100
    out.fill(factor, Math.max(0, from))
  }
}

// The book each day: what is out grows round by round, all of it relent, and each injection joins it on its day; the goal day is the first day it pays the income as it is then.
function line(injections: readonly Injection[], start: string, days: number, lossPct: number, goal: number, rate: number, raises: Float64Array): Line {
  const daily = roundGrowth(lossPct, rate) ** (1 / ROUND_DAYS)
  const yieldPerMonth = monthlyYield(lossPct, rate)
  const base = yieldPerMonth > 0 ? goal / yieldPerMonth : Infinity
  let target = Math.round(base)
  const byDay = new Map<number, number>()
  for (const inj of injections) {
    const i = daysBetween(start, inj.day)
    if (i >= 0 && i < days) byDay.set(i, (byDay.get(i) ?? 0) + inj.minor)
  }
  const values = new Float64Array(days)
  let book = 0
  let goalDay: string | null = null
  for (let i = 0; i < days; i++) {
    book = book * daily + (byDay.get(i) ?? 0)
    // Whole minor units, as every amount the app draws must be; the walk keeps the exact figure.
    values[i] = Math.round(book)
    const need = Math.round(base * (raises[i] ?? 1))
    if (goalDay === null && goal > 0 && book >= need) {
      goalDay = addDays(start, i)
      target = need
    }
  }
  return { values, base_target: Math.round(base), target, goal_day: goalDay }
}

// The book from today, or the first injection if earlier, to YEARS_PAST_GOAL past the buffered goal, or MAX_YEARS when it is not reached.
export function project(injections: readonly Injection[], asOf: string, lossPct: number, goal: number, rate = ROUND_RATE, growthPct = 0): Projection {
  const first = injections[0]?.day
  const start = first !== undefined && first < asOf ? first : asOf
  const cap = daysBetween(start, addMonths(start, MAX_YEARS * 12)) + 1
  const raises = raiseSteps(start, cap, asOf, growthPct)
  const probe = line(injections, start, cap, lossPct, goal, rate, raises)
  const end = probe.goal_day ? addMonths(probe.goal_day, YEARS_PAST_GOAL * 12) : addDays(start, cap - 1)
  const days = daysBetween(start, end) + 1
  const kept = raises.slice(0, days)
  return { start, end, buffered: { ...probe, values: probe.values.slice(0, days) }, lossless: line(injections, start, days, 0, goal, rate, kept), raises: kept }
}

export const valueOn = (p: Projection, l: Line, day: string): number => {
  const i = daysBetween(p.start, day)
  return i < 0 ? 0 : (l.values[Math.min(i, l.values.length - 1)] ?? 0)
}

export type ScheduleLine =
  | { kind: 'lend'; day: string; minor: number; name: string }
  | { kind: 'topup'; day: string; minor: number }
  | { kind: 'relend'; day: string; minor: number; loans: number }
  | { kind: 'milestone'; day: string; share: number; monthly_minor: number }
  | { kind: 'goal'; day: string; monthly_minor: number }

export interface ScheduleMonth {
  month: string
  lines: ScheduleLine[]
}

// What to do and when, month by month, from today to the end of the view: money in, rounds coming back to relend, milestones, and the month the book could pay the income.
export function schedule(injections: readonly Injection[], p: Projection, asOf: string, lossPct: number, rate = ROUND_RATE): ScheduleMonth[] {
  const until = p.end
  const lines: ScheduleLine[] = []
  for (const inj of injections) {
    if (inj.day >= asOf && inj.day <= until) lines.push(inj.item_id !== null ? { kind: 'lend', day: inj.day, minor: inj.minor, name: inj.name } : { kind: 'topup', day: inj.day, minor: inj.minor })
  }
  // Each injection's rounds, summed per day; every round back is relent.
  const growth = roundGrowth(lossPct, rate)
  const back = new Map<string, { minor: number; loans: number }>()
  for (const inj of injections) {
    for (let k = 1; ; k++) {
      const day = addDays(inj.day, k * ROUND_DAYS)
      if (day > until) break
      if (day < asOf) continue
      const at = back.get(day) ?? { minor: 0, loans: 0 }
      back.set(day, { minor: at.minor + inj.minor * growth ** k, loans: at.loans + 1 })
    }
  }
  for (const [day, b] of back) lines.push({ kind: 'relend', day, minor: Math.round(b.minor), loans: b.loans })
  // A share of the way is that share of the book the income takes on the day, raises included.
  const base = p.buffered.base_target
  const monthly = monthlyYield(lossPct, rate)
  for (const share of SHARES) {
    const i = p.buffered.values.findIndex((v, k) => v >= share * base * (p.raises[k] ?? 1))
    const day = i < 0 ? null : addDays(p.start, i)
    if (day !== null && day >= asOf) lines.push({ kind: 'milestone', day, share, monthly_minor: Math.round((p.buffered.values[i] ?? 0) * monthly) })
  }
  if (p.buffered.goal_day && p.buffered.goal_day >= asOf) lines.push({ kind: 'goal', day: p.buffered.goal_day, monthly_minor: Math.round(valueOn(p, p.buffered, p.buffered.goal_day) * monthly) })
  const order = { lend: 0, topup: 1, relend: 2, milestone: 3, goal: 4 } as const
  lines.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : order[a.kind] - order[b.kind]))
  const months: ScheduleMonth[] = []
  for (const l of lines) {
    const month = monthKey(l.day)
    const last = months.at(-1)
    if (last?.month === month) last.lines.push(l)
    else months.push({ month, lines: [l] })
  }
  return months
}

// A month's lines as the table lists them: rounds coming back on several days merge into one line, so a month never runs long.
export type MonthLine = ScheduleLine | { kind: 'relends'; day: string; last: string; minor: number; loans: number }

export function monthLines(lines: readonly ScheduleLine[]): MonthLine[] {
  const back = lines.filter((l) => l.kind === 'relend')
  if (back.length < 2) return [...lines]
  const merged: MonthLine = { kind: 'relends', day: back[0]?.day ?? '', last: back.at(-1)?.day ?? '', minor: back.reduce((s, l) => s + l.minor, 0), loans: back.reduce((s, l) => s + l.loans, 0) }
  const out: MonthLine[] = []
  for (const l of lines) {
    if (l.kind !== 'relend') out.push(l)
    else if (l === back[0]) out.push(merged)
  }
  return out
}

// One row of the schedule table: a year, or a month inside it.
export interface PeriodRow {
  // '2029' for a year, '2029-03' for a month.
  key: string
  put_in_minor: number
  back_minor: number
  // The book at the period's end, and what it would pay a month.
  book_minor: number
  pays_minor: number
  lines: ScheduleLine[]
}

export interface YearRow extends PeriodRow {
  months: PeriodRow[]
}

function period(key: string, lines: ScheduleLine[], book: number, monthly: number): PeriodRow {
  let put = 0
  let back = 0
  for (const l of lines) {
    if (l.kind === 'lend' || l.kind === 'topup') put += l.minor
    else if (l.kind === 'relend') back += l.minor
  }
  return { key, put_in_minor: put, back_minor: back, book_minor: book, pays_minor: Math.max(0, Math.round(book * monthly)), lines }
}

// The schedule as a table: one row a year, each holding the months that have something to do.
export function years(months: readonly ScheduleMonth[], p: Projection, lossPct: number, rate = ROUND_RATE): YearRow[] {
  const monthly = monthlyYield(lossPct, rate)
  const bookAt = (day: string) => valueOn(p, p.buffered, day)
  const out: YearRow[] = []
  for (const mo of months) {
    const year = mo.month.slice(0, 4)
    const row = period(mo.month, mo.lines, bookAt(lastDayOfMonth(mo.month)), monthly)
    const last = out.at(-1)
    if (last?.key === year) last.months.push(row)
    else out.push({ ...period(year, [], 0, monthly), months: [row] })
  }
  return out.map((y) => ({ ...period(y.key, y.months.flatMap((m) => m.lines), bookAt(`${y.key}-12-31`), monthly), months: y.months }))
}

// The book month by month for the charts: today, each month end, then the last day of the view, split into money put in and growth on top, and what it would pay a month.
export interface GrowthSeries {
  days: string[]
  put_in: number[]
  growth: number[]
  pays: number[]
}

export function growthSeries(injections: readonly Injection[], p: Projection, asOf: string, monthly: number): GrowthSeries {
  const days = [asOf]
  for (let day = lastDayOfMonth(asOf); day <= p.end; day = lastDayOfMonth(addMonths(`${monthKey(day)}-01`, 1))) if (day > asOf) days.push(day)
  // The table's last year ends on this day, so the chart does too.
  if (p.end > (days.at(-1) ?? asOf)) days.push(p.end)
  const put_in: number[] = []
  const growth: number[] = []
  const pays: number[] = []
  let k = 0
  let sum = 0
  for (const day of days) {
    while (k < injections.length && (injections[k]?.day ?? '') <= day) sum += injections[k++]?.minor ?? 0
    const book = valueOn(p, p.buffered, day)
    // When losses outrun the return the book sits under what went in, and the area shows only the book.
    put_in.push(Math.min(sum, book))
    growth.push(Math.max(0, book - sum))
    pays.push(Math.max(0, Math.round(book * monthly)))
  }
  return { days, put_in, growth, pays }
}

export interface Inputs {
  loss: number
  // Major units a month; goal null means the committed income in the plan.
  topup: number
  goal: number | null
  rate: number
  // Salary growth in percent a year.
  growth: number
}

export interface LendingModel {
  as_of: string
  currency: string
  goal_minor: number
  // The committed monthly income with no end date, which the goal starts from.
  plan_goal_minor: number
  goal_range: Range
  loss: number
  // Return per round in percent.
  rate: number
  // Salary growth in percent a year, the first raise day, and the income on the goal day with its raises.
  salary_growth: number
  raise_from: string
  goal_then_minor: number
  topup_minor: number
  topup_from: string
  // The top-ups wait for the last debt to be paid.
  topup_after_debts: boolean
  planned: Injection[]
  projection: Projection
  months: ScheduleMonth[]
  years: YearRow[]
  growth: GrowthSeries
  today_minor: number
  // Money put in up to the goal day, or the whole view when the goal is not reached.
  put_in_minor: number
}

// The income slider reaches past the plan's income when it is above the usual top.
export const goalRange = (planMinor: number): Range => ({ ...RANGES.goal, max: Math.max(RANGES.goal.max, Math.ceil(planMinor / 100 / 1000) * 1000) })

// Everything the Lending tab draws; null when no plan item puts money into the book.
export function lendingModel(snapshot: Snapshot, walk: Walk, inputs: Inputs): LendingModel | null {
  const asOf = snapshot.as_of
  const to = addMonths(asOf, MAX_YEARS * 12)
  const planned = plannedInjections(snapshot, to)
  if (planned.length === 0) return null
  const currency = snapshot.doc.household.base_currency
  const rate = inputs.rate / 100
  const topupMinor = Math.round(inputs.topup * 100)
  const start = topUpStart(snapshot, walk)
  const from = start.day
  const injections = withRaises([...planned, ...topUps(topupMinor, from, to)], asOf, inputs.growth).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const planGoal = incomeGoal(snapshot)
  const goal = inputs.goal === null ? planGoal : Math.round(inputs.goal * 100)
  const projection = project(injections, asOf, inputs.loss, goal, rate, inputs.growth)
  const byGoal = projection.buffered.goal_day ?? projection.end
  const months = schedule(injections, projection, asOf, inputs.loss, rate)
  const monthly = monthlyYield(inputs.loss, rate)
  return {
    as_of: asOf,
    currency,
    goal_minor: goal,
    plan_goal_minor: planGoal,
    goal_range: goalRange(planGoal),
    loss: inputs.loss,
    rate: inputs.rate,
    salary_growth: inputs.growth,
    raise_from: `${Number(asOf.slice(0, 4)) + 1}-01-01`,
    goal_then_minor: projection.buffered.goal_day ? Math.round(goal * raiseBy(asOf, projection.buffered.goal_day, inputs.growth)) : goal,
    topup_minor: topupMinor,
    topup_from: from,
    topup_after_debts: start.after_debts,
    planned,
    projection,
    months,
    years: years(months, projection, inputs.loss, rate),
    growth: growthSeries(injections, projection, asOf, monthly),
    today_minor: Math.round(valueOn(projection, projection.buffered, asOf)),
    put_in_minor: injections.filter((i) => i.day <= byGoal).reduce((s, i) => s + i.minor, 0),
  }
}

// Reads a number from the address, kept inside its range and on its step; anything else is the fallback.
export function readNumber<T extends number | null>(raw: string | string[] | undefined, range: Range, fallback: T): number | T {
  const text = Array.isArray(raw) ? raw[0] : raw
  if (text === undefined || text.trim() === '') return fallback
  const n = Number(text)
  if (!Number.isFinite(n)) return fallback
  const snapped = range.min + Math.round((n - range.min) / range.step) * range.step
  return Math.min(range.max, Math.max(range.min, snapped))
}

// A type, not an interface, so the router's params type takes it.
export type InputParams = {
  loss?: string
  topup?: string
  goal?: string
  rate?: string
  growth?: string
}

// ?loss=, ?topup=, ?goal=, ?rate= and ?growth=; the goal's range is only known with the plan, so it is checked loosely here and clamped by the slider.
export function readInputs(params: InputParams): Inputs {
  return {
    loss: readNumber(params.loss, RANGES.loss, DEFAULT_LOSS),
    topup: readNumber(params.topup, RANGES.topup, 0),
    goal: readNumber(params.goal, { ...RANGES.goal, max: 1_000_000 }, null),
    rate: readNumber(params.rate, RANGES.rate, DEFAULT_RATE),
    growth: readNumber(params.growth, RANGES.growth, DEFAULT_GROWTH),
  }
}
