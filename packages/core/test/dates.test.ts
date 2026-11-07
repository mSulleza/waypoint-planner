import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addDays, addMonths, dayFromNumber, dayInMonth, dayNumber, daysBetween, daysInMonth, firstOfMonth, lastDayOfMonth, monthKey, roll, rollDayNumber, todayIn } from '../src/dates'

const DAY_MS = 86_400_000
const isoDay = (epochDay: number) => new Date(epochDay * DAY_MS).toISOString().slice(0, 10)

describe('addDays', () => {
  it('crosses month, year and leap-day edges', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-10-07', 0)).toBe('2026-10-07')
  })

  it('agrees with UTC epoch days and undoes itself', () => {
    fc.assert(
      fc.property(fc.integer({ min: -200_000, max: 200_000 }), fc.integer({ min: -5_000, max: 5_000 }), (start, n) => {
        const day = isoDay(start)
        expect(addDays('1970-01-01', start)).toBe(day)
        expect(addDays(day, n)).toBe(isoDay(start + n))
        expect(addDays(addDays(day, n), -n)).toBe(day)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('day numbers', () => {
  it('match UTC epoch days both ways and roll as roll does', () => {
    fc.assert(
      fc.property(fc.integer({ min: -200000, max: 200000 }), fc.constantFrom('none', 'following', 'preceding'), (n, rule) => {
        const day = isoDay(n)
        expect([dayNumber(day), dayFromNumber(n)]).toEqual([n, day])
        expect(dayFromNumber(rollDayNumber(n, rule))).toBe(roll(day, rule))
      }),
      { numRuns: 500, seed: 20261008 },
    )
  })
})

describe('daysBetween', () => {
  it('counts whole days either way and undoes addDays', () => {
    expect(daysBetween('2026-10-07', '2026-10-31')).toBe(24)
    expect(daysBetween('2028-03-01', '2028-02-28')).toBe(-2)
    fc.assert(
      fc.property(fc.integer({ min: -200_000, max: 200_000 }), fc.integer({ min: -5_000, max: 5_000 }), (start, n) => {
        expect(daysBetween(isoDay(start), addDays(isoDay(start), n))).toBe(n)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('addMonths', () => {
  it('lands 31 Jan plus one month on the last day of February', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
  })

  it('keeps the day when it fits and crosses years both ways', () => {
    expect(addMonths('2026-10-15', 3)).toBe('2027-01-15')
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-15')
    expect(addMonths('2026-10-07', 60)).toBe('2031-10-07')
  })
})

describe('month helpers', () => {
  it('give the first day, last day and length of a month from a date or a month key', () => {
    expect(firstOfMonth('2026-10-07')).toBe('2026-10-01')
    expect(lastDayOfMonth('2027-02-10')).toBe('2027-02-28')
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29')
    expect(daysInMonth('2026-09')).toBe(30)
    expect(daysInMonth('2100-02-01')).toBe(28)
    expect(daysInMonth('2000-02')).toBe(29)
    expect(monthKey('2026-10-07')).toBe('2026-10')
  })

  it('put a day in a month, clamped to its last day', () => {
    expect(dayInMonth('2026-10', 5)).toBe('2026-10-05')
    expect(dayInMonth('2027-02-10', 31)).toBe('2027-02-28')
    expect(dayInMonth('2028-02', 30)).toBe('2028-02-29')
    expect(dayInMonth('2026-09-30', 31)).toBe('2026-09-30')
  })
})

describe('roll', () => {
  it('moves a Saturday to the Friday before or the Monday after', () => {
    expect(roll('2026-10-10', 'preceding')).toBe('2026-10-09')
    expect(roll('2026-10-10', 'following')).toBe('2026-10-12')
  })

  it('moves a Sunday the same way and leaves weekdays and none alone', () => {
    expect(roll('2026-10-11', 'preceding')).toBe('2026-10-09')
    expect(roll('2026-10-11', 'following')).toBe('2026-10-12')
    expect(roll('2026-10-07', 'preceding')).toBe('2026-10-07')
    expect(roll('2026-10-07', 'following')).toBe('2026-10-07')
    expect(roll('2026-10-10', 'none')).toBe('2026-10-10')
  })

  it('always lands on a weekday', () => {
    fc.assert(
      fc.property(fc.integer({ min: -50_000, max: 50_000 }), fc.constantFrom('following' as const, 'preceding' as const), (epochDay, rule) => {
        const rolled = roll(isoDay(epochDay), rule)
        expect([1, 2, 3, 4, 5]).toContain(new Date(`${rolled}T00:00:00Z`).getUTCDay())
      }),
      { numRuns: 500 },
    )
  })
})

describe('todayIn', () => {
  it('reads 22:30 UTC on 7 Oct as 8 Oct in Manila', () => {
    expect(todayIn('Asia/Manila', new Date('2026-10-07T22:30:00Z'))).toBe('2026-10-08')
  })

  it('reads one instant per zone and takes epoch milliseconds too', () => {
    const instant = Date.parse('2026-10-07T22:30:00Z')
    expect(todayIn('Europe/Madrid', instant)).toBe('2026-10-08')
    expect(todayIn('America/New_York', instant)).toBe('2026-10-07')
  })

  it('rejects an unknown zone', () => {
    expect(() => todayIn('Mars/Olympus', 0)).toThrow(RangeError)
  })
})

describe('input checks', () => {
  it.each(['2026-13-01', '2026-02-30', '2026-1-1', '07/10/2026', ''])('refuses %j', (day) => {
    expect(() => addDays(day, 1)).toThrow(RangeError)
  })

  it('refuses a fractional count and a malformed month key', () => {
    expect(() => addMonths('2026-10-07', 1.5)).toThrow(RangeError)
    expect(() => daysInMonth('2026-13')).toThrow(RangeError)
  })
})

describe('owned invariants', () => {
  it('parses YYYY-MM-DD by slicing and takes today from the household zone, not UTC', () => {
    const earlyMorningInManila = new Date('2026-10-07T23:30:00Z')
    expect(earlyMorningInManila.toISOString().slice(0, 10)).toBe('2026-10-07')
    expect(todayIn('Asia/Manila', earlyMorningInManila)).toBe('2026-10-08')
    expect(todayIn('America/Los_Angeles', new Date('2026-10-01T03:00:00Z'))).toBe('2026-09-30')
    expect(monthKey('2026-10-01')).toBe('2026-10')
  })

  it('keys months as YYYY-MM so a month is found by its key', () => {
    const october = Array.from({ length: daysInMonth('2026-10') }, (_, i) => monthKey(addDays('2026-10-01', i)))
    expect(new Set(october)).toEqual(new Set(['2026-10']))
    expect(monthKey(addMonths('2026-12-31', 2))).toBe('2027-02')
    const keys = Array.from({ length: 24 }, (_, i) => monthKey(addMonths('2026-11-30', i)))
    expect([...keys].reverse().sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(24)
  })
})
