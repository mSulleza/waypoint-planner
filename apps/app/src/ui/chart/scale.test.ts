import { describe, expect, it } from 'vitest'
import { dateTicks, dodge, floorOverlays, niceTicks, panesByCurrency, readoutDay, tickLabel, xLabelCount, type ChartSeries } from './scale'

const line = (id: string, account_id = id): ChartSeries => ({ id, account_id, label: id, colour: '#000000', points: [1, 2, 3] })

describe('niceTicks', () => {
  it('puts at most 4 ticks on round steps that cover the data', () => {
    expect(niceTicks(36000, 529200)).toEqual({ min: 0, max: 600000, ticks: [0, 200000, 400000, 600000] })
    expect(niceTicks(28667, 858649)).toEqual({ min: 0, max: 1000000, ticks: [0, 500000, 1000000] })
    expect(niceTicks(-29336, 350767)).toEqual({ min: -200000, max: 400000, ticks: [-200000, 0, 200000, 400000] })
  })

  it('opens a flat line around its value instead of dividing by zero', () => {
    expect(niceTicks(50000, 50000)).toEqual({ min: 45000, max: 55000, ticks: [45000, 50000, 55000] })
    expect(niceTicks(0, 0).ticks).toEqual([-100, 0, 100])
  })

  it('keeps 2 to 4 evenly spaced ticks on 1, 2, 2.5 or 5 times a power of ten, around every range', () => {
    let s = 5
    const next = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296
    for (let run = 0; run < 2000; run++) {
      const a = Math.round((next() - 0.3) * 10 ** (1 + Math.floor(next() * 9)))
      const b = a + Math.round(next() * 10 ** Math.floor(next() * 9))
      const { min, max, ticks } = niceTicks(a, b)
      expect(ticks.length).toBeGreaterThanOrEqual(2)
      expect(ticks.length).toBeLessThanOrEqual(4)
      expect(min).toBeLessThanOrEqual(a)
      expect(max).toBeGreaterThanOrEqual(b)
      const step = (ticks[1] as number) - (ticks[0] as number)
      ticks.forEach((t, i) => expect(t).toBe(min + i * step))
      expect([1, 2, 2.5, 5]).toContain(step / 10 ** Math.floor(Math.log10(step)))
    }
  })
})

describe('dateTicks', () => {
  const labels = (start: string, length: number, max: number, locale = 'en-GB') => dateTicks(start, length, max).map((t) => tickLabel(t, locale))

  it('labels a month by weeks from the 1st', () => {
    expect(labels('2026-10-01', 31, 5)).toEqual(['1 Oct', '8 Oct', '15 Oct', '22 Oct', '29 Oct'])
    expect(labels('2026-10-01', 31, 5, 'en-US')).toEqual(['Oct 1', 'Oct 8', 'Oct 15', 'Oct 22', 'Oct 29'])
  })

  it('drops a week tick that would crowd the 1st of the next month', () => {
    expect(labels('2026-10-15', 30, 5)).toEqual(['15 Oct', '22 Oct', '1 Nov', '8 Nov'])
  })

  it('labels a year by quarters, naming January by its year', () => {
    expect(labels('2026-04-01', 365, 5)).toEqual(['Apr', 'Jul', 'Oct', '2027'])
  })

  it('labels five years by years, and every other year when only 4 fit', () => {
    expect(labels('2025-10-01', 1826, 5)).toEqual(['2026', '2027', '2028', '2029', '2030'])
    expect(labels('2025-10-01', 1826, 4)).toEqual(['2026', '2028', '2030'])
  })

  it('never gives more labels than asked and places each at its day', () => {
    for (const length of [2, 7, 31, 62, 90, 365, 800, 1826, 3650])
      for (const max of [2, 3, 4, 5]) {
        const ticks = dateTicks('2026-10-09', length, max)
        expect(ticks.length, `${length} days, ${max} labels`).toBeLessThanOrEqual(max)
        for (const t of ticks) expect(t.index).toBeLessThan(length)
      }
  })

  it('fits 5 date labels in a plot from 220 pt and never fewer than 2', () => {
    expect([xLabelCount(100), xLabelCount(176), xLabelCount(220), xLabelCount(640)]).toEqual([2, 4, 5, 5])
  })

  it('writes the readout day in the household locale', () => {
    expect(readoutDay('2026-10-09', 'en-GB')).toBe('Fri, 9 Oct 2026')
  })
})

describe('dodge', () => {
  it('spreads labels that would overlap, keeping their order and staying in bounds', () => {
    const y = dodge([50, 52, 51, 180], [16, 16, 32, 16], 0, 200)
    const placed = [0, 1, 2, 3].map((i) => ({ i, top: (y[i] as number) - [16, 16, 32, 16][i]! / 2, bottom: (y[i] as number) + [16, 16, 32, 16][i]! / 2 })).sort((a, b) => a.top - b.top)
    expect(placed.map((p) => p.i)).toEqual([0, 2, 1, 3])
    for (let k = 1; k < placed.length; k++) expect(placed[k]!.top).toBeGreaterThanOrEqual(placed[k - 1]!.bottom - 1e-9)
    expect(placed[0]!.top).toBeGreaterThanOrEqual(0)
    expect(placed.at(-1)!.bottom).toBeLessThanOrEqual(200)
  })

  it('pushes labels up from the bottom edge', () => {
    expect(dodge([195, 198], [16, 16], 0, 200)).toEqual([176, 192])
  })
})

describe('floors and panes are matched by key', () => {
  it('draws each floor with its own account in any order and leaves out a floor whose account is not in the pane', () => {
    const series = [line('a'), line('b'), line('c')]
    const floors = [
      { account_id: 'c', fromIndex: 0, toIndex: 2, value: 1 },
      { account_id: 'x', fromIndex: 0, toIndex: 2, value: 1 },
      { account_id: 'a', fromIndex: 1, toIndex: 2, value: 2 },
    ]
    expect(floorOverlays(series, floors).map((o) => [o.floor.account_id, o.series])).toEqual([
      ['c', 2],
      ['a', 0],
    ])
  })

  it('puts each currency in its own pane, never one axis, and each floor in its account pane', () => {
    const panes = panesByCurrency(
      [
        { currency: 'EUR', series: line('main') },
        { currency: 'PHP', series: line('pesos') },
        { currency: 'EUR', series: line('savings') },
      ],
      [
        { account_id: 'pesos', fromIndex: 0, toIndex: 2, value: 4000000 },
        { account_id: 'main', fromIndex: 0, toIndex: 2, value: 50000 },
        { account_id: 'gone', fromIndex: 0, toIndex: 2, value: 1 },
      ],
    )
    expect(panes.map((p) => [p.currency, p.series.map((s) => s.id), p.floors.map((f) => f.account_id)])).toEqual([
      ['EUR', ['main', 'savings'], ['main']],
      ['PHP', ['pesos'], ['pesos']],
    ])
  })
})
