import { encodeLevers } from '@waypoint/core/compare'
import { describe, expect, it } from 'vitest'
import { chartSpan, leverFragment, monthsState, monthTitle, shortMonth, stepMonth } from './url.model'

describe('monthsState', () => {
  it('reads the month and view from the URL', () => {
    expect(monthsState({ month: '2027-03', view: 'chart' }, '2026-10-07')).toEqual({ month: '2027-03', view: 'chart' })
    expect(monthsState({ month: ['2027-04', '2027-05'], view: 'breakdown' }, '2026-10-07')).toEqual({ month: '2027-04', view: 'breakdown' })
  })

  it('falls back to the current month and To-do from the URL alone, never from the screen size', () => {
    expect(monthsState({}, '2026-10-07')).toEqual({ month: '2026-10', view: 'todo' })
    expect(monthsState({ month: '2027-13', view: 'table' }, '2026-10-07')).toEqual({ month: '2026-10', view: 'todo' })
    expect(monthsState({ month: '2027-3' }, '2026-10-07').month).toBe('2026-10')
  })
})

describe('chartSpan', () => {
  it('shows the whole plan only for span=plan, else the selected month', () => {
    expect([chartSpan('plan'), chartSpan(['plan', 'month']), chartSpan('month'), chartSpan('year'), chartSpan(undefined)]).toEqual(['plan', 'plan', 'month', 'month', 'month'])
  })
})

describe('stepMonth and monthTitle', () => {
  it('steps across years and names the month in the household locale', () => {
    expect(stepMonth('2026-12', 1)).toBe('2027-01')
    expect(stepMonth('2027-03', -1)).toBe('2027-02')
    expect(stepMonth('2027-01', -13)).toBe('2025-12')
    expect(monthTitle('2027-03', 'en-PH')).toBe('March 2027')
    // The hero's figure: short, so 'September 2027' never wraps at 390 pt.
    expect([shortMonth('2027-09', 'en-US'), shortMonth('2027-11', 'en-GB'), shortMonth('2028-03', 'en-PH')]).toEqual(['Sep 2027', 'Nov 2027', 'Mar 2028'])
    expect(monthTitle('2027-03', 'es-ES')).toBe('marzo de 2027')
  })
})

describe('leverFragment', () => {
  it('takes the levers after #l= with or without the #, and nothing else', () => {
    const levers = encodeLevers([{ label: 'Euro 10% weaker', patch: { fx_shift_pct: -0.1 } }])
    expect(leverFragment(`l=${levers}`)).toBe(levers)
    expect(leverFragment(`#l=${levers}`)).toBe(levers)
    expect(leverFragment(`x=1&l=${levers}`)).toBe(levers)
    expect(leverFragment('x=1')).toBeNull()
    expect(leverFragment('l=')).toBeNull()
    expect(leverFragment(undefined)).toBeNull()
  })
})
