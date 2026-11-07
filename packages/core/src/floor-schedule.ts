import { moneyPart, textPart, type Copy, type CopyPart } from './copy'
import { addMonths, monthKey } from './dates'
import { floorAndTarget, type FloorWindow } from './schema/rows'

// One stretch of months with the same floor and target; to_month null runs on with no end.
export interface FloorPhase {
  from_month: string
  to_month: string | null
  floor_minor: number
  target_minor: number
}

// An account's floor policy from `fromMonth` on, read month by month from its windows, so no sentence about it is ever typed by hand.
export function floorSchedule(windows: readonly FloorWindow[], fromMonth: string): FloorPhase[] {
  const from = monthKey(fromMonth)
  const starts = new Set([from])
  for (const w of windows) {
    if (w.from_month > from) starts.add(w.from_month)
    if (w.to_month !== null && w.to_month >= from) starts.add(monthKey(addMonths(`${w.to_month}-01`, 1)))
  }
  const phases: FloorPhase[] = []
  for (const start of [...starts].sort()) {
    const { floor, target } = floorAndTarget(windows, start)
    const last = phases.at(-1)
    if (last && last.floor_minor === floor && last.target_minor === target) continue
    if (last) last.to_month = monthKey(addMonths(`${start}-01`, -1))
    phases.push({ from_month: start, to_month: null, floor_minor: floor, target_minor: target })
  }
  return phases
}

// The schedule as one sentence of floors, targets and month ranges, joined by 'then'.
export function floorScheduleCopy(phases: readonly FloorPhase[], currency: string): Copy {
  const out: CopyPart[] = []
  phases.forEach((p, i) => {
    if (i > 0) out.push(textPart(', then '))
    if (p.floor_minor === 0 && p.target_minor === 0) out.push(textPart('no floor'))
    else {
      out.push(moneyPart(p.floor_minor, currency))
      if (p.target_minor > p.floor_minor) out.push(textPart(' with a target of '), moneyPart(p.target_minor, currency))
    }
    if (p.to_month === null) out.push(textPart(' from '), { month: p.from_month })
    else if (p.to_month === p.from_month) out.push(textPart(' in '), { month: p.from_month })
    else out.push(textPart(' from '), { month: p.from_month }, textPart(' to '), { month: p.to_month })
  })
  return out
}
