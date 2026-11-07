import { describe, expect, it } from 'vitest'
import { chartSample } from '../../dev/chart-sample'
import { MAX_POINTS } from './downsample'
import { plotGeometry } from './plot'
import type { ChartSeries } from './scale'
import { chartDays, dragBy, fullRange, isZoomed, MIN_ZOOM_DAYS, panBy, paneWindow, rangeAt, rangeEnds, shareAt, sliceView, wheelZoom, zoomAt, type DayRange } from './zoom'

// The kitchen's whole plan: 1,826 days from 1 Oct 2025, today at index 373.
const LAST = 1825
const FULL = fullRange(LAST)

const pointsIn = (d: string) => d.split(/[ML]/).filter(Boolean).map((p) => p.split(' ').map(Number) as [number, number])

describe('zoom and pan', () => {
  it('halves the days around the centre and keeps the day under the pointer where it was', () => {
    expect(zoomAt(FULL, 2, 0.5, LAST)).toEqual({ from: 456, to: 1369 })
    expect(zoomAt({ from: 456, to: 1369 }, 2, 0.5, LAST)).toEqual({ from: 684, to: 1141 })
    // At the left edge the first day stays first; at the right edge the last stays last.
    expect(zoomAt({ from: 100, to: 500 }, 2, 0, LAST)).toEqual({ from: 100, to: 300 })
    expect(zoomAt({ from: 100, to: 500 }, 2, 1, LAST)).toEqual({ from: 300, to: 500 })
    expect(zoomAt({ from: 100, to: 300 }, 0.5, 0, LAST)).toEqual({ from: 100, to: 500 })
  })

  it('never shows fewer than 14 days or more than the whole span', () => {
    let range: DayRange = FULL
    for (let k = 0; k < 12; k++) range = zoomAt(range, 2, 0.5, LAST)
    expect(range.to - range.from + 1).toBe(MIN_ZOOM_DAYS)
    expect(zoomAt(range, 2, 0.5, LAST)).toEqual(range)
    expect(zoomAt(FULL, 0.5, 0.3, LAST)).toEqual(FULL)
    // Zooming out near the end stops at the last day and keeps the doubled width.
    expect(zoomAt({ from: 1700, to: 1800 }, 0.5, 0.5, LAST)).toEqual({ from: 1625, to: 1825 })
    expect(rangeAt(50, 3, LAST)).toEqual({ from: 50, to: 63 })
    expect(rangeAt(10.4, 20.6, LAST)).toEqual({ from: 10, to: 31 })
    // A chart shorter than 14 days cannot zoom at all.
    expect(rangeAt(0, 3, 9)).toEqual({ from: 0, to: 9 })
    expect(isZoomed(rangeAt(0, 3, 9), 9)).toBe(false)
    expect([isZoomed(FULL, LAST), isZoomed({ from: 0, to: 1824 }, LAST), isZoomed({ from: 1, to: LAST }, LAST)]).toEqual([false, true, true])
  })

  it('pans by whole days and stops at both ends with the same width', () => {
    expect(panBy({ from: 100, to: 300 }, 50, LAST)).toEqual({ from: 150, to: 350 })
    expect(panBy({ from: 100, to: 300 }, -500, LAST)).toEqual({ from: 0, to: 200 })
    expect(panBy({ from: 1700, to: 1800 }, 400, LAST)).toEqual({ from: 1725, to: 1825 })
    // A finger moving right by half the plot brings in the earlier half of the days in view.
    expect(dragBy({ from: 400, to: 800 }, 150, 300, LAST)).toEqual({ from: 200, to: 600 })
    expect(dragBy({ from: 400, to: 800 }, -600, 300, LAST)).toEqual({ from: 1200, to: 1600 })
    expect(dragBy({ from: 400, to: 800 }, -1200, 300, LAST)).toEqual({ from: 1425, to: 1825 })
    expect([shareAt(40, 40, 200), shareAt(140, 40, 200), shareAt(400, 40, 200), shareAt(0, 40, 200)]).toEqual([0, 0.5, 1, 0])
  })

  it('pinches around the fingers’ centre and pans with it as it moves', () => {
    // Fingers twice as far apart around a quarter of the view: day 500 stays at a quarter.
    expect(zoomAt({ from: 400, to: 800 }, 2, 0.25, LAST)).toEqual({ from: 450, to: 650 })
    // The centre moves to three quarters while they spread, and day 500 follows it.
    expect(zoomAt({ from: 400, to: 800 }, 2, 0.25, LAST, 0.75)).toEqual({ from: 350, to: 550 })
    expect(zoomAt({ from: 0, to: 400 }, 2, 0.25, LAST, 0.5)).toEqual({ from: 0, to: 200 })
  })

  it('zooms a run of wheel turns from where it began, holding the total between all days and 14', () => {
    expect(wheelZoom(FULL, -100, 0.5, LAST)).toEqual({ range: { from: 456, to: 1369 }, total: -100 })
    expect(wheelZoom(FULL, 50, 0.5, LAST)).toEqual({ range: FULL, total: 0 })
    const deep = wheelZoom(FULL, -10000, 0.5, LAST)
    expect(deep.range).toEqual({ from: 906, to: 919 })
    expect(deep.total).toBeCloseTo(-100 * Math.log2(1825 / 13), 9)
    // One notch back from the narrowest view doubles it at once.
    expect(wheelZoom(FULL, deep.total + 100, 0.5, LAST).range).toEqual({ from: 900, to: 926 })
  })
})

describe('the days in view', () => {
  it('shares one range across panes by date, each kept inside its own days', () => {
    expect(
      chartDays([
        { startDate: '2026-12-01', length: 31 },
        { startDate: '2026-12-15', length: 17 },
      ]),
    ).toEqual({ start: '2026-12-01', last: 30 })
    expect(chartDays([{ startDate: '2026-10-11', length: 1847 }])).toEqual({ start: '2026-10-11', last: 1846 })
    expect(chartDays([])).toEqual({ start: '', last: 0 })
    expect(paneWindow({ from: 10, to: 40 }, 0, 1826)).toEqual({ from: 10, to: 40 })
    // A pane that starts on the 15th draws the 15th to the 30th of a view from the 11th to the 31st.
    expect(paneWindow({ from: 10, to: 30 }, 14, 17)).toEqual({ from: 0, to: 16 })
    expect(paneWindow({ from: 0, to: 13 }, 14, 17)).toEqual({ from: 0, to: 0 })
  })

  it('names the view by days up to three months and by months beyond', () => {
    const days = { start: '2025-10-01', last: LAST }
    // en-GB shortens September to Sept.
    expect(rangeEnds(days, { from: 517, to: 729 }, 'en-GB')).toEqual(['Mar 2027', 'Sept 2027'])
    expect(rangeEnds(days, { from: 517, to: 729 }, 'en-US')).toEqual(['Mar 2027', 'Sep 2027'])
    expect(rangeEnds(days, { from: 517, to: 530 }, 'en-GB')).toEqual(['2 Mar 2027', '15 Mar 2027'])
    expect(rangeEnds(days, { from: 517, to: 530 }, 'en-US')).toEqual(['Mar 2, 2027', 'Mar 15, 2027'])
    expect(rangeEnds(days, FULL, 'en-GB')).toEqual(['Oct 2025', 'Sept 2030'])
  })

  it('cuts the series, floors and today to the days in view', () => {
    const sample = chartSample('plan')
    const view = sliceView({ series: sample.lines.map((l) => ({ ...l, colour: '#000000' })), floors: sample.floors, startDate: sample.startDate, todayIndex: sample.todayIndex }, { from: 400, to: 430 })
    expect([view.startDate, view.todayIndex]).toEqual(['2026-11-05', -27])
    expect(view.series.map((s) => s.points.length)).toEqual([31, 31, 31])
    expect(Array.from(view.series[0]?.points ?? [])).toEqual(sample.lines[0]?.points.slice(400, 431))
    expect(sample.floors).toEqual([{ account_id: 'everyday', fromIndex: 373, toIndex: 1825, value: 50000 }])
    expect(view.floors).toEqual([{ account_id: 'everyday', fromIndex: 0, toIndex: 30, value: 50000 }])
    // A floor wholly before the view is left out; a typed array is cut without a copy.
    const typed = new Float64Array([5, 6, 7, 8, 9])
    const cut = sliceView({ series: [{ id: 'a', account_id: 'a', label: 'A', colour: '#000000', points: typed }], floors: [{ account_id: 'a', fromIndex: 0, toIndex: 1, value: 6 }], startDate: '2026-01-30', todayIndex: 1 }, { from: 2, to: 3 })
    expect([Array.from(cut.series[0]?.points ?? []), (cut.series[0]?.points as Float64Array).buffer === typed.buffer, cut.floors, cut.startDate, cut.todayIndex]).toEqual([[7, 8], true, [], '2026-02-01', -1])
  })

  it('draws every day of a zoomed month where the whole plan draws monthly steps, with the date axis in days', () => {
    const sample = chartSample('plan')
    const series: ChartSeries[] = sample.lines.map((l) => ({ ...l, colour: '#000000' }))
    const whole = plotGeometry({ series, floors: sample.floors, startDate: sample.startDate, todayIndex: sample.todayIndex, width: 311, height: 200 })
    expect(whole.lines.map((l) => l.kept)).toEqual([60, 60, 60])
    const view = sliceView({ series, floors: sample.floors, startDate: sample.startDate, todayIndex: sample.todayIndex }, { from: 400, to: 430 })
    const geo = plotGeometry({ ...view, width: 311, height: 200 })
    expect(geo.lines.map((l) => l.kept)).toEqual([31, 31, 31])
    expect([geo.today, geo.pastTo, geo.lines[0]?.past]).toEqual([null, null, ''])
    const everyday = sample.lines[0]?.points ?? []
    const drawn = pointsIn(geo.lines[0]?.future ?? '')
    expect(drawn.map(([, y]) => y)).toEqual(everyday.slice(400, 431).map((v) => Math.round(geo.yOf(v) * 10) / 10))
    expect(geo.xTicks.map((t) => t.day)).toEqual(['2026-11-08', '2026-11-15', '2026-11-22', '2026-12-01'])
    // The floor runs across the whole view.
    expect([geo.floors[0]?.x0, geo.floors[0]?.x1]).toEqual([geo.plotLeft, geo.plotLeft + geo.plotWidth])
  })

  it('keeps each line’s lowest and highest day in view within 300 points a pane, at any zoom', () => {
    const sample = chartSample('plan')
    for (const [count, window] of [
      [3, { from: 373, to: 737 }],
      [12, { from: 380, to: 471 }],
      [12, { from: 900, to: 913 }],
    ] as const) {
      const series: ChartSeries[] = Array.from({ length: count }, (_, k) => {
        const base = sample.lines[k % 3]?.points ?? []
        return { id: `line${k}`, account_id: `line${k}`, label: `Line ${k}`, colour: '#000000', points: base.map((v, i) => v + ((i * (k + 1) * 7919) % 20000)) }
      })
      const view = sliceView({ series, floors: [], startDate: sample.startDate, todayIndex: sample.todayIndex }, window)
      const geo = plotGeometry({ ...view, width: 311, height: 200 })
      expect(geo.lines.reduce((n, l) => n + l.kept, 0), `${count} lines over ${window.from}–${window.to}`).toBeLessThanOrEqual(MAX_POINTS)
      geo.lines.forEach((l, k) => {
        const ys = [...pointsIn(`${l.past}${l.future}`), ...pointsIn(`${l.past_band}${l.future_band}`.replace(/Z/g, ''))].map(([, y]) => y)
        const values = Array.from(view.series[k]?.points ?? [])
        expect([Math.min(...ys), Math.max(...ys)], `${count} lines, ${l.id}`).toEqual([geo.yOf(Math.max(...values)), geo.yOf(Math.min(...values))].map((y) => Math.round(y * 10) / 10))
      })
    }
  })
})
