import { addDays, daysBetween } from '@waypoint/core'
import type { ChartFloor } from '@/ui/chart/scale'

// Made-up euro accounts for the kitchen's chart and perf.ts: pay on the 25th, rent on the 1st, a car repair in December, a floor under Everyday from today.
export const SAMPLE_START = '2025-10-01'
export const SAMPLE_DAYS = 1826
export const SAMPLE_TODAY = '2026-10-09'
export const SAMPLE_FLOOR = 50000

export type SampleSpan = 'month' | 'year' | 'plan'

export interface SampleLine {
  id: string
  account_id: string
  label: string
  points: number[]
}

export interface ChartSample {
  startDate: string
  todayIndex: number
  lines: SampleLine[]
  floors: ChartFloor[]
  title: string
  summary: string
}

// A seeded generator, so every run draws the same lines.
function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function walk(): SampleLine[] {
  const next = random(7)
  const everyday: number[] = []
  const savings: number[] = []
  const joint: number[] = []
  let [e, s, j] = [290000, 380000, 40000]
  for (let i = 0; i < SAMPLE_DAYS; i++) {
    const day = addDays(SAMPLE_START, i)
    const date = Number(day.slice(8, 10))
    const month = Number(day.slice(5, 7))
    if (date === 1) [e, j] = [e - 95000, j + 80000]
    if (date === 25) e += 285000
    if (date === 12 && month % 3 === 0) e -= 25000
    if (day === '2026-12-03') e -= 40000
    e -= 3000 + Math.round(next() * 5000)
    if (date === 26 && e > 315000) [s, e] = [s + e - 315000, 315000]
    if (date === 15 && (month === 1 || month === 7)) s -= 80000
    if (date === 5) j -= 32000
    if (date === 15) j -= 24000
    j -= 400 + Math.round(next() * 800)
    everyday.push(e)
    savings.push(s)
    joint.push(j)
  }
  return [
    { id: 'everyday', account_id: 'everyday', label: 'Everyday', points: everyday },
    { id: 'savings', account_id: 'savings', label: 'Savings', points: savings },
    { id: 'joint', account_id: 'joint', label: 'Joint', points: joint },
  ]
}

let walked: SampleLine[] | null = null

const monthName = (day: string, year = false) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: year ? 'numeric' : undefined, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))

const SPANS: Record<SampleSpan, { start: string; length: number }> = {
  month: { start: '2026-12-01', length: 31 },
  year: { start: '2026-04-01', length: 365 },
  plan: { start: SAMPLE_START, length: SAMPLE_DAYS },
}

// 'month' is December, all projected, as Months' Chart draws one month; 'year' is April to March around today; 'plan' is a year of history and four years ahead, as Whole plan draws it.
export function chartSample(span: SampleSpan): ChartSample {
  walked ??= walk()
  const { start: startDate, length } = SPANS[span]
  const from = daysBetween(SAMPLE_START, startDate)
  const todayIndex = daysBetween(startDate, SAMPLE_TODAY)
  const lines = walked.map((l) => ({ ...l, points: l.points.slice(from, from + length) }))
  const floors: ChartFloor[] = [{ account_id: 'everyday', fromIndex: Math.max(0, todayIndex), toIndex: length - 1, value: SAMPLE_FLOOR }]
  const everyday = lines[0]?.points ?? []
  const end = addDays(startDate, length - 1)
  if (span === 'month') {
    const days = everyday.filter((v) => v < SAMPLE_FLOOR).length
    return {
      startDate,
      todayIndex,
      lines,
      floors,
      title: `Everyday is under its floor for ${days} days in ${monthName(startDate)}`,
      summary: `Three accounts in euros through ${monthName(startDate, true)}, all projected. After a car repair on the 3rd, Everyday drops under its floor before payday on the 25th; Joint runs low from mid-month.`,
    }
  }
  const ahead = new Set<string>()
  const under = new Set<string>()
  for (let i = todayIndex; i < length; i++) {
    const month = addDays(startDate, i).slice(0, 7)
    ahead.add(month)
    if ((everyday[i] as number) < SAMPLE_FLOOR) under.add(month)
  }
  return {
    startDate,
    todayIndex,
    lines,
    floors,
    title: `Everyday goes under its floor in ${under.size} of the next ${ahead.size} months`,
    summary: `Three accounts in euros, ${monthName(startDate, true)} to ${monthName(end, true)}. Savings stays highest; Joint runs low before each 1st; Everyday dips under its floor in the days before payday on the 25th.`,
  }
}
