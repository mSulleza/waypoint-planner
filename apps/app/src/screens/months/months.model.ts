import {
  addDays,
  addMonths,
  daysBetween,
  firstOfMonth,
  floorAndTarget,
  lastDayOfMonth,
  ledgerDays,
  ledgerSum,
  ledgerTotals,
  monthFigures,
  monthKey,
  type Account,
  type MonthWord,
  type Snapshot,
  type Walk,
} from '@waypoint/core'
import { textWidth } from '../../ui/chart/layout'
import type { ChartFloor } from '../../ui/chart/scale'
import { identityIndex, identityOf } from '../../ui/identity'
import { PILL, SPACE, STATUS_FILL, WORD_TONE, type Palette } from '../../ui/tokens'

// Spec §7 Months: a strip of month words, the month per currency and account, and its daily balances.

export const PAST_MONTHS = 12

export type MonthKind = 'past' | 'current' | 'projected'

export interface Chip {
  month: string
  kind: MonthKind
  // The worst word across cash accounts; null for a past month, which reads 'Past'.
  word: MonthWord | null
}

const RANK: Record<MonthWord, number> = { OK: 0, Tight: 1, Short: 2 }

// The cash accounts Months shows, in the household's order; archived ones are left out of every total.
export function cashAccounts(snapshot: Snapshot): Account[] {
  return snapshot.doc.accounts.filter((a) => a.kind === 'cash' && a.archived_at === null).sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1))
}

export function monthKind(month: string, asOf: string): MonthKind {
  const now = monthKey(asOf)
  return month < now ? 'past' : month === now ? 'current' : 'projected'
}

// Short when any account has a day under its floor, Tight when one is under its target only, else OK; a past month has no word (spec §6.8).
export function stripWord(walk: Walk, accountIds: readonly string[], month: string): MonthWord | null {
  if (monthKey(month) < (walk.months[0] ?? '')) return null
  let worst: MonthWord | null = null
  for (const id of accountIds) {
    const word = monthFigures(walk, id, month)?.word ?? null
    if (word !== null && (worst === null || RANK[word] > RANK[worst])) worst = word
  }
  return worst
}

// 12 past months, this one and the 60 the walk projects.
export function strip(snapshot: Snapshot, walk: Walk): Chip[] {
  const ids = cashAccounts(snapshot).map((a) => a.id)
  const first = addMonths(firstOfMonth(snapshot.as_of), -PAST_MONTHS)
  const months = [...Array.from({ length: PAST_MONTHS }, (_, i) => monthKey(addMonths(first, i))), ...walk.months]
  return months.map((month) => ({ month, kind: monthKind(month, snapshot.as_of), word: stripWord(walk, ids, month) }))
}

// A month outside the strip shows its nearest end, so a stale or hand-typed address still opens a month the strip holds.
export function clampMonth(chips: readonly Chip[], month: string): string {
  const first = chips[0]?.month ?? month
  const last = chips.at(-1)?.month ?? month
  return month < first ? first : month > last ? last : month
}

export interface ChipLabel {
  month: string
  // Above the chip: the year where one starts and on the first chip, else 'Now' on this month.
  above: string
  // For screen readers: 'October 2026, this month, OK'.
  label: string
}

export function chipLabels(chips: readonly Chip[], locale: string): ChipLabel[] {
  const short = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
  const long = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return chips.map((c, i) => {
    const date = new Date(`${c.month}-01T00:00:00Z`)
    const year = i === 0 || c.month.endsWith('-01') ? c.month.slice(0, 4) : ''
    const state = c.kind === 'past' ? 'past' : [c.kind === 'current' ? 'this month' : '', c.word ?? ''].filter(Boolean).join(', ')
    return { month: short.format(date), above: year || (c.kind === 'current' ? 'Now' : ''), label: [long.format(date), state].filter(Boolean).join(', ') }
  })
}

const CHIP_PADDING = SPACE[2]
// The word line: a status pill, its icon side, 14 pt icon, 4 pt gap, the word at caption size and its word side.
const WORD_WIDTH = PILL.iconSide + PILL.icon + SPACE[1] + textWidth('Short', 12) + PILL.wordSide
export const CHIP_GAP = SPACE[2]

export type ChipFill = Extract<keyof Palette, 'brandSoft' | 'surface2' | 'bg' | 'surface'>

// The selected month takes a soft Cobalt fill, a hovered or pressed chip surface-2, a past month bg and the rest surface.
export function chipFill(kind: MonthKind, selected: boolean, active: boolean): ChipFill {
  return selected ? 'brandSoft' : active ? 'surface2' : kind === 'past' ? 'bg' : 'surface'
}

// Every word sits in a pill on its own status fill, as on Today's rows; light negative is also under 4.5 to 1 on the picked chip's brand-soft.
export function wordFill(word: MonthWord): keyof Palette {
  return STATUS_FILL[WORD_TONE[word]]
}

// One width for every chip, so the strip knows each chip's place before it draws; wide enough for the longest month name.
export function chipWidth(labels: readonly ChipLabel[]): number {
  const widest = Math.max(WORD_WIDTH, ...labels.map((l) => textWidth(l.month, 15)))
  return Math.ceil((widest + 2 * CHIP_PADDING) / SPACE[1]) * SPACE[1]
}

export interface StripGeometry {
  count: number
  chip: number
  gap: number
  // Space before the first chip and after the last.
  pad: number
}

// The scroll offset that centres chip `index` in a strip `viewport` wide, kept inside the content.
export function centreOffset(g: StripGeometry, index: number, viewport: number): number {
  const content = 2 * g.pad + g.count * g.chip + (g.count - 1) * g.gap
  const want = g.pad + index * (g.chip + g.gap) + g.chip / 2 - viewport / 2
  return Math.round(Math.max(0, Math.min(want, content - viewport)))
}

export interface StripScroll {
  // The month the person picked last, and the last one the strip scrolled to.
  want: string | null
  done: string | null
  width: number
  // The window's width at the last layout: crossing the sidebar's width can drop the strip's offset and leave its own width alone.
  screen: number
}

export const NO_SCROLL: StripScroll = { want: null, done: null, width: 0, screen: 0 }

// A layout says whether the selected month's chip is still in view at the strip's offset, which a resize across the sidebar's width can lose.
export type StripEvent = { type: 'select'; month: string } | { type: 'layout'; width: number; screen?: number; shows?: boolean }

// Whether chip `index` lies wholly inside a strip `viewport` wide scrolled to `offset`.
export function chipShown(g: StripGeometry, index: number, offset: number, viewport: number): boolean {
  const left = g.pad + index * (g.chip + g.gap) - offset
  return left >= 0 && left + g.chip <= viewport
}

// One scroll per selection (rule 183): a pick made before the strip has a width waits for it, and a new strip or window width scrolls only to bring back a selected month that is out of view, without animating; nothing else moves the strip.
export function stripScroll(state: StripScroll, event: StripEvent): { state: StripScroll; scroll: { month: string; width: number; animated: boolean } | null } {
  const next = event.type === 'select' ? { ...state, want: event.month } : { ...state, width: event.width, screen: event.screen ?? state.screen }
  const resized = next.width !== state.width || next.screen !== state.screen
  const lost = event.type === 'layout' && event.shows === false && state.width > 0 && resized && state.done !== null && state.want === state.done
  if (lost && state.done !== null) return { state: next, scroll: { month: state.done, width: event.width, animated: false } }
  if (next.want === null || next.want === next.done || next.width <= 0) return { state: next, scroll: null }
  return { state: { ...next, done: next.want }, scroll: { month: next.want, width: next.width, animated: state.done !== null } }
}

export interface AccountMonth {
  account_id: string
  currency: string
  // A past month reads both from rows; this month opens at the live balance; a later month at the walk's day before it.
  opening_minor: number
  closing_minor: number
  word: MonthWord | null
  // Past months: summed from rows. This month: what the walk adds after today, every part of it from the plan.
  in_minor: number
  out_minor: number
  // This month only: rows already entered for days after today, which the close counts apart from the plan.
  later_rows_minor: number
  // Past months have none of these.
  lowest_minor: number | null
  lowest_on: string | null
  // null when no floor window covers the month; the target only when it is above the floor.
  floor_minor: number | null
  target_minor: number | null
  days_under_floor: number
  days_under_target: number
  // Set when the account opened after the month's first day.
  opened_on: string | null
}

export interface CurrencyGroup {
  currency: string
  accounts: AccountMonth[]
}

export interface MonthSummary {
  month: string
  kind: MonthKind
  // The days the figures cover: this month runs from today.
  from: string
  to: string
  groups: CurrencyGroup[]
}

function byCurrency<T extends { currency: string }>(rows: readonly T[]): { currency: string; rows: T[] }[] {
  const groups: { currency: string; rows: T[] }[] = []
  for (const row of rows) {
    const group = groups.find((g) => g.currency === row.currency)
    if (group) group.rows.push(row)
    else groups.push({ currency: row.currency, rows: [row] })
  }
  return groups
}

// The accounts open by the month's last day.
function openIn(snapshot: Snapshot, month: string): Account[] {
  const last = lastDayOfMonth(month)
  return cashAccounts(snapshot).filter((a) => a.opening_date <= last)
}

const openedOn = (a: Account, month: string) => (a.opening_date > firstOfMonth(month) && monthKey(a.opening_date) === monthKey(month) ? a.opening_date : null)

// This month's walk lines per account, split into plan parts and rows dated after today.
function laterParts(walk: Walk, month: string): Map<string, { in: number; out: number; rows: number }> {
  const parts = new Map<string, { in: number; out: number; rows: number }>()
  for (const l of walk.lines) {
    if (monthKey(l.date) !== month) continue
    const p = parts.get(l.account_id) ?? { in: 0, out: 0, rows: 0 }
    if (l.source === 'row') p.rows += l.amount_minor
    else if (l.amount_minor > 0) p.in += l.amount_minor
    else p.out -= l.amount_minor
    parts.set(l.account_id, p)
  }
  return parts
}

// Every cash account's month: past months from rows alone (spec §6.3), this month live → projected (rule 78), later months from the walk.
export function monthSummary(snapshot: Snapshot, walk: Walk, month: string): MonthSummary {
  const key = monthKey(month)
  const kind = monthKind(key, snapshot.as_of)
  // Lines exist only in a full walk; a metrics walk falls back to the month's sums.
  const later = kind === 'current' && walk.mode === 'full' ? laterParts(walk, key) : null
  const rows = openIn(snapshot, key).map((a): AccountMonth => {
    const base = { account_id: a.id, currency: a.currency, opened_on: openedOn(a, key) }
    if (kind === 'past') {
      const t = ledgerTotals(snapshot, a.id, key)
      const none = { word: null, later_rows_minor: 0, lowest_minor: null, lowest_on: null, floor_minor: null, target_minor: null, days_under_floor: 0, days_under_target: 0 }
      return { ...base, ...none, opening_minor: t.opening_minor, closing_minor: t.closing_minor, in_minor: t.in_minor, out_minor: t.out_minor }
    }
    const f = monthFigures(walk, a.id, key)
    if (!f) throw new Error(`The walk has no ${key} for '${a.id}'`)
    const p = later?.get(a.id) ?? { in: 0, out: 0, rows: 0 }
    return {
      ...base,
      opening_minor: f.opening_minor,
      closing_minor: f.closing_minor,
      word: f.word,
      in_minor: later ? p.in : f.in_minor + f.top_up_in_minor,
      out_minor: later ? p.out : f.out_minor + f.top_up_out_minor,
      later_rows_minor: p.rows,
      lowest_minor: f.lowest_minor,
      lowest_on: f.lowest_on,
      floor_minor: f.floor_set ? f.floor_minor : null,
      target_minor: f.floor_set && f.target_minor > f.floor_minor ? f.target_minor : null,
      days_under_floor: f.days_under_floor,
      days_under_target: f.days_under_target,
    }
  })
  return {
    month: key,
    kind,
    from: kind === 'current' ? snapshot.as_of : firstOfMonth(key),
    to: lastDayOfMonth(key),
    groups: byCurrency(rows).map((g) => ({ currency: g.currency, accounts: g.rows })),
  }
}

export interface PaneLine {
  account_id: string
  // The account's place in the account order, which picks its identity colour here as on every screen.
  colour: number
  // The balance before the first point: the day before the pane starts, or live on the whole plan.
  opening: number
  points: ArrayLike<number>
}

export type Takeaway =
  | { kind: 'under'; account_id: string; on: string }
  | { kind: 'above'; account_ids: string[] }
  | { kind: 'change'; account_ids: string[]; direction: 'up' | 'down' | 'flat' }

export interface Pane {
  currency: string
  lines: PaneLine[]
  floors: ChartFloor[]
  startDate: string
  // Today's index: negative for a later month, past the end for an earlier one.
  todayIndex: number
  // The whole plan names years in its dates.
  span: 'month' | 'plan'
  takeaway: Takeaway
}

const floorOf = (a: Account, month: string): number | null =>
  a.floor_windows.some((w) => w.from_month <= month && (w.to_month === null || month <= w.to_month)) ? floorAndTarget(a.floor_windows, month).floor : null

// The first day a line ends under its floor; else the accounts that have one stay above it; else whether the lines together end higher than they began.
function takeawayOf(lines: readonly PaneLine[], floors: readonly ChartFloor[], startDate: string): Takeaway {
  let under: { account_id: string; at: number } | null = null
  for (const f of floors) {
    const points = lines.find((l) => l.account_id === f.account_id)?.points
    if (!points) continue
    for (let i = Math.max(0, f.fromIndex); i <= Math.min(f.toIndex, points.length - 1); i++) {
      if ((points[i] as number) >= f.value) continue
      if (under === null || i < under.at) under = { account_id: f.account_id, at: i }
      break
    }
  }
  if (under) return { kind: 'under', account_id: under.account_id, on: addDays(startDate, under.at) }
  const floored = lines.filter((l) => floors.some((f) => f.account_id === l.account_id)).map((l) => l.account_id)
  if (floored.length > 0) return { kind: 'above', account_ids: floored }
  const change = lines.reduce((sum, l) => sum + ((l.points[l.points.length - 1] as number | undefined) ?? l.opening) - l.opening, 0)
  return { kind: 'change', account_ids: lines.map((l) => l.account_id), direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' }
}

function panesOf(lines: readonly (PaneLine & { currency: string })[], floors: readonly ChartFloor[], startOf: (currency: string) => string, todayIndexOf: (start: string) => number, span: Pane['span']): Pane[] {
  return byCurrency(lines).map(({ currency, rows }) => {
    const startDate = startOf(currency)
    const own = floors.filter((f) => rows.some((r) => r.account_id === f.account_id))
    const paneLines = rows.map(({ account_id, colour, opening, points }) => ({ account_id, colour, opening, points }))
    return { currency, lines: paneLines, floors: own, startDate, todayIndex: todayIndexOf(startDate), span, takeaway: takeawayOf(paneLines, own, startDate) }
  })
}

// The month's daily balances per currency pane: rows alone before today, the walk from today (spec §6.3), each floor on its own account.
export function monthPanes(snapshot: Snapshot, walk: Walk, month: string): Pane[] {
  const key = monthKey(month)
  const asOf = snapshot.as_of
  const first = firstOfMonth(key)
  const last = lastDayOfMonth(key)
  const accounts = openIn(snapshot, key)
  // A pane starts on the month's first day, or on the day its earliest account opened.
  const starts = new Map(
    byCurrency(accounts).map(({ currency, rows }) => {
      const opened = rows.reduce((d, a) => (a.opening_date < d ? a.opening_date : d), last)
      return [currency, opened > first ? opened : first]
    }),
  )
  const pointsOf = (a: Account): Float64Array => {
    const walked = walk.balances.get(a.id)
    if (!walked) throw new Error(`The walk has no balances for '${a.id}'`)
    const start = starts.get(a.currency) ?? first
    const span = daysBetween(start, last) + 1
    const out = new Float64Array(span)
    const history = Math.min(span, Math.max(0, daysBetween(start, asOf)))
    if (history > 0) out.set(ledgerDays(snapshot, a.id, start, addDays(start, history - 1)))
    if (history < span) out.set(walked.subarray(daysBetween(asOf, addDays(start, history)), daysBetween(asOf, last) + 1), history)
    return out
  }
  const openingOf = (a: Account): number => {
    const before = addDays(starts.get(a.currency) ?? first, -1)
    return before < asOf ? ledgerSum(snapshot, a.id, before) : ((walk.balances.get(a.id) as Float64Array)[daysBetween(asOf, before)] as number)
  }
  const identity = identityIndex(snapshot.doc.accounts)
  const lines = accounts.map((a) => ({ account_id: a.id, currency: a.currency, colour: identityOf(identity, a.id), opening: openingOf(a), points: pointsOf(a) }))
  const floors: ChartFloor[] = []
  for (const [k, a] of accounts.entries()) {
    const value = floorOf(a, key)
    if (value !== null) floors.push({ account_id: a.id, fromIndex: 0, toIndex: (lines[k]?.points.length ?? 1) - 1, value })
  }
  return panesOf(lines, floors, (currency) => starts.get(currency) ?? first, (start) => daysBetween(start, asOf), 'month')
}

// Every walked day of the horizon per currency pane, today first; each run of months with one floor is one floor line. The chart kit downsamples it.
export function planPanes(snapshot: Snapshot, walk: Walk): Pane[] {
  const all = cashAccounts(snapshot)
  const identity = identityIndex(snapshot.doc.accounts)
  const lines = all.map((a) => {
    const points = walk.balances.get(a.id)
    if (!points) throw new Error(`The walk has no balances for '${a.id}'`)
    return { account_id: a.id, currency: a.currency, colour: identityOf(identity, a.id), opening: walk.start.get(a.id) ?? 0, points }
  })
  const floors: ChartFloor[] = []
  const last = walk.days.length - 1
  for (const a of all) {
    const figures = walk.figures.get(a.id) ?? []
    let run: ChartFloor | null = null
    for (const f of figures) {
      const from = Math.max(0, daysBetween(walk.as_of, f.first_day))
      const to = Math.min(last, daysBetween(walk.as_of, f.last_day))
      const value = f.floor_set ? f.floor_minor : null
      if (run && value === run.value) run.toIndex = to
      else {
        if (run) floors.push(run)
        run = value === null ? null : { account_id: a.id, fromIndex: from, toIndex: to, value }
      }
    }
    if (run) floors.push(run)
  }
  return panesOf(lines, floors, () => walk.as_of, () => 0, 'plan')
}

export interface Words {
  name: (accountId: string) => string
  // A date, with its year when the chart spans years.
  day: (day: string, withYear: boolean) => string
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

// The chart's takeaway, read as its heading; no amounts, so the eye has nothing to hide in it.
export function paneTitle(pane: Pane, w: Words): string {
  const t = pane.takeaway
  const year = pane.span === 'plan'
  if (t.kind === 'under') return `${w.name(t.account_id)} goes under its floor on ${w.day(t.on, year)}`
  if (t.kind === 'change') {
    const one = t.account_ids.length === 1
    const who = one ? w.name(t.account_ids[0] ?? '') : `${list(t.account_ids.map(w.name))} together`
    const end = `${who} end${one ? 's' : ''} ${year ? 'the projection' : 'the month'}`
    const since = year ? 'today' : `${one ? 'it' : 'they'} began`
    if (t.direction === 'flat') return year ? `${end} where ${one ? 'it stands' : 'they stand'} today` : `${end} where ${since}`
    return `${end} ${t.direction === 'up' ? 'higher' : 'lower'} than ${since}`
  }
  const names = t.account_ids.map(w.name)
  return names.length === 1 ? `${names[0]} stays above its floor` : `${list(names)} stay above their floors`
}

// What a screen reader hears after the title: whose balances, over which days, what is recorded and what projected.
export function paneSummary(pane: Pane, w: Words): string {
  const first = pane.startDate
  const length = Math.max(0, ...pane.lines.map((l) => l.points.length))
  const end = addDays(first, Math.max(0, length - 1))
  const year = pane.span === 'plan'
  const today = pane.todayIndex
  const when =
    today <= 0
      ? 'all projected'
      : today >= length
        ? 'all recorded'
        : `recorded to ${w.day(addDays(first, today - 1), year)}, projected from ${w.day(addDays(first, today), year)}`
  const floored = [...new Set(pane.floors.map((f) => f.account_id))].map(w.name)
  const floors = floored.length > 0 ? ` Dashed lines mark the floor${floored.length > 1 ? 's' : ''} of ${list(floored)}.` : ''
  return `Daily balances of ${list(pane.lines.map((l) => w.name(l.account_id)))} from ${w.day(first, true)} to ${w.day(end, true)}, ${when}.${floors}`
}
