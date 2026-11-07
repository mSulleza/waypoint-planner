import { addMonths, dayNumber, firstOfMonth } from '@waypoint/core'
import { downsampleAround, MAX_POINTS, MIN_LINE_POINTS, monthBuckets, type Bucket } from './downsample'
import { axisWidth, LABEL_GAP, LABEL_LINE_HEIGHT, PLOT_BOTTOM_PAD, TICK_ROOM, TOP_BAND, labelColumnWidth, labelLines } from './layout'
import { dateTicks, dayAt, dodge, floorOverlays, niceTicks, xLabelCount, type ChartFloor, type ChartSeries, type DateTick, type YTicks } from './scale'

export interface PlotInput {
  series: readonly ChartSeries[]
  floors: readonly ChartFloor[]
  startDate: string
  todayIndex: number
  width: number
  height: number
  // An amount label as the axis writes it, unmasked, so the gutter fits the widest.
  axisText?: (minor: number) => string
}

export interface PlotLine {
  id: string
  account_id: string
  label: string
  colour: string
  // Up to the today rule (drawn faint) and from it (full strength); SVG path data.
  past: string
  future: string
  // On a span longer than LONG_SPAN_DAYS, each bucket's lowest to highest balance as a soft band, split the same way; '' otherwise.
  past_band: string
  future_band: string
  // Values kept: each bucket's lowest and highest; the pane's lines share MAX_POINTS.
  kept: number
}

// An account's name in the column right of the plot, at its line's end, with its floor's dashed swatch under it when it has one.
export interface PlotLabel {
  key: string
  text: string
  colour: string
  floor: boolean
  top: number
  lines: number
}

// Where one account's line runs under its floor: a polygon closed along the floor, in (index, minor units).
export interface FloorRun {
  from: number
  to: number
  lowest: number
  points: [number, number][]
}

export interface PlotFloor {
  key: string
  account_id: string
  series: number
  colour: string
  x0: number
  x1: number
  y: number
  fills: string[]
  // The centre of one warning icon at the projection's lowest dip under the account's floors; on one floor of the account at most.
  icons: number[]
}

export interface PlotGeometry {
  length: number
  // The amount gutter's width: the plot starts here.
  plotLeft: number
  plotWidth: number
  height: number
  // The top and bottom gridlines.
  top: number
  bottom: number
  labelColumn: { x: number; width: number }
  y: YTicks
  today: number | null
  pastTo: number | null
  lines: PlotLine[]
  labels: PlotLabel[]
  floors: PlotFloor[]
  xTicks: (DateTick & { x: number })[]
  xOf: (index: number) => number
  yOf: (value: number) => number
  indexAt: (x: number) => number
}

// A longer span is drawn month by month: each month's lowest balance as a step, under a band to its highest, so a monthly payday never draws a comb.
export const LONG_SPAN_DAYS = 92
const MONTH_STEPS = [1, 2, 3, 6, 12] as const
const ICON_HALF = 8
const round = (n: number) => Math.round(n * 10) / 10

type Point = [number, number]

function pathOf(points: readonly Point[], xOf: (i: number) => number, yOf: (v: number) => number): string {
  let d = ''
  for (const [i, v] of points) d += `${d ? 'L' : 'M'}${round(xOf(i))} ${round(yOf(v))}`
  return d
}

// The drawn line's value at x: from the left at a step, or from the right, where a vertical step takes its later value.
function valueAt(points: readonly Point[], x: number, side: 'left' | 'right'): number {
  const first = points[0] as Point
  const last = points[points.length - 1] as Point
  if (x <= first[0]) return first[1]
  if (x >= last[0]) return last[1]
  let lo = 0
  let hi = points.length - 1
  // The last point left of x (strictly, or at x from the right), then the next one.
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    const mx = (points[mid] as Point)[0]
    if (side === 'left' ? mx < x : mx <= x) lo = mid
    else hi = mid
  }
  const [ax, av] = points[lo] as Point
  const [bx, bv] = points[hi] as Point
  if (bx === ax) return side === 'left' ? av : bv
  return av + ((bv - av) * (x - ax)) / (bx - ax)
}

// The stretches of the drawn line under `floor` within [from, to], crossing points included, so the fill meets the line exactly.
export function floorRuns(line: readonly Point[], from: number, to: number, floor: number): FloorRun[] {
  if (line.length === 0 || to < from) return []
  const pts: Point[] = [[from, valueAt(line, from, 'right')]]
  for (const p of line) if (p[0] > from && p[0] < to) pts.push(p)
  if (to > from) pts.push([to, valueAt(line, to, 'left')])
  const runs: FloorRun[] = []
  let run: (FloorRun & { low: number }) | null = null
  for (let k = 0; k < pts.length; k++) {
    const [x, v] = pts[k] as Point
    const prev = pts[k - 1]
    if (prev) {
      const [px, pv] = prev
      if (pv < floor !== v < floor) {
        const xc = px + ((floor - pv) / (v - pv)) * (x - px)
        if (v < floor) run = { from: xc, to: xc, lowest: x, low: Infinity, points: [[xc, floor]] }
        else if (run) {
          run.points.push([xc, floor])
          run.to = xc
          runs.push(run)
          run = null
        }
      }
    } else if (v < floor) run = { from: x, to: x, lowest: x, low: Infinity, points: [[x, floor]] }
    if (run && v < floor) {
      run.points.push([x, v])
      if (v < run.low) [run.low, run.lowest] = [v, x]
    }
  }
  if (run) {
    const last = pts[pts.length - 1] as Point
    run.points.push([last[0], floor])
    run.to = last[0]
    runs.push(run)
  }
  return runs.map(({ from: f, to: t, lowest, points }) => ({ from: f, to: t, lowest, points }))
}

function extent(values: ArrayLike<number>): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi]
}

// The index of each 1st of a month after the first day.
export function monthStarts(startDate: string, length: number): number[] {
  const start = dayNumber(startDate)
  const out: number[] = []
  for (let month = addMonths(firstOfMonth(startDate), 1); ; month = addMonths(month, 1)) {
    const index = dayNumber(month) - start
    if (index >= length) return out
    out.push(index)
  }
}

export interface DrawnLine {
  // The line, in (index, minor units); a step per bucket on a long span.
  line: Point[]
  // Calendar buckets on a long span, null when the line is drawn by the day.
  buckets: Bucket[] | null
  kept: number
}

// How each line is drawn: 300 values per pane (spec §8), shared evenly. A long span takes the fewest months per bucket that fit; a short one keeps each bucket's minimum and maximum by the day.
export function drawnLines(series: readonly { points: ArrayLike<number> }[], startDate: string, todayIndex: number): DrawnLine[] {
  const budget = Math.max(MIN_LINE_POINTS, Math.floor(MAX_POINTS / Math.max(1, series.length)))
  let firsts: number[] | null = null
  return series.map(({ points }) => {
    const n = points.length
    if (n > LONG_SPAN_DAYS) {
      firsts ??= monthStarts(startDate, Math.max(...series.map((s) => s.points.length)))
      let buckets: Bucket[] = []
      for (const months of MONTH_STEPS) {
        buckets = monthBuckets(points, firsts.filter((f) => f < n), months)
        if (2 * buckets.length <= budget) break
      }
      const line: Point[] = []
      for (const b of buckets) {
        const v = points[b.lo] as number
        line.push([b.start, v], [Math.min(b.end, n - 1), v])
      }
      return { line, buckets, kept: 2 * buckets.length }
    }
    const indices = downsampleAround(points, todayIndex, budget)
    return { line: indices.map((i): Point => [i, points[i] as number]), buckets: null, kept: indices.length }
  })
}

// The line up to x and from x, sharing the point at x.
function splitAt(line: readonly Point[], x: number): [Point[], Point[]] {
  const at: Point = [x, valueAt(line, x, 'left')]
  return [[...line.filter((p) => p[0] < x), at], [at, ...line.filter((p) => p[0] >= x)]]
}

export function plotGeometry({ series, floors, startDate, todayIndex, width, height, axisText = String }: PlotInput): PlotGeometry {
  const drawn = series.filter((s) => s.points.length > 0)
  const length = Math.max(1, ...drawn.map((s) => s.points.length))
  const overlays = floorOverlays(drawn, floors)

  let lo = Infinity
  let hi = -Infinity
  for (const s of drawn) {
    const [a, b] = extent(s.points)
    lo = Math.min(lo, a)
    hi = Math.max(hi, b)
  }
  for (const { floor } of overlays) [lo, hi] = [Math.min(lo, floor.value), Math.max(hi, floor.value)]
  if (!Number.isFinite(lo)) [lo, hi] = [0, 0]
  const y = niceTicks(lo, hi)

  const plotLeft = axisWidth(y.ticks.map(axisText))
  const columnWidth = labelColumnWidth(
    drawn.map((s) => s.label),
    width,
    plotLeft,
  )
  const plotWidth = Math.max(1, width - plotLeft - columnWidth - LABEL_GAP)
  const top = TOP_BAND + TICK_ROOM
  const bottom = height - PLOT_BOTTOM_PAD
  const xOf = (i: number) => plotLeft + (length <= 1 ? plotWidth / 2 : (i / (length - 1)) * plotWidth)
  const yOf = (v: number) => top + ((y.max - v) / (y.max - y.min)) * (bottom - top)
  const indexAt = (x: number) => Math.max(0, Math.min(length - 1, Math.round(((x - plotLeft) / plotWidth) * (length - 1))))

  const last = length - 1
  const hasToday = todayIndex >= 0 && todayIndex <= last
  const today = hasToday ? xOf(todayIndex) : null
  const pastTo = todayIndex > 0 ? xOf(Math.min(todayIndex, last)) : null

  const ways = drawnLines(drawn, startDate, todayIndex)
  const bandOf = (s: ChartSeries, buckets: Bucket[] | null, part: 'past' | 'future'): string => {
    if (!buckets) return ''
    let d = ''
    for (const b of buckets) {
      let [x0, x1] = [b.start, Math.min(b.end, s.points.length - 1)]
      if (part === 'past') x1 = Math.min(x1, todayIndex)
      else x0 = Math.max(x0, todayIndex)
      const [yTop, yBottom] = [yOf(s.points[b.hi] as number), yOf(s.points[b.lo] as number)]
      if (x1 <= x0 || yBottom - yTop < 0.5) continue
      d += `M${round(xOf(x0))} ${round(yTop)}L${round(xOf(x1))} ${round(yTop)}L${round(xOf(x1))} ${round(yBottom)}L${round(xOf(x0))} ${round(yBottom)}Z`
    }
    return d
  }
  const lines: PlotLine[] = drawn.map((s, k) => {
    const { line, buckets, kept } = ways[k] as DrawnLine
    const [past, future] = todayIndex <= 0 ? [[], line] : todayIndex >= s.points.length - 1 ? [line, []] : splitAt(line, todayIndex)
    return {
      id: s.id,
      account_id: s.account_id,
      label: s.label,
      colour: s.colour,
      past: pathOf(past, xOf, yOf),
      future: pathOf(future, xOf, yOf),
      past_band: todayIndex > 0 ? bandOf(s, buckets, 'past') : '',
      future_band: todayIndex < s.points.length - 1 ? bandOf(s, buckets, 'future') : '',
      kept,
    }
  })

  // Dips on today or later count, as the past band never carries a warning; one icon per account, at its lowest.
  const lowest = new Map<number, { floor: PlotFloor; x: number; value: number }>()
  const plotFloors: PlotFloor[] = overlays.flatMap(({ floor, series: at }, k) => {
    const s = drawn[at] as ChartSeries
    const from = Math.max(0, floor.fromIndex)
    const to = Math.min(floor.toIndex, s.points.length - 1)
    if (to < from) return []
    const runs = floorRuns((ways[at] as DrawnLine).line, from, to, floor.value)
    const fills = runs.map((r) => `${r.points.map(([i, v], n) => `${n ? 'L' : 'M'}${round(xOf(i))} ${round(yOf(v))}`).join('')}Z`)
    const plotted: PlotFloor = { key: `${floor.account_id}:${k}`, account_id: floor.account_id, series: at, colour: s.colour, x0: xOf(from), x1: xOf(to), y: yOf(floor.value), fills, icons: [] }
    for (const r of runs) {
      if (todayIndex > last || r.lowest < todayIndex) continue
      const value = Math.min(...r.points.map((p) => p[1]))
      const best = lowest.get(at)
      if (!best || value < best.value) lowest.set(at, { floor: plotted, x: xOf(r.lowest), value })
    }
    return [plotted]
  })
  for (const { floor, x } of lowest.values()) floor.icons.push(Math.max(plotLeft + ICON_HALF, Math.min(plotLeft + plotWidth - ICON_HALF, x)))

  const floored = new Set(plotFloors.map((f) => f.series))
  const named = drawn.map((s, k) => {
    const line = (ways[k] as DrawnLine).line
    return { key: s.id, text: s.label, colour: s.colour, floor: floored.has(k), at: yOf((line[line.length - 1] as Point)[1]) }
  })
  const lineCounts = named.map((n) => labelLines(n.text, columnWidth) + (n.floor ? 1 : 0))
  const centres = dodge(
    named.map((n) => n.at),
    lineCounts.map((n) => n * LABEL_LINE_HEIGHT),
    TOP_BAND,
    height,
  )
  const labels: PlotLabel[] = named.map(({ key, text, colour, floor }, k) => {
    const lines = lineCounts[k] as number
    return { key, text, colour, floor, top: (centres[k] as number) - (lines * LABEL_LINE_HEIGHT) / 2, lines }
  })

  const xTicks = dateTicks(startDate, length, xLabelCount(plotWidth)).map((t) => ({ ...t, x: xOf(t.index) }))
  return { length, plotLeft, plotWidth, height, top, bottom, labelColumn: { x: plotLeft + plotWidth + LABEL_GAP, width: columnWidth }, y, today, pastTo, lines, labels, floors: plotFloors, xTicks, xOf, yOf, indexAt }
}

// Whether the account is under one of its floors that day.
export function underFloor(floors: readonly ChartFloor[], accountId: string, index: number, value: number): boolean {
  return floors.some((f) => f.account_id === accountId && index >= f.fromIndex && index <= f.toIndex && value < f.value)
}

export interface TableRow {
  day: string
  values: (number | null)[]
}

export interface ChartTable {
  unit: 'day' | 'month'
  rows: TableRow[]
}

export const DAILY_TABLE_DAYS = 62

// 'View as table': each day for spans up to two months; beyond that each month's lowest balance, the figure floors are about.
export function tableOf(series: readonly ChartSeries[], startDate: string): ChartTable {
  const length = Math.max(0, ...series.map((s) => s.points.length))
  const at = (s: ChartSeries, i: number) => (i < s.points.length ? (s.points[i] as number) : null)
  if (length <= DAILY_TABLE_DAYS) return { unit: 'day', rows: Array.from({ length }, (_, i) => ({ day: dayAt(startDate, i), values: series.map((s) => at(s, i)) })) }
  const rows: TableRow[] = []
  let month = ''
  for (let i = 0; i < length; i++) {
    const day = dayAt(startDate, i)
    if (day.slice(0, 7) !== month) {
      month = day.slice(0, 7)
      rows.push({ day, values: series.map(() => null) })
    }
    const row = rows[rows.length - 1] as TableRow
    series.forEach((s, k) => {
      const v = at(s, i)
      const low = row.values[k]
      if (v !== null && (low === null || low === undefined || v < low)) row.values[k] = v
    })
  }
  return { unit: 'month', rows }
}
