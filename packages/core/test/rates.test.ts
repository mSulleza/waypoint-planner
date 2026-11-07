import { describe, expect, it } from 'vitest'
import { missingRates, parseRates, toRatesPerEur } from '../src/rates'
import sample from './fixtures/frankfurter-2026-10-07.json'

const row = (quote: string, rate: number, date = '2026-10-07') => ({ date, base: 'EUR', quote, rate })

describe('parseRates', () => {
  it('reads the ECB sample: PHP 70.203 dated 2026-10-07 plus EUR at 1', () => {
    const rates = parseRates(sample)
    expect(rates.find((r) => r.quote === 'PHP')).toEqual({ quote: 'PHP', rate: 70.203, day: '2026-10-07' })
    expect(rates.find((r) => r.quote === 'EUR')).toEqual({ quote: 'EUR', rate: 1, day: '2026-10-07' })
    expect(rates).toHaveLength(30)
  })

  it('adds EUR at 1 when the response leaves it out, dated by the latest row', () => {
    expect(parseRates([row('PHP', 70.203, '2026-10-06'), row('USD', 1.1177)])).toEqual([
      { quote: 'EUR', rate: 1, day: '2026-10-07' },
      { quote: 'PHP', rate: 70.203, day: '2026-10-06' },
      { quote: 'USD', rate: 1.1177, day: '2026-10-07' },
    ])
  })

  it('keeps the latest day when a quote repeats', () => {
    expect(parseRates([row('PHP', 70.5, '2026-10-08'), row('PHP', 70.203)]).find((r) => r.quote === 'PHP')).toEqual({ quote: 'PHP', rate: 70.5, day: '2026-10-08' })
  })

  it.each([
    ['no rows', []],
    ['another base', [{ ...row('PHP', 70.203), base: 'USD' }]],
    ['a bad date', [row('PHP', 70.203, '2026-13-01')]],
    ['a zero rate', [row('PHP', 0)]],
    ['a lower-case code', [row('php', 70.203)]],
    ['EUR other than 1', [row('EUR', 1.01)]],
    ['not an array', { rates: { PHP: 70.203 } }],
  ])('refuses %s', (_, json) => {
    expect(() => parseRates(json)).toThrow()
  })
})

describe('missingRates', () => {
  const rates = parseRates(sample)

  it('lists AED, which the ECB does not publish', () => {
    expect(missingRates(['AED'], rates)).toEqual(['AED'])
  })

  it('lists each missing code once and never EUR', () => {
    expect(missingRates(['EUR', 'PHP', 'AED', 'AED', 'XYZ'], rates)).toEqual(['AED', 'XYZ'])
    expect(missingRates(['EUR'], [])).toEqual([])
  })
})

describe('toRatesPerEur', () => {
  it('keys each rate by its quote', () => {
    expect(toRatesPerEur(parseRates([row('PHP', 70.203)]))).toEqual({ EUR: 1, PHP: 70.203 })
  })
})
