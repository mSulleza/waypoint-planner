import { formatMoney } from '@waypoint/core'
import { describe, expect, it } from 'vitest'
import { chartSample, SAMPLE_FLOOR, type SampleSpan } from '../../dev/chart-sample'
import { MAX_POINTS } from './downsample'
import { chartHeight, plotHeightFor, readoutColumns, readoutFit, readoutHeight, tableColumns, textWidth, UNDER_FLOOR } from './layout'
import { floorRuns, LONG_SPAN_DAYS, plotGeometry, tableOf, underFloor, type PlotGeometry } from './plot'
import { MAX_X_LABELS, MAX_Y_TICKS, rowLabel, type ChartFloor, type ChartSeries } from './scale'
import { sparkGeometry } from './spark'

// A 375 pt phone: 16 pt gutters and the card's 16 pt padding leave 311 pt.
const PHONE = 311

function kitchen(span: SampleSpan, width = PHONE) {
  const sample = chartSample(span)
  const series: ChartSeries[] = sample.lines.map((l) => ({ ...l, colour: `#${l.id.length}00000` }))
  return { sample, series, geo: plotGeometry({ series, floors: sample.floors, startDate: sample.startDate, todayIndex: sample.todayIndex, width, height: 200, axisText: compact }) }
}

const compact = (minor: number) => formatMoney(minor, 'EUR', 'en-GB', { compact: true })

const pointsIn = (d: string) => d.split(/[ML]/).filter(Boolean).map((p) => p.split(' ').map(Number) as [number, number])

// Each drawn corner of a floor's fills that is not on the floor itself, as the day it sits on and its height.
function fillCorners(geo: PlotGeometry, floorAt: number): { day: number; x: number; y: number }[] {
  const floor = geo.floors[floorAt]
  if (!floor) return []
  return floor.fills
    .flatMap((d) => pointsIn(d.replace('Z', '')))
    .filter(([, y]) => Math.abs(y - floor.y) > 0.05)
    .map(([x, y]) => ({ day: Math.round(((x - geo.plotLeft) / geo.plotWidth) * (geo.length - 1)), x, y }))
}

// Whether a point lies on a line as drawn, past or projected.
const onLine = (geo: PlotGeometry, series: number, x: number, y: number) => {
  const l = geo.lines[series]
  return pointsIn(`${l?.past ?? ''}${l?.future ?? ''}`).some(([px, py]) => Math.abs(px - x) < 0.06 && Math.abs(py - y) < 0.06)
}

// The band's rectangles, as their top and bottom heights.
const bandEdges = (d: string) => pointsIn(d.replace(/Z/g, '')).map(([, y]) => y)

describe('the kitchen chart: three accounts in one pane', () => {
  it('draws at most 300 points in the pane, 4 amount ticks and 5 date labels at 375 pt', () => {
    for (const span of ['month', 'year', 'plan'] as const) {
      const { geo } = kitchen(span)
      expect(geo.lines.map((l) => l.id)).toEqual(['everyday', 'savings', 'joint'])
      expect(geo.lines.reduce((n, l) => n + l.kept, 0), span).toBeLessThanOrEqual(MAX_POINTS)
      expect(geo.y.ticks.length).toBeLessThanOrEqual(MAX_Y_TICKS)
      expect(geo.xTicks.length).toBeLessThanOrEqual(MAX_X_LABELS)
      expect(geo.xTicks.length).toBeGreaterThanOrEqual(2)
    }
    expect(kitchen('year').geo.y.ticks).toEqual([0, 250000, 500000])
    // Five years in two-month buckets, each keeping its lowest and highest day.
    expect(kitchen('plan').geo.lines.map((l) => l.kept)).toEqual([60, 60, 60])
    expect(kitchen('month').geo.lines.map((l) => [l.kept, l.future_band])).toEqual([
      [31, ''],
      [31, ''],
      [31, ''],
    ])
  })

  it('draws a long span as each month’s lowest balance under a band to its highest, never a comb of daily dips', () => {
    const { sample, geo } = kitchen('year')
    const everyday = sample.lines[0]?.points ?? []
    expect(everyday.length).toBeGreaterThan(LONG_SPAN_DAYS)
    const line = pointsIn(`${geo.lines[0]?.past}${geo.lines[0]?.future}`)
    // Twelve months of steps: two corners a month, one more where the today rule splits it.
    expect(line.length).toBeLessThanOrEqual(2 * 12 + 2 + 2)
    const firsts = [0, 30, 61, 91, 122, 153, 183, 214, 244, 275, 306, 334, 365]
    for (let m = 0; m < 12; m++) {
      const month = everyday.slice(firsts[m], firsts[m + 1])
      const low = geo.yOf(Math.min(...month))
      const high = geo.yOf(Math.max(...month))
      expect(line.some(([x, y]) => Math.abs(y - Math.round(low * 10) / 10) < 0.06 && x >= geo.xOf(firsts[m] as number) - 0.06), `month ${m} low`).toBe(true)
      expect(bandEdges(`${geo.lines[0]?.past_band}${geo.lines[0]?.future_band}`).some((y) => Math.abs(y - Math.round(high * 10) / 10) < 0.06), `month ${m} high`).toBe(true)
    }
  })

  it('shares the 300 points among up to 12 lines, each keeping its own lowest and highest day', () => {
    const { sample } = kitchen('plan')
    for (const count of [1, 2, 6, 12]) {
      const series: ChartSeries[] = Array.from({ length: count }, (_, k) => {
        const base = sample.lines[k % 3]?.points ?? []
        return { id: `line${k}`, account_id: `line${k}`, label: `Line ${k}`, colour: '#000000', points: base.map((v, i) => v + ((i * (k + 1) * 7919) % 20000)) }
      })
      const geo = plotGeometry({ series, floors: [], startDate: sample.startDate, todayIndex: sample.todayIndex, width: PHONE, height: 200 })
      expect(geo.lines.reduce((n, l) => n + l.kept, 0), `${count} lines`).toBeLessThanOrEqual(MAX_POINTS)
      geo.lines.forEach((l, k) => {
        const ys = [...pointsIn(`${l.past}${l.future}`).map(([, y]) => y), ...bandEdges(`${l.past_band}${l.future_band}`)]
        const values = Array.from(series[k]?.points ?? [])
        expect([Math.min(...ys), Math.max(...ys)], `${count} lines, ${l.id}`).toEqual([geo.yOf(Math.max(...values)), geo.yOf(Math.min(...values))].map((y) => Math.round(y * 10) / 10))
      })
    }
  })

  it('shades only the floor account: Joint runs under the same amount and gets no fill', () => {
    for (const span of ['month', 'year', 'plan'] as const) {
      const { sample, geo } = kitchen(span)
      const [everyday, joint] = [sample.lines[0]?.points ?? [], sample.lines[2]?.points ?? []]
      expect(joint.slice(Math.max(0, sample.todayIndex)).some((v) => v < SAMPLE_FLOOR), `${span}: Joint goes under the floor amount`).toBe(true)
      expect(geo.floors.map((f) => [f.account_id, geo.lines[f.series]?.id])).toEqual([['everyday', 'everyday']])
      const floor = geo.floors[0]
      expect(floor?.fills.length).toBeGreaterThan(0)
      expect(floor?.icons.length).toBeGreaterThan(0)
      expect(floor?.y).toBeCloseTo(geo.yOf(SAMPLE_FLOOR), 6)
      // The fill's lower edge is Everyday's line as drawn, and not Joint's.
      const corners = fillCorners(geo, 0)
      expect(corners.length, span).toBeGreaterThan(0)
      for (const c of corners) {
        expect(c.x).toBeCloseTo(geo.xOf(c.day), 1)
        expect(onLine(geo, 0, c.x, c.y), `${span} day ${c.day}`).toBe(true)
      }
      if (span === 'month') for (const c of corners) expect(c.y).toBeCloseTo(geo.yOf(everyday[c.day] as number), 1)
      expect(corners.some((c) => !onLine(geo, 2, c.x, c.y) && Math.abs(c.y - geo.yOf(joint[c.day] as number)) > 1), span).toBe(true)
    }
  })

  it('fills under each floor along its own account when two accounts have floors', () => {
    for (const span of ['month', 'year', 'plan'] as const) {
      const { sample, series } = kitchen(span)
      const floors: ChartFloor[] = [...sample.floors, { account_id: 'joint', fromIndex: Math.max(0, sample.todayIndex), toIndex: series[2]!.points.length - 1, value: 45000 }]
      const geo = plotGeometry({ series, floors, startDate: sample.startDate, todayIndex: sample.todayIndex, width: PHONE, height: 200 })
      expect(geo.floors.map((f) => [f.account_id, geo.lines[f.series]?.id, f.colour])).toEqual([
        ['everyday', 'everyday', series[0]?.colour],
        ['joint', 'joint', series[2]?.colour],
      ])
      geo.floors.forEach((f, k) => {
        const own = series[f.series]?.points ?? []
        const other = series[k === 0 ? 2 : 0]?.points ?? []
        const corners = fillCorners(geo, k)
        expect(corners.length, `${span} ${f.account_id}`).toBeGreaterThan(0)
        for (const c of corners) {
          expect(onLine(geo, f.series, c.x, c.y), `${span} ${f.account_id} day ${c.day}`).toBe(true)
          if (span === 'month') expect(c.y).toBeCloseTo(geo.yOf(own[c.day] as number), 1)
          expect(c.y).toBeGreaterThan(f.y)
        }
        expect(corners.some((c) => !onLine(geo, k === 0 ? 2 : 0, c.x, c.y) && Math.abs(c.y - geo.yOf(other[c.day] as number)) > 1)).toBe(true)
      })
    }
  })

  it('fills only the days the line is under its floor, inside the floor window', () => {
    const { sample, geo } = kitchen('year')
    const floor = geo.floors[0]
    const everyday = sample.lines[0]?.points ?? []
    expect(floor?.x0).toBeCloseTo(geo.xOf(sample.todayIndex), 6)
    for (const d of floor?.fills ?? []) {
      const pts = pointsIn(d.replace('Z', ''))
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual((floor?.x0 ?? 0) - 0.05)
        expect(y).toBeGreaterThanOrEqual((floor?.y ?? 0) - 0.05)
      }
    }
    const underDays = everyday.map((v, i) => (i >= sample.todayIndex && v < SAMPLE_FLOOR ? i : -1)).filter((i) => i >= 0)
    expect(underDays.length).toBeGreaterThan(0)
    for (const i of underDays) expect(underFloor(sample.floors, 'everyday', i, everyday[i] as number)).toBe(true)
    expect(underFloor(sample.floors, 'joint', underDays[0] as number, 0)).toBe(false)
  })

  it('splits each line at the today rule: history ends where the projection starts', () => {
    const { sample, geo } = kitchen('year')
    expect(geo.today).toBeCloseTo(geo.xOf(sample.todayIndex), 6)
    expect(geo.pastTo).toBe(geo.today)
    for (const l of geo.lines) expect(pointsIn(l.past).at(-1)).toEqual(pointsIn(l.future)[0])
  })

  it('draws a projected month at full strength with no past band or today rule, labelled by weeks', () => {
    const { sample, geo } = kitchen('month')
    expect(sample.todayIndex).toBeLessThan(0)
    expect([geo.today, geo.pastTo]).toEqual([null, null])
    for (const l of geo.lines) expect([l.past, l.kept]).toEqual(['', 31])
    expect(geo.xTicks.map((t) => t.day)).toEqual(['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29'])
    expect(sample.title).toBe('Everyday is under its floor for 8 days in December')
  })

  it('reads the day under any point of the plot', () => {
    const { geo } = kitchen('plan')
    for (const i of [0, 1, 373, 1000, 1825]) expect(geo.indexAt(geo.xOf(i))).toBe(i)
    expect([geo.indexAt(-20), geo.indexAt(geo.plotLeft + geo.plotWidth + 20)]).toEqual([0, 1825])
  })

  it('labels every line at its right end without overlap, beside the plot', () => {
    const { geo } = kitchen('year')
    const boxes = geo.labels.map((l) => [l.top, l.top + l.lines * 16] as const).sort((a, b) => a[0] - b[0])
    for (let k = 1; k < boxes.length; k++) expect(boxes[k]![0]).toBeGreaterThanOrEqual(boxes[k - 1]![1] - 1e-9)
    expect(geo.labelColumn.x).toBeGreaterThan(geo.plotLeft + geo.plotWidth)
    expect(geo.labelColumn.x + geo.labelColumn.width).toBeLessThanOrEqual(PHONE)
    expect(geo.labelColumn.width).toBeLessThanOrEqual(Math.round(PHONE * 0.25))
  })

  it('puts the amount labels in a gutter left of the plot, clear of the past band, the today rule and the floor icons', () => {
    const { sample, series } = kitchen('plan')
    const geo = plotGeometry({ series, floors: sample.floors, startDate: sample.startDate, todayIndex: sample.todayIndex, width: PHONE, height: 200, axisText: (v) => `€${v / 100000}K` })
    expect(geo.plotLeft).toBeGreaterThan(0)
    expect(geo.xOf(0)).toBe(geo.plotLeft)
    expect(geo.today).toBeGreaterThan(geo.plotLeft)
    const icons = geo.floors.flatMap((f) => f.icons)
    // One icon for the account with a floor, in the projection and inside the plot.
    expect(icons).toHaveLength(1)
    for (const x of icons) {
      expect(x - 8).toBeGreaterThanOrEqual(geo.plotLeft)
      expect(x).toBeGreaterThanOrEqual(geo.today ?? 0)
      expect(x + 8).toBeLessThanOrEqual(geo.plotLeft + geo.plotWidth)
    }
  })

  it('names an account’s floors once, beside the run that reaches the right edge', () => {
    const points = Array.from({ length: 90 }, (_, i) => 50000 + (i % 30) * 1000)
    const series: ChartSeries[] = [{ id: 'main', account_id: 'main', label: 'Main', colour: '#000000', points }]
    const floors: ChartFloor[] = [
      { account_id: 'main', fromIndex: 0, toIndex: 29, value: 60000 },
      { account_id: 'main', fromIndex: 30, toIndex: 59, value: 30000 },
      { account_id: 'main', fromIndex: 60, toIndex: 89, value: 60000 },
    ]
    const geo = plotGeometry({ series, floors, startDate: '2026-10-01', todayIndex: 0, width: PHONE, height: 200 })
    expect(geo.floors).toHaveLength(3)
    // The floor reads as a dashed swatch and 'floor' under the account's own name.
    expect(geo.labels.map((l) => [l.text, l.floor, l.lines])).toEqual([['Main', true, 2]])
  })

  it('keeps a usable plot at 320 px wide, 256 pt inside the card', () => {
    const { geo } = kitchen('plan', 288 - 32)
    expect(geo.plotWidth).toBeGreaterThanOrEqual(120)
    expect(geo.xTicks.length).toBeGreaterThanOrEqual(2)
  })
})

describe('floorRuns', () => {
  const at = (values: number[]) => values.map((v, i): [number, number] => [i, v])

  it('closes each dip on the floor at the exact crossing days', () => {
    const runs = floorRuns(at([10, 6, 2, 6, 10]), 0, 4, 4)
    expect(runs).toEqual([{ from: 1.5, to: 2.5, lowest: 2, points: [[1.5, 4], [2, 2], [2.5, 4]] }])
  })

  it('finds nothing above the floor, and one run from edge to edge below it', () => {
    expect(floorRuns(at([5, 6, 7]), 0, 2, 4)).toEqual([])
    expect(floorRuns(at([1, 2, 3]), 0, 2, 4)).toEqual([{ from: 0, to: 2, lowest: 0, points: [[0, 4], [0, 1], [1, 2], [2, 3], [2, 4]] }])
  })

  it('starts and ends at the floor window, between drawn points', () => {
    expect(floorRuns([[0, 0], [3, 0], [6, 0]], 1, 5, 4)).toEqual([{ from: 1, to: 5, lowest: 1, points: [[1, 4], [1, 0], [3, 0], [5, 0], [5, 4]] }])
  })

  it('follows a monthly step down and up at its edges', () => {
    const steps: [number, number][] = [[0, 10], [30, 10], [30, 2], [61, 2], [61, 10], [90, 10]]
    expect(floorRuns(steps, 0, 90, 4)).toEqual([{ from: 30, to: 61, lowest: 30, points: [[30, 4], [30, 2], [61, 2], [61, 4]] }])
    // A window that opens on the 1st takes the month's own step, not the one before.
    expect(floorRuns(steps, 30, 45, 4)).toEqual([{ from: 30, to: 45, lowest: 30, points: [[30, 4], [30, 2], [45, 2], [45, 4]] }])
  })
})

describe('tableOf', () => {
  it('lists each day of a short span, and the lowest balance of each month of a long one', () => {
    const { sample, series } = kitchen('year')
    const monthly = tableOf(series, sample.startDate)
    expect(monthly.unit).toBe('month')
    expect(monthly.rows.map((r) => r.day.slice(0, 7))).toHaveLength(12)
    expect(monthly.rows[7]?.day).toBe('2026-11-01')
    const novStart = 214
    const nov = (sample.lines[0]?.points ?? []).slice(novStart, novStart + 30)
    expect(monthly.rows[7]?.values[0]).toBe(Math.min(...nov))
    const daily = tableOf(
      series.map((s) => ({ ...s, points: Array.from(s.points).slice(0, 31) })),
      sample.startDate,
    )
    expect(daily.unit).toBe('day')
    expect(daily.rows).toHaveLength(31)
    expect(daily.rows[3]).toEqual({ day: '2026-04-04', values: series.map((s) => s.points[3]) })
  })
})

describe('layout', () => {
  const fitOf = (span: SampleSpan, floors = true) => {
    const { sample, series } = kitchen(span)
    return readoutFit(series, floors ? sample.floors : [], 'EUR', 'en-GB')
  }

  it('reserves the readout, the plot, the date axis and the table button', () => {
    const fit = fitOf('month')
    expect(fit.cells).toEqual([
      { label: 'Everyday', floor: true },
      { label: 'Savings', floor: false },
      { label: 'Joint', floor: false },
    ])
    expect(fit.amount).toBe('€4,372.11')
    expect(readoutHeight(311, fit)).toBe(18 + 4 + 3 * 20 + 2 * 4)
    expect(readoutHeight(574, fit)).toBe(18 + 4 + 2 * 20 + 4)
    expect(readoutHeight(574, fitOf('month', false))).toBe(18 + 4 + 20)
    expect(chartHeight({ width: 311, readout: fit, plotHeight: 200, minTarget: 44 })).toBe(90 + 8 + 200 + 8 + 20 + 8 + 44)
  })

  // The chart's width in the kitchen card at 320, 390, 480, 640 (200% zoom) and 1,280 px windows.
  const WIDTHS = [254, 324, 414, 574, 686]

  it('keeps the whole name beside Under floor and the widest amount in every readout cell', () => {
    for (const span of ['month', 'year', 'plan'] as const) {
      const fit = fitOf(span)
      // At 254 one column is all there is; these estimates run wide, and the browser check measures that width.
      for (const width of WIDTHS.slice(1)) {
        const columns = readoutColumns(width, fit)
        const cell = width / columns - (columns > 1 ? 24 : 0)
        // Swatch, three 8 pt gaps, the status (13 pt icon, 4 pt gap, the word at 12 pt) and the amount at 15 pt.
        const beside = 8 + 3 * 8 + (13 + 4 + textWidth(UNDER_FLOOR, 12)) + textWidth(fit.amount, 15)
        expect(cell - beside, `${span} at ${width}`).toBeGreaterThanOrEqual(textWidth('Everyday', 13))
      }
    }
    // At 254 (a 320 px window) one column holds every cell, and the name keeps nine tenths of its estimate, which runs wide: the browser draws all of it there.
    for (const span of ['month', 'year', 'plan'] as const) {
      const fit = fitOf(span)
      const beside = 8 + 3 * 8 + (13 + 4 + textWidth(UNDER_FLOOR, 12)) + textWidth(fit.amount, 15)
      expect([span, readoutColumns(254, fit)]).toEqual([span, 1])
      expect(254 - beside, `${span} at 254`).toBeGreaterThanOrEqual(0.9 * textWidth('Everyday', 13))
    }
    expect(WIDTHS.map((w) => readoutColumns(w, fitOf('month')))).toEqual([1, 1, 1, 2, 2])
    expect(WIDTHS.map((w) => readoutColumns(w, fitOf('month', false)))).toEqual([1, 1, 2, 3, 3])
  })

  it('fits the daily table beside three accounts on a phone, and says so when it scrolls', () => {
    const { sample, series } = kitchen('month')
    const names = series.map((s) => s.label)
    const day = rowLabel('2026-12-23', 'day', 'en-GB')
    expect(day).toBe('23 Dec')
    const phone = tableColumns(324, day, '€4,372.11', names)
    expect(phone.scrolls).toBe(false)
    expect(phone.first + 3 * phone.value).toBeLessThanOrEqual(324)
    expect(phone.value).toBeGreaterThanOrEqual(textWidth('€4,372.11', 13) + 8)
    expect(tableColumns(254, day, '€4,372.11', names).scrolls).toBe(true)
    expect(tableColumns(686, day, '€4,372.11', names).value).toBe(128)
    // A heading wraps between words, so only its longest word must fit.
    expect(tableColumns(324, day, '€4,372.11', ['Everyday', 'Household bills', 'Joint']).scrolls).toBe(false)
    expect(sample.lines).toHaveLength(3)
  })

  it('draws 200 pt tall on phones and taller on wide panes, up to 280', () => {
    expect([plotHeightFor(0), plotHeightFor(311), plotHeightFor(600), plotHeightFor(656), plotHeightFor(1200)]).toEqual([200, 200, 240, 262, 280])
  })
})

describe('sparkGeometry', () => {
  it('draws about one point per pixel with the end dot on the last value, inside the box', () => {
    const values = Array.from({ length: 365 }, (_, i) => 100000 + ((i * 7919) % 50000))
    const g = sparkGeometry(values, 80, 28)
    expect(g?.kept).toBeLessThanOrEqual(80)
    const pts = pointsIn(g?.d ?? '')
    expect(pts.at(-1)).toEqual([g?.end.x, g?.end.y])
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(3 - 1e-9)
      expect(x).toBeLessThanOrEqual(77 + 1e-9)
      expect(y).toBeGreaterThanOrEqual(3 - 1e-9)
      expect(y).toBeLessThanOrEqual(25 + 1e-9)
    }
    expect(sparkGeometry([], 80, 28)).toBeNull()
    expect(sparkGeometry([5, 5], 80, 28)?.d).toBe('M3.3 14L76.8 14')
  })
})
