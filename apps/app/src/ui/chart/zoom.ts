import { addDays, daysBetween } from '@waypoint/core'
import { LONG_SPAN_DAYS } from './plot'
import { dayAt, spanEnds, type ChartFloor, type ChartSeries } from './scale'

// The narrowest view, in days.
export const MIN_ZOOM_DAYS = 14
// A zoom button, + or − halves or doubles the days in view.
export const ZOOM_STEP = 2
// Wheel pixels that halve or double the days in view: one notch of a mouse wheel.
export const WHEEL_STEP = 100

// The days in view as indices into the chart's days, both ends included.
export interface DayRange {
  from: number
  to: number
}

// The days every pane of one chart shares: the first, and the index of the last.
export interface ChartDays {
  start: string
  last: number
}

// One chart's view: every pane draws it, and a gesture on any pane sets it.
export interface ChartZoom {
  days: ChartDays
  range: DayRange
  onRange: (range: DayRange) => void
}

// A pane's days and its own data, indices from its first day.
export interface PlotData {
  series: readonly ChartSeries[]
  floors: readonly ChartFloor[]
  startDate: string
  todayIndex: number
}

export const fullRange = (last: number): DayRange => ({ from: 0, to: Math.max(0, last) })

export const isZoomed = (range: DayRange, last: number): boolean => range.from > 0 || range.to < last

// The narrowest width (to − from): 13 for 14 days, or the whole chart when it is shorter.
export const minWidth = (last: number): number => Math.max(0, Math.min(MIN_ZOOM_DAYS - 1, last))

const widthIn = (width: number, last: number) => Math.max(minWidth(last), Math.min(Math.max(0, last), Math.round(width)))

// Whole days inside the chart, from the narrowest view to all of it; a view pushed past an end keeps its width and stops there.
export function rangeAt(from: number, width: number, last: number): DayRange {
  const w = widthIn(width, last)
  const start = Math.max(0, Math.min(Math.max(0, last) - w, Math.round(from)))
  return { from: start, to: start + w }
}

// Shows `factor` times fewer days (2 halves them); the day at share `at` of the view (0 left, 1 right) moves to share `to`, so it stays put unless a pinch's centre moves.
export function zoomAt(range: DayRange, factor: number, at: number, last: number, to: number = at): DayRange {
  const width = range.to - range.from
  const anchor = range.from + at * width
  const w = widthIn(width / factor, last)
  return rangeAt(anchor - to * w, w, last)
}

export function panBy(range: DayRange, days: number, last: number): DayRange {
  return rangeAt(range.from + days, range.to - range.from, last)
}

// A drag of dx pixels across a plot plotWidth wide moves the days with the finger.
export function dragBy(start: DayRange, dx: number, plotWidth: number, last: number): DayRange {
  return panBy(start, -(dx / Math.max(1, plotWidth)) * (start.to - start.from), last)
}

// Where x falls across the plot, 0 at its left edge and 1 at its right.
export function shareAt(x: number, plotLeft: number, plotWidth: number): number {
  return Math.max(0, Math.min(1, (x - plotLeft) / Math.max(1, plotWidth)))
}

// A run of wheel turns from `start` around share `at`: the total is held between all days and the narrowest view, so turning back answers at once.
export function wheelZoom(start: DayRange, total: number, at: number, last: number): { range: DayRange; total: number } {
  const width = start.to - start.from
  if (width <= 0 || last <= 0) return { range: start, total: 0 }
  const most = WHEEL_STEP * Math.log2(width / Math.max(1, minWidth(last)))
  const least = WHEEL_STEP * Math.log2(last / width)
  const held = Math.max(-most, Math.min(least, total))
  return { range: zoomAt(start, 2 ** (-held / WHEEL_STEP), at, last), total: held }
}

// A pane's days in view: the shared range moved to the pane's own first day and kept inside its data.
export function paneWindow(range: DayRange, offset: number, length: number): DayRange {
  const end = Math.max(0, length - 1)
  const from = Math.max(0, Math.min(end, range.from - offset))
  return { from, to: Math.max(from, Math.min(end, range.to - offset)) }
}

const cut = (points: ArrayLike<number>, from: number, to: number): ArrayLike<number> =>
  ArrayBuffer.isView(points) ? (points as unknown as Float64Array).subarray(from, to + 1) : Array.prototype.slice.call(points, from, to + 1)

// The days in view as a pane of their own, so the plot, readout and table draw them as they draw a whole span.
export function sliceView(data: PlotData, window: DayRange): PlotData {
  const { from, to } = window
  return {
    series: data.series.map((s) => ({ ...s, points: cut(s.points, from, to) })),
    floors: data.floors.filter((f) => f.toIndex >= from && f.fromIndex <= to).map((f) => ({ ...f, fromIndex: Math.max(from, f.fromIndex) - from, toIndex: Math.min(to, f.toIndex) - from })),
    startDate: dayAt(data.startDate, from),
    todayIndex: data.todayIndex - from,
  }
}

// The first day of all panes and the index of the last day any pane draws; no panes, no days.
export function chartDays(panes: readonly { startDate: string; length: number }[]): ChartDays {
  const start = panes.reduce((d, p) => (p.startDate < d ? p.startDate : d), panes[0]?.startDate ?? '')
  return { start, last: Math.max(0, ...panes.map((p) => daysBetween(start, p.startDate) + p.length - 1)) }
}

// The view's first and last day as the zoom controls and the screen reader name them: days up to three months, months beyond.
export function rangeEnds(days: ChartDays, range: DayRange, locale: string): [string, string] {
  return spanEnds(addDays(days.start, range.from), addDays(days.start, range.to), range.to - range.from < LONG_SPAN_DAYS ? 'day' : 'month', locale)
}
