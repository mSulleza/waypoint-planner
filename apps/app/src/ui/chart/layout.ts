import { formatMoney } from '@waypoint/core'
import { SPACE, SWATCH as IDENTITY_SWATCH } from '../tokens'
import type { ChartFloor, ChartSeries } from './scale'

// Sizes the lazy wrapper reserves before the plot's code arrives, so nothing below the chart moves when it draws.
export const PLOT_HEIGHT = 200
const PLOT_MAX_HEIGHT = 280
// The band above the data that holds 'Past' and 'Today', then room for half the top tick's label, centred on its gridline.
export const TOP_BAND = 16
export const TICK_ROOM = 8
export const PLOT_BOTTOM_PAD = 8
// Amount labels sit in a gutter left of the plot, so the past band, the today rule and the floor icons never cover them.
export const AXIS_FONT = 11
export const AXIS_LINE_HEIGHT = 13
export const AXIS_GAP = SPACE[2]
export const X_AXIS_HEIGHT = 20
export const READOUT_DATE_HEIGHT = 18
export const READOUT_ROW_HEIGHT = 20
export const READOUT_ROW_GAP = 4
export const CHART_GAP = SPACE[2]
// Space between the plot's right edge and the account labels.
export const LABEL_GAP = SPACE[2]
export const SWATCH = IDENTITY_SWATCH.size
export const LABEL_LINE_HEIGHT = 16
const LABEL_FONT = 12
const LABEL_MIN_WIDTH = 56
const LABEL_MAX_SHARE = 0.25
// The label column never takes the plot below this.
const PLOT_MIN_WIDTH = 120

// An estimate that holds for Instrument Sans (0.52 em a character on average) and the platform fonts; layout only, never used to clip text.
export function textWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.56)
}

// 200 pt on phones; a wide pane grows taller so the lines keep their slope, up to 280.
export function plotHeightFor(width: number): number {
  return Math.max(PLOT_HEIGHT, Math.min(PLOT_MAX_HEIGHT, Math.round(width * 0.4)))
}

export const UNDER_FLOOR = 'Under floor'
// Between a readout cell's swatch, name, status and amount; after each cell when cells sit side by side.
export const READOUT_PART_GAP = SPACE[2]
export const READOUT_COLUMN_GAP = SPACE[6]
const READOUT_MAX_COLUMNS = 3
const READOUT_NAME_FONT = 13
const READOUT_AMOUNT_FONT = 15
// StatusText at caption size: a 13 pt icon, a 4 pt gap, then the word.
const READOUT_STATUS_WIDTH = 13 + SPACE[1] + textWidth(UNDER_FLOOR, 12)

export interface ReadoutCell {
  label: string
  // The account has a floor in this pane, so its cell may show 'Under floor'.
  floor: boolean
}

export interface ReadoutFit {
  cells: ReadoutCell[]
  // The widest amount any day can show, unmasked, so the eye never changes the layout.
  amount: string
}

export function readoutFit(series: readonly ChartSeries[], floors: readonly ChartFloor[], currency: string, locale: string): ReadoutFit {
  let lo = 0
  let hi = 0
  for (const s of series)
    for (let i = 0; i < s.points.length; i++) {
      const v = s.points[i] as number
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  const [a, b] = [formatMoney(lo, currency, locale), formatMoney(hi, currency, locale)]
  const floored = new Set(floors.map((f) => f.account_id))
  return { cells: series.map((s) => ({ label: s.label, floor: floored.has(s.account_id) })), amount: a.length > b.length ? a : b }
}

// The width a cell needs with nothing cut: swatch, the whole name, 'Under floor' on a floor's account, and the widest amount.
export function readoutCellWidth({ cells, amount }: ReadoutFit): number {
  const money = textWidth(amount, READOUT_AMOUNT_FONT)
  return Math.max(0, ...cells.map((c) => SWATCH + READOUT_PART_GAP + textWidth(c.label, READOUT_NAME_FONT) + (c.floor ? READOUT_PART_GAP + READOUT_STATUS_WIDTH : 0) + READOUT_PART_GAP + money))
}

// Cells sit side by side, up to 3, only while each keeps its whole name, status word and amount; otherwise one per row.
export function readoutColumns(width: number, fit: ReadoutFit): number {
  const fits = Math.floor(width / (readoutCellWidth(fit) + READOUT_COLUMN_GAP))
  return Math.max(1, Math.min(READOUT_MAX_COLUMNS, fit.cells.length, fits))
}

export function readoutHeight(width: number, fit: ReadoutFit): number {
  const rows = Math.ceil(fit.cells.length / readoutColumns(width, fit))
  return READOUT_DATE_HEIGHT + READOUT_ROW_GAP + rows * READOUT_ROW_HEIGHT + Math.max(0, rows - 1) * READOUT_ROW_GAP
}

// The gutter's width: the widest amount label and the gap before the plot. Tabular digits and currency signs run wider than textWidth's average letter.
export function axisWidth(labels: readonly string[]): number {
  return Math.max(0, ...labels.map((l) => Math.ceil(l.length * AXIS_FONT * 0.66))) + AXIS_GAP
}

// Account labels sit right of the plot in at most a quarter of the width, wrapping onto a second line rather than squeezing the plot under its minimum.
export function labelColumnWidth(labels: readonly string[], width: number, gutter = 0): number {
  const widest = Math.max(0, ...labels.map((l) => textWidth(l, LABEL_FONT))) + SWATCH + SPACE[1]
  const cap = Math.max(LABEL_MIN_WIDTH, Math.min(Math.round(width * LABEL_MAX_SHARE), width - gutter - PLOT_MIN_WIDTH - LABEL_GAP))
  return Math.max(LABEL_MIN_WIDTH, Math.min(widest, cap))
}

export function labelLines(label: string, column: number): number {
  return Math.max(1, Math.ceil(textWidth(label, LABEL_FONT) / Math.max(1, column - SWATCH - SPACE[1])))
}

export interface ChartBox {
  width: number
  readout: ReadoutFit
  plotHeight: number
  minTarget: number
}

// Everything under the title: readout, plot, date axis and the 'View as table' button.
export function chartHeight({ width, readout, plotHeight, minTarget }: ChartBox): number {
  return readoutHeight(width, readout) + plotHeight + X_AXIS_HEIGHT + minTarget + 3 * CHART_GAP
}

const TABLE_FONT = 13
export const TABLE_FIRST_PAD = SPACE[3]
export const TABLE_VALUE_PAD = SPACE[2]
const TABLE_VALUE_MAX = 128

export interface TableColumns {
  first: number
  value: number
  // Too wide for the card even at its narrowest, so the table scrolls sideways and says so.
  scrolls: boolean
}

// The date column fits its longest label; each amount column fits the widest amount and the longest word of its heading, then they share the card's width up to 128.
export function tableColumns(width: number, longestLabel: string, widestAmount: string, names: readonly string[]): TableColumns {
  const first = textWidth(longestLabel, TABLE_FONT) + TABLE_FIRST_PAD
  const words = names.flatMap((n) => n.split(/\s+/))
  const value = Math.max(textWidth(widestAmount, TABLE_FONT), ...words.map((w) => SWATCH + SPACE[1] + textWidth(w, TABLE_FONT))) + TABLE_VALUE_PAD
  const count = Math.max(1, names.length)
  if (first + value * count > width) return { first, value, scrolls: true }
  return { first, value: Math.max(value, Math.min(TABLE_VALUE_MAX, Math.floor((width - first) / count))), scrolls: false }
}
