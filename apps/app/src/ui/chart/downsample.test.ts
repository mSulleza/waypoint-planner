import { buildSnapshot, runEngine } from '@waypoint/core'
import { abroad } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { downsample, downsampleAround, MAX_POINTS, MIN_LINE_POINTS } from './downsample'

// A seeded generator, so each run checks the same series.
function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

// Five years of daily balances: pay on day 25 of each 30, spending down to a dip the day before, plus one deep dip and one peak.
function balances(length: number, dip: number, peak: number): number[] {
  const next = random(11)
  const out: number[] = []
  let b = 250000
  for (let i = 0; i < length; i++) {
    if (i % 30 === 25) b += 280000
    b -= 8000 + Math.round(next() * 2000)
    out.push(i === dip ? -500000 : i === peak ? 2000000 : b)
  }
  return out
}

function extremes(values: ArrayLike<number>, indices: readonly number[]): [number, number] {
  const kept = indices.map((i) => values[i] as number)
  return [Math.min(...kept), Math.max(...kept)]
}

describe('downsample', () => {
  it('keeps the global minimum and maximum of a 1,826-point series in at most 300 points', () => {
    const series = balances(1826, 1234, 777)
    const kept = downsample(series)
    expect(series).toHaveLength(1826)
    expect(kept.length).toBeLessThanOrEqual(300)
    expect(kept.length).toBeGreaterThan(290)
    expect(kept).toContain(1234)
    expect(kept).toContain(777)
    expect(extremes(series, kept)).toEqual([-500000, 2000000])
    expect([kept[0], kept.at(-1)]).toEqual([0, 1825])
  })

  it('keeps the dip before every payday across five years', () => {
    const series = balances(1826, -1, -1)
    const kept = new Set(downsample(series))
    for (let start = 0; start < 1826; start += 30) {
      const month = series.slice(start, start + 30)
      const low = start + month.indexOf(Math.min(...month))
      expect(kept.has(low), `the lowest day of the month from day ${start}`).toBe(true)
    }
  })

  it('keeps the lowest and highest balance of a real five-year walk', () => {
    const sample = abroad('2026-10-07')
    const run = runEngine(buildSnapshot(sample.doc, '2026-10-07', sample.rates))
    if (!run.ok) throw new Error('the engine did not run')
    const walked = [...run.walk.balances.values()].filter((b) => b.length > MAX_POINTS)
    expect(walked.length).toBeGreaterThan(0)
    for (const b of walked) {
      const kept = downsample(b)
      expect(kept.length).toBeLessThanOrEqual(MAX_POINTS)
      expect(extremes(b, kept)).toEqual([Math.min(...b), Math.max(...b)])
    }
  })

  it('returns indices in order with both ends, at most max of them, for any length and budget', () => {
    const next = random(3)
    for (let run = 0; run < 200; run++) {
      const length = 1 + Math.floor(next() * 4000)
      const max = 4 + Math.floor(next() * 400)
      const series = Array.from({ length }, () => Math.round((next() - 0.5) * 1e6))
      const kept = downsample(series, max)
      expect(kept.length).toBeLessThanOrEqual(Math.max(max, 2))
      expect(kept[0]).toBe(0)
      expect(kept.at(-1)).toBe(length - 1)
      for (let k = 1; k < kept.length; k++) expect(kept[k] as number).toBeGreaterThan(kept[k - 1] as number)
      expect(extremes(series, kept)).toEqual([Math.min(...series), Math.max(...series)])
    }
  })

  it('keeps every point of a short series and none of an empty one', () => {
    expect(downsample([5, 3, 9])).toEqual([0, 1, 2])
    expect(downsample(Array.from({ length: 300 }, (_, i) => i))).toHaveLength(300)
    expect(downsample([])).toEqual([])
  })
})

describe('downsampleAround', () => {
  it('splits at today so each half ends on the rule, keeping today and at most 300 points in all', () => {
    const series = balances(1826, 1500, 200)
    for (const today of [1, 373, 900, 1824]) {
      const kept = downsampleAround(series, today)
      expect(kept.length, `today ${today}`).toBeLessThanOrEqual(MAX_POINTS)
      expect(kept).toContain(today)
      expect(new Set(kept).size).toBe(kept.length)
      expect(extremes(series, kept)).toEqual([-500000, 2000000])
    }
  })

  it('holds a pane share of any size from 8, wherever today falls', () => {
    const next = random(17)
    for (let run = 0; run < 300; run++) {
      const length = 3 + Math.floor(next() * 2000)
      const max = MIN_LINE_POINTS + Math.floor(next() * 150)
      const today = 1 + Math.floor(next() * (length - 2))
      const series = Array.from({ length }, () => Math.round((next() - 0.5) * 1e6))
      const kept = downsampleAround(series, today, max)
      expect(kept.length, `${length} days, today ${today}, ${max} points`).toBeLessThanOrEqual(max)
      expect(kept).toContain(today)
      for (let k = 1; k < kept.length; k++) expect(kept[k] as number).toBeGreaterThan(kept[k - 1] as number)
      expect(extremes(series, kept)).toEqual([Math.min(...series), Math.max(...series)])
    }
  })

  it('is a plain downsample when today is outside the series', () => {
    const series = balances(1000, 10, 20)
    expect(downsampleAround(series, -5)).toEqual(downsample(series))
    expect(downsampleAround(series, 2000)).toEqual(downsample(series))
  })
})
