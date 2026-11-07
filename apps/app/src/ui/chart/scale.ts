import { dayFromNumber, dayNumber } from '@waypoint/core'

export const MAX_Y_TICKS = 4
export const MAX_X_LABELS = 5
// Room each date label needs; at 375 pt the plot beside its amount gutter fits up to 5.
export const X_LABEL_SLOT = 38

// One account's daily balances in minor units of the pane's currency; index 0 is startDate.
export interface ChartSeries {
  id: string
  account_id: string
  label: string
  colour: string
  points: ArrayLike<number>
}

// A floor for one account from fromIndex to toIndex, in minor units of the pane's currency.
export interface ChartFloor {
  account_id: string
  fromIndex: number
  toIndex: number
  value: number
}

export interface YTicks {
  min: number
  max: number
  ticks: number[]
}

const STEPS = [1, 2, 2.5, 5] as const

// Ticks at 1, 2, 2.5 or 5 times a power of ten in minor units, round in major units too since every minor unit is a power of ten.
export function niceTicks(lo: number, hi: number, maxTicks: number = MAX_Y_TICKS): YTicks {
  const most = Math.max(2, maxTicks)
  if (!(hi > lo)) {
    const pad = Math.max(100, Math.round(Math.abs(lo) * 0.1))
    return niceTicks(lo - pad, lo + pad, most)
  }
  // The first step that fits starts the search; a slightly larger one can still give a tighter range, so the tightest wins, then the most ticks.
  let best: YTicks | null = null
  const first = Math.max(0, Math.floor(Math.log10((hi - lo) / most)))
  for (let exp = first; best === null || exp <= first + 2; exp++) {
    for (const s of STEPS) {
      const step = s * 10 ** exp
      if (!Number.isInteger(step)) continue
      const min = Math.floor(lo / step) * step + 0
      const max = Math.ceil(hi / step) * step + 0
      const count = Math.round((max - min) / step) + 1
      if (count > most) continue
      const range = max - min
      if (best === null || range < best.max - best.min || (range === best.max - best.min && count > best.ticks.length)) best = { min, max, ticks: Array.from({ length: count }, (_, i) => min + i * step) }
    }
  }
  return best ?? { min: lo, max: hi, ticks: [lo, hi] }
}

export function xLabelCount(plotWidth: number): number {
  return Math.max(2, Math.min(MAX_X_LABELS, Math.floor(plotWidth / X_LABEL_SLOT)))
}

export type TickUnit = 'day' | 'month' | 'year'

export interface DateTick {
  index: number
  day: string
  unit: TickUnit
}

const DAY_STEPS = [1, 2, 7, 14] as const
const MONTH_STEPS = [1, 2, 3, 6] as const
const YEAR_STEPS = [1, 2, 5, 10, 20] as const

// Days anchored on the 1st (1, 8, 15, 22, 29 for a week); a tick closer than half a step to the next is dropped.
function dayTicks(start: number, length: number, step: number): DateTick[] {
  const ticks: DateTick[] = []
  for (let i = 0; i < length; i++) {
    const day = dayFromNumber(start + i)
    if ((Number(day.slice(8, 10)) - 1) % step === 0) ticks.push({ index: i, day, unit: 'day' })
  }
  return ticks.filter((t, i) => {
    const next = ticks[i + 1]
    return !next || next.index - t.index >= step / 2
  })
}

// Firsts of months, anchored on January; a year tick is a 1 January.
function monthTicks(start: number, length: number, step: number, unit: 'month' | 'year'): DateTick[] {
  const first = dayFromNumber(start)
  const ticks: DateTick[] = []
  let year = Number(first.slice(0, 4))
  let month = Number(first.slice(5, 7)) + (first.endsWith('-01') ? 0 : 1)
  for (;;) {
    if (month > 12) [year, month] = [year + 1, 1]
    const day = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`
    const index = dayNumber(day) - start
    if (index >= length) return ticks
    const on = unit === 'month' ? (month - 1) % step === 0 : month === 1 && year % step === 0
    if (on) ticks.push({ index, day, unit })
    month += 1
  }
}

// The finest of days, months and years that fits maxLabels.
export function dateTicks(startDay: string, length: number, maxLabels: number): DateTick[] {
  const start = dayNumber(startDay)
  for (const step of DAY_STEPS) {
    // A rough count first, so a long span never walks every day.
    if (length / step > maxLabels + 1) continue
    const ticks = dayTicks(start, length, step)
    if (ticks.length <= maxLabels) return ticks
  }
  for (const step of MONTH_STEPS) {
    const ticks = monthTicks(start, length, step, 'month')
    if (ticks.length <= maxLabels) return ticks
  }
  for (const step of YEAR_STEPS) {
    const ticks = monthTicks(start, length, step, 'year')
    if (ticks.length <= maxLabels) return ticks
  }
  return []
}

const formats = new Map<string, Intl.DateTimeFormat>()

const FORMATS: Record<'day' | 'dayYear' | 'month' | 'year' | 'monthYear' | 'long', Intl.DateTimeFormatOptions> = {
  day: { day: 'numeric', month: 'short' },
  dayYear: { day: 'numeric', month: 'short', year: 'numeric' },
  month: { month: 'short' },
  year: { year: 'numeric' },
  monthYear: { month: 'short', year: 'numeric' },
  long: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
}

function dateFormat(locale: string, kind: keyof typeof FORMATS): Intl.DateTimeFormat {
  const key = `${locale}|${kind}`
  let fmt = formats.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { ...FORMATS[kind], timeZone: 'UTC' })
    formats.set(key, fmt)
  }
  return fmt
}

const utc = (day: string) => new Date(`${day}T00:00:00Z`)

// '8 Oct' for days; 'Oct' for months, with January named by its year; '2027' for years.
export function tickLabel(tick: DateTick, locale: string): string {
  const january = tick.day.slice(5, 7) === '01'
  const kind = tick.unit === 'day' ? 'day' : tick.unit === 'year' || january ? 'year' : 'month'
  return dateFormat(locale, kind).format(utc(tick.day))
}

// The readout's date: 'Fri, 9 Oct 2026' in en-GB.
export function readoutDay(day: string, locale: string): string {
  return dateFormat(locale, 'long').format(utc(day))
}

// A table row's date: '9 Oct' for a day (short, so three accounts fit beside it on a phone), 'Oct 2026' for a month.
export function rowLabel(day: string, unit: 'day' | 'month', locale: string): string {
  return dateFormat(locale, unit === 'day' ? 'day' : 'monthYear').format(utc(day))
}

// The ends of the days in view: '3 Mar 2027' each when they are days apart, 'Mar 2027' each when months apart.
export function spanEnds(first: string, last: string, unit: 'day' | 'month', locale: string): [string, string] {
  const fmt = dateFormat(locale, unit === 'day' ? 'dayYear' : 'monthYear')
  return [fmt.format(utc(first)), fmt.format(utc(last))]
}

export function dayAt(startDay: string, index: number): string {
  return dayFromNumber(dayNumber(startDay) + index)
}

// Spreads labels wanted at `wanted` (centres) so none overlap, keeping their order and staying inside [top, bottom] where they fit.
export function dodge(wanted: readonly number[], heights: readonly number[], top: number, bottom: number): number[] {
  const order = wanted.map((_, i) => i).sort((a, b) => (wanted[a] as number) - (wanted[b] as number) || a - b)
  const h = (i: number) => heights[order[i] as number] as number
  const y = order.map((i) => wanted[i] as number)
  for (let k = 0; k < y.length; k++) {
    const min = k === 0 ? top + h(0) / 2 : (y[k - 1] as number) + (h(k - 1) + h(k)) / 2
    y[k] = Math.max(y[k] as number, min)
  }
  for (let k = y.length - 1; k >= 0; k--) {
    const max = k === y.length - 1 ? bottom - h(k) / 2 : (y[k + 1] as number) - (h(k) + h(k + 1)) / 2
    y[k] = Math.min(y[k] as number, max)
  }
  const out = new Array<number>(wanted.length)
  order.forEach((i, k) => (out[i] = y[k] as number))
  return out
}

// Each floor drawn with the line of its own account, matched by account_id; a floor whose account is not in the pane is left out.
export function floorOverlays(series: readonly ChartSeries[], floors: readonly ChartFloor[]): { floor: ChartFloor; series: number }[] {
  const byAccount = new Map<string, number>()
  series.forEach((s, i) => {
    if (!byAccount.has(s.account_id)) byAccount.set(s.account_id, i)
  })
  return floors.flatMap((floor) => {
    const at = byAccount.get(floor.account_id)
    return at === undefined ? [] : [{ floor, series: at }]
  })
}

export interface PaneInput<S extends ChartSeries> {
  currency: string
  series: S
}

export interface Pane<S extends ChartSeries> {
  currency: string
  series: S[]
  floors: ChartFloor[]
}

// One pane per currency, never a blended axis: each line joins its currency's pane and each floor its account's pane.
export function panesByCurrency<S extends ChartSeries>(lines: readonly PaneInput<S>[], floors: readonly ChartFloor[]): Pane<S>[] {
  const panes = new Map<string, Pane<S>>()
  const paneOf = new Map<string, Pane<S>>()
  for (const { currency, series } of lines) {
    let pane = panes.get(currency)
    if (!pane) panes.set(currency, (pane = { currency, series: [], floors: [] }))
    pane.series.push(series)
    if (!paneOf.has(series.account_id)) paneOf.set(series.account_id, pane)
  }
  for (const floor of floors) paneOf.get(floor.account_id)?.floors.push(floor)
  return [...panes.values()]
}
