import { describe, expect, it } from 'vitest'
import { abroad } from '../fixtures'
import { plainNames, renderCopy } from '../src/copy'
import { addMonths, monthKey } from '../src/dates'
import { floorSchedule, floorScheduleCopy } from '../src/floor-schedule'
import { floorAndTarget, type FloorWindow } from '../src/schema/rows'
import { buildSnapshot } from '../src/snapshot'

const AS_OF = '2026-10-07'

describe('floor schedule', () => {
  it('derives the floor schedule sentence from the windows, keeping a one-month step', () => {
    const { doc, rates } = abroad(AS_OF)
    const snapshot = buildSnapshot(doc, AS_OF, rates)
    const main = snapshot.doc.accounts.find((a) => a.id === 'main')
    if (main?.kind !== 'cash') throw new Error('abroad has no cash account main')
    const phases = floorSchedule(main.floor_windows, '2026-10')
    expect(phases).toEqual([
      { from_month: '2026-10', to_month: '2026-10', floor_minor: 600000, target_minor: 600000 },
      { from_month: '2026-11', to_month: '2028-11', floor_minor: 300000, target_minor: 600000 },
      { from_month: '2028-12', to_month: null, floor_minor: 600000, target_minor: 600000 },
    ])
    // Every month to the horizon and past it reads the same floor and target as the walk does.
    for (let month = '2026-10'; month <= '2032-12'; month = monthKey(addMonths(`${month}-01`, 1))) {
      const phase = phases.find((p) => p.from_month <= month && (p.to_month === null || month <= p.to_month))
      const { floor, target } = floorAndTarget(main.floor_windows, month)
      expect([month, phase?.floor_minor, phase?.target_minor]).toEqual([month, floor, target])
    }
    expect(renderCopy(floorScheduleCopy(phases, 'EUR'), plainNames(snapshot))).toBe('€6,000.00 in 2026-10, then €3,000.00 with a target of €6,000.00 from 2026-11 to 2028-11, then €6,000.00 from 2028-12')
  })

  it('starts with no floor before the first window and merges neighbours with the same figures', () => {
    const windows: FloorWindow[] = [
      { from_month: '2027-01', to_month: '2027-03', amount_minor: 50000 },
      { from_month: '2027-04', to_month: null, amount_minor: 50000 },
    ]
    const phases = floorSchedule(windows, '2026-10')
    expect(phases).toEqual([
      { from_month: '2026-10', to_month: '2026-12', floor_minor: 0, target_minor: 0 },
      { from_month: '2027-01', to_month: null, floor_minor: 50000, target_minor: 50000 },
    ])
    expect(floorScheduleCopy(phases, 'USD')).toEqual([{ text: 'no floor' }, { text: ' from ' }, { month: '2026-10' }, { text: ' to ' }, { month: '2026-12' }, { text: ', then ' }, { money: { minor: 50000, currency: 'USD' } }, { text: ' from ' }, { month: '2027-01' }])
  })
})
