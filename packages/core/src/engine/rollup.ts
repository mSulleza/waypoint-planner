import { daysBetween, monthKey } from '../dates'
import type { MonthFigures, MonthWord, Walk } from './types'

// One cash account's walked days and per-month sums, as the walk leaves them.
export interface DayTrack {
  account_id: string
  start: number
  balances: Float64Array
  // Top-up nets landing per day, for the unfixable gap.
  topUpInByDay: Float64Array | null
  inByMonth: Float64Array
  outByMonth: Float64Array
  topUpInByMonth: Float64Array
  topUpOutByMonth: Float64Array
  floorByMonth: Float64Array
  targetByMonth: Float64Array
  floorSet: Uint8Array
}

// Month figures are sums of days: monthStart[m] is the first walked day of months[m], and monthStart[months.length] the walk's length.
export function rollUp(track: DayTrack, days: readonly string[], months: readonly string[], monthStart: readonly number[]): MonthFigures[] {
  const out: MonthFigures[] = []
  const at = (list: Float64Array, i: number) => list[i] ?? 0
  const { balances, topUpInByDay } = track
  for (let m = 0; m < months.length; m++) {
    const from = monthStart[m] ?? 0
    const to = (monthStart[m + 1] ?? 0) - 1
    const floor = at(track.floorByMonth, m)
    const target = at(track.targetByMonth, m)
    let lowest = Infinity
    let lowestAt = from
    let underFloor = 0
    let underTarget = 0
    let gap = 0
    let later = 0
    // Walked backwards so `later` holds the top-ups landing after each day; a hot loop, so no helper calls.
    for (let i = to; i >= from; i--) {
      const balance = balances[i] ?? 0
      if (balance <= lowest) {
        lowest = balance
        lowestAt = i
      }
      if (balance < floor) underFloor++
      if (balance < target) underTarget++
      if (floor - balance - later > gap) gap = floor - balance - later
      if (topUpInByDay) later += topUpInByDay[i] ?? 0
    }
    out.push({
      account_id: track.account_id,
      month: months[m] ?? '',
      first_day: days[from] ?? '',
      last_day: days[to] ?? '',
      opening_minor: from === 0 ? track.start : at(track.balances, from - 1),
      closing_minor: at(track.balances, to),
      in_minor: at(track.inByMonth, m),
      out_minor: at(track.outByMonth, m),
      top_up_in_minor: at(track.topUpInByMonth, m),
      top_up_out_minor: at(track.topUpOutByMonth, m),
      lowest_minor: lowest,
      lowest_on: days[lowestAt] ?? '',
      floor_minor: floor,
      target_minor: target,
      floor_set: track.floorSet[m] === 1,
      days_under_floor: underFloor,
      days_under_target: underTarget,
      unfixable_gap_minor: gap,
      word: wordFor(underFloor, underTarget),
    })
  }
  return out
}

function wordFor(underFloor: number, underTarget: number): MonthWord {
  return underFloor > 0 ? 'Short' : underTarget > 0 ? 'Tight' : 'OK'
}

const monthNumber = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7))

// A cash account's month in the walk; null for a month before this one, which reads from its rows. A month past the horizon is an error.
export function monthFigures(walk: Walk, accountId: string, month: string): MonthFigures | null {
  const list = walk.figures.get(accountId)
  if (!list) throw new RangeError(`'${accountId}' is not a cash account in this walk`)
  const offset = monthNumber(monthKey(month)) - monthNumber(walk.months[0] ?? '')
  if (offset < 0) return null
  const found = list[offset]
  if (!found) throw new RangeError(`${monthKey(month)} is after the horizon, which ends ${walk.horizon_end}`)
  return found
}

// Short when a day ends below the floor after top-ups, Tight when below the target only, else OK; a past month has no word.
export function monthWord(walk: Walk, accountId: string, month: string): MonthWord | null {
  return monthFigures(walk, accountId, month)?.word ?? null
}

// The lowest and highest end-of-day balance inside one window of walked days, so a chart slice sets its own bounds.
export function balanceRange(walk: Walk, accountId: string, from: string, to: string): { lowest_minor: number; lowest_on: string; highest_minor: number; highest_on: string } | null {
  const balances = walk.balances.get(accountId)
  if (!balances) throw new RangeError(`No account '${accountId}' in this walk`)
  const first = Math.max(0, daysBetween(walk.as_of, from))
  const last = Math.min(walk.days.length - 1, daysBetween(walk.as_of, to))
  if (first > last) return null
  let [low, lowAt, high, highAt] = [Infinity, first, -Infinity, first]
  for (let i = first; i <= last; i++) {
    const b = balances[i] ?? 0
    if (b < low) [low, lowAt] = [b, i]
    if (b > high) [high, highAt] = [b, i]
  }
  return { lowest_minor: low, lowest_on: walk.days[lowAt] ?? '', highest_minor: high, highest_on: walk.days[highAt] ?? '' }
}
