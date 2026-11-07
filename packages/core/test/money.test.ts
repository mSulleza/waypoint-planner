import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { approxTotal, convert, formatMoney, fxTerms, grossFor, MASK, minorDigits, netOf, netsByCurrency, parseAmount, scaleMinor } from '../src/money'
import { parseRates, toRatesPerEur } from '../src/rates'
import sample from './fixtures/frankfurter-2026-10-07.json'

const rates = parseRates(sample)
const LATIN_LOCALES = ['en-US', 'en-PH', 'es-ES', 'de-DE', 'fr-FR', 'nl-NL', 'sv-SE', 'pl-PL', 'pt-BR', 'ja-JP', 'en-IN', 'hi-IN', 'de-CH', 'he-IL']
const LOCALES = [...LATIN_LOCALES, 'ar-EG', 'fa-IR']
const CURRENCIES = ['EUR', 'PHP', 'USD', 'JPY', 'KWD', 'INR', 'SEK', 'CHF', 'EGP']
const amount = fc.oneof(fc.integer({ min: -999, max: 999 }), fc.integer({ min: -1e13, max: 1e13 }))
const NBSP = '\u00a0'

describe('minorDigits', () => {
  it('takes decimals from Intl: JPY 0, EUR 2, KWD 3', () => {
    expect([minorDigits('JPY'), minorDigits('EUR'), minorDigits('KWD')]).toEqual([0, 2, 3])
  })

  it('rejects a code that is not three capital letters', () => {
    expect(() => minorDigits('eur')).toThrow(RangeError)
    expect(() => minorDigits('EURO')).toThrow(RangeError)
  })
})

describe('parseAmount', () => {
  it("reads es-ES '1.234,56' EUR as 123456", () => {
    expect(parseAmount('1.234,56', 'es-ES', 'EUR')).toBe(123456)
  })

  it.each([
    ['1,234.56', 'en-US', 'EUR', 123456],
    ['1234,56', 'es-ES', 'EUR', 123456],
    ['12,30 €', 'es-ES', 'EUR', 1230],
    ['1 234,56', 'fr-FR', 'EUR', 123456],
    ['12,34,567.89', 'en-IN', 'INR', 123456789],
    ["1'234.50", 'de-CH', 'CHF', 123450],
    ['1\u2019234.50', 'de-CH', 'CHF', 123450],
    ['١٢٣٫٤٥', 'ar-EG', 'EGP', 12345],
    ['1.234', 'es-ES', 'JPY', 1234],
    ['1,000', 'en-US', 'KWD', 1000000],
    ['0.5', 'en-US', 'KWD', 500],
    ['-€1,234.56', 'en-US', 'EUR', -123456],
    ['€-12', 'en-US', 'EUR', -1200],
    ['\u221212,50 kr', 'sv-SE', 'SEK', -1250],
    ['+7', 'en-US', 'EUR', 700],
    ['US$ 3', 'es-ES', 'USD', 300],
    ['12.3400', 'en-US', 'EUR', 1234],
  ])('reads %j in %s %s as %d', (text, locale, currency, minor) => {
    expect(parseAmount(text, locale, currency)).toBe(minor)
  })

  it.each([
    ['1.234,56', 'en-US', 'EUR'],
    ['1,23', 'en-US', 'EUR'],
    ['1.5', 'es-ES', 'EUR'],
    ['1.2.3', 'en-US', 'EUR'],
    ['12a', 'en-US', 'EUR'],
    ['1e3', 'en-US', 'EUR'],
    ['--1', 'en-US', 'EUR'],
    ['1 234', 'en-US', 'EUR'],
    ['.', 'en-US', 'EUR'],
    ['1.005', 'en-US', 'EUR'],
    ['1.5', 'en-US', 'JPY'],
    ['99999999999999999', 'en-US', 'EUR'],
  ])('refuses %j in %s %s', (text, locale, currency) => {
    expect(parseAmount(text, locale, currency)).toBeNull()
  })

  it('reads back every amount formatMoney writes', () => {
    fc.assert(
      fc.property(amount, fc.constantFrom(...LOCALES), fc.constantFrom(...CURRENCIES), (minor, locale, currency) => {
        expect(parseAmount(formatMoney(minor, currency, locale), locale, currency)).toBe(minor)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('formatMoney', () => {
  it('puts the sign outside the symbol with a fixed decimal count in the pinned locale', () => {
    expect(formatMoney(-123456, 'EUR', 'en-US')).toBe('\u2212€1,234.56')
    expect(formatMoney(-123456, 'EUR', 'nl-NL')).toBe(`\u2212€${NBSP}1.234,56`)
    expect(new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(-1234.56)).toBe(`€${NBSP}-1.234,56`)
    expect(formatMoney(-123456, 'EUR', 'es-ES')).toBe(`\u22121234,56${NBSP}€`)
    expect(formatMoney(-12345, 'SEK', 'sv-SE')).toBe(`\u2212123,45${NBSP}kr`)
    expect(formatMoney(-1234567, 'PHP', 'en-PH')).toBe('\u2212₱12,345.67')
    expect(formatMoney(4567800, 'PHP', 'en-PH')).toBe('₱45,678.00')
    expect(formatMoney(4567800, 'PHP', 'de-DE')).toBe(`45.678,00${NBSP}PHP`)
    expect(formatMoney(123400, 'JPY', 'en-US')).toBe('¥123,400')
    expect(formatMoney(1, 'KWD', 'en-US')).toBe(`KWD${NBSP}0.001`)
    expect(formatMoney(0, 'EUR', 'en-US')).toBe('€0.00')
    expect(formatMoney(-1, 'EUR', 'en-US')).toBe('\u2212€0.01')
    // As wide as '+' in tabular figures, and read back as the same amount.
    expect(parseAmount(formatMoney(-123456, 'EUR', 'en-US'), 'en-US', 'EUR')).toBe(-123456)
  })

  it('never shows -0', () => {
    expect(formatMoney(-0, 'EUR', 'en-US')).toBe('€0.00')
    fc.assert(
      fc.property(amount, fc.constantFrom(...LATIN_LOCALES), fc.constantFrom(...CURRENCIES), fc.boolean(), (minor, locale, currency, compact) => {
        const out = formatMoney(minor, currency, locale, { compact })
        const signed = /[-\u2212]/.test(out)
        expect(signed).toBe(minor < 0)
        if (signed) expect(out).toMatch(/[1-9]/)
      }),
      { numRuns: 1000 },
    )
  })

  it('is compact only when asked, for chart axes', () => {
    expect(formatMoney(123456789, 'EUR', 'en-US')).toBe('€1,234,567.89')
    expect(formatMoney(123456789, 'EUR', 'en-US', { compact: true })).toBe('€1.2M')
    expect(formatMoney(-123456789, 'EUR', 'en-US', { compact: true })).toBe('\u2212€1.2M')
  })

  it('reads ••• under the privacy mask', () => {
    expect(MASK).toBe('•••')
    expect(formatMoney(-123456, 'EUR', 'en-US', { mask: true })).toBe('•••')
    expect(formatMoney(0, 'PHP', 'en-PH', { mask: true, compact: true })).toBe('•••')
  })

  it('rejects an amount that is not whole minor units', () => {
    expect(() => formatMoney(12.5, 'EUR', 'en-US')).toThrow(RangeError)
  })
})

describe('convert', () => {
  it('turns 100 EUR cents into 160 yen at JPY 160', () => {
    expect(convert(100, 'EUR', 'JPY', { JPY: 160 })).toBe(160)
  })

  it('turns 1000 KWD fils into 303 EUR cents at KWD 0.33', () => {
    expect(convert(1000, 'KWD', 'EUR', { KWD: 0.33 })).toBe(303)
  })

  it('crosses two quoted currencies as rate[B] ÷ rate[A]', () => {
    expect(convert(10000, 'USD', 'PHP', { USD: 1.1177, PHP: 70.203 })).toBe(628102)
  })

  it('rounds a tie once, to the even neighbour', () => {
    expect(convert(1, 'EUR', 'USD', { USD: 2.5 })).toBe(2)
    expect(convert(3, 'EUR', 'USD', { USD: 2.5 })).toBe(8)
    expect(convert(-3, 'EUR', 'USD', { USD: 2.5 })).toBe(-8)
    expect(Object.is(convert(-1, 'EUR', 'USD', { USD: 0.5 }), 0)).toBe(true)
  })

  it('needs no rate within one currency', () => {
    expect(convert(500, 'AED', 'AED', {})).toBe(500)
  })
})

describe('netOf and grossFor', () => {
  it('takes the fee off, then applies the rate, rounding once', () => {
    expect(netOf(100000, 70.203, 0.00736)).toBe(6968631)
    expect(netOf(0, 70.203, 0.00736)).toBe(0)
  })

  it('finds the smallest gross whose net reaches n at 70.203 with a 0.736% fee', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), (n) => {
        const gross = grossFor(n, 70.203, 0.00736)
        expect(netOf(gross, 70.203, 0.00736)).toBeGreaterThanOrEqual(n)
        expect(netOf(gross - 1, 70.203, 0.00736)).toBeLessThan(n)
      }),
      { numRuns: 1000 },
    )
  })

  it('finds the smallest gross the other way, where one source unit buys less than one target unit', () => {
    const terms = fxTerms('PHP', 'EUR', toRatesPerEur(rates), 0.00736)
    if (!terms) throw new Error('PHP has a rate in the sample')
    expect(grossFor(0, terms.rate, terms.feePct)).toBe(0)
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e10 }), (n) => {
        const gross = grossFor(n, terms.rate, terms.feePct)
        expect(netOf(gross, terms.rate, terms.feePct)).toBeGreaterThanOrEqual(n)
        expect(netOf(gross - 1, terms.rate, terms.feePct)).toBeLessThan(n)
      }),
      { numRuns: 1000 },
    )
  })

  it('steps past a net that lands exactly on a half and rounds down to even', () => {
    expect([grossFor(1, 0.5, 0), grossFor(2, 0.5, 0), grossFor(3, 0.5, 0)]).toEqual([2, 3, 6])
    expect([netOf(5, 0.5, 0), netOf(6, 0.5, 0)]).toEqual([2, 3])
  })

  it('finds the smallest gross for any rate and fee', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 1, max: 2_000_000 }), fc.integer({ min: 0, max: 1999 }), (n, r, f) => {
        const [rate, fee] = [r / 1e4, f / 1e4]
        const gross = grossFor(n, rate, fee)
        expect(netOf(gross, rate, fee)).toBeGreaterThanOrEqual(n)
        expect(netOf(gross - 1, rate, fee)).toBeLessThan(n)
      }),
      { numRuns: 1000 },
    )
  })

  it('moves within one currency at rate 1 with no fee', () => {
    expect(fxTerms('EUR', 'EUR', {}, 0.00736)).toEqual({ rate: 1, feePct: 0 })
    expect(netOf(5000, 1, 0)).toBe(5000)
    expect(grossFor(5000, 1, 0)).toBe(5000)
  })

  it('scales the rate between minor units by the digit difference', () => {
    expect(fxTerms('EUR', 'JPY', { JPY: 160 }, 0.01)).toEqual({ rate: 1.6, feePct: 0.01 })
    expect(fxTerms('EUR', 'AED', {}, 0.01)).toBeNull()
  })

  it('rejects a fee of 1 or more, a negative fee and a rate of 0', () => {
    expect(() => netOf(100, 70.203, 1)).toThrow(RangeError)
    expect(() => netOf(100, 70.203, -0.01)).toThrow(RangeError)
    expect(() => grossFor(100, 0, 0.00736)).toThrow(RangeError)
    expect(() => grossFor(-1, 70.203, 0.00736)).toThrow(RangeError)
  })
})

describe('scaleMinor', () => {
  it('scales by the decimal the factor was written as and rounds once, half up or up', () => {
    // 0.03 has no exact binary form; 1,000,000 × 0.03 ÷ 30 is exactly 1,000.
    expect([scaleMinor(1000000, 0.03, 'half_up', 30), scaleMinor(5, 0.5, 'half_up'), scaleMinor(4, 0.625, 'half_up'), scaleMinor(1000001, 0.03, 'ceil'), scaleMinor(1000001, 0.03, 'half_up')]).toEqual([1000, 3, 3, 30001, 30000])
    expect([scaleMinor(0, 0.2499, 'ceil', 365), scaleMinor(36500, 0.2499, 'half_up', 365)]).toEqual([0, 25])
  })

  it('agrees with exact integer arithmetic on percentages of any amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 1, max: 365 }), (minor, bp, divisor) => {
        const [num, den] = [BigInt(minor) * BigInt(bp), 10000n * BigInt(divisor)]
        expect(scaleMinor(minor, bp / 10000, 'ceil', divisor)).toBe(Number((num + den - 1n) / den))
        expect(scaleMinor(minor, bp / 10000, 'half_up', divisor)).toBe(Number((2n * num + den) / (2n * den)))
      }),
      { numRuns: 300, seed: 20261008 },
    )
  })

  it('refuses a negative amount or factor and a divisor that is not a whole number above 0', () => {
    expect(() => scaleMinor(-1, 0.03, 'ceil')).toThrow(RangeError)
    expect(() => scaleMinor(1, -0.03, 'ceil')).toThrow(RangeError)
    expect(() => scaleMinor(1, 0.03, 'ceil', 0)).toThrow(RangeError)
    expect(() => scaleMinor(1, 0.03, 'ceil', 1.5)).toThrow(RangeError)
  })
})

describe('owned invariants', () => {
  it('keeps zero and null apart, so blank text and a missing rate are null, never 0', () => {
    expect(parseAmount('', 'en-US', 'EUR')).toBeNull()
    expect(parseAmount('   ', 'en-US', 'EUR')).toBeNull()
    expect(parseAmount('0', 'en-US', 'EUR')).toBe(0)
    expect(parseAmount('0,00', 'es-ES', 'EUR')).toBe(0)
    expect(convert(100, 'EUR', 'AED', toRatesPerEur(rates))).toBeNull()
    expect(convert(0, 'EUR', 'PHP', toRatesPerEur(rates))).toBe(0)
    expect(approxTotal([{ minor: 100, currency: 'AED' }], 'EUR', rates)).toBeNull()
  })

  it('decodes text once into integer minor units, with no float drift', () => {
    expect(1000 - 999.99).not.toBe(0.01)
    const [a, b] = [parseAmount('1000', 'en-US', 'PHP') ?? NaN, parseAmount('999.99', 'en-US', 'PHP') ?? NaN]
    expect([a, b, a - b]).toEqual([100000, 99999, 1])
    expect(parseAmount('1.005', 'en-US', 'KWD')).toBe(1005)
    expect(Math.round(100 * 1.015)).toBe(101)
    expect(convert(100, 'EUR', 'USD', { USD: 1.015 })).toBe(102)
  })

  it("derives a second-currency figure from the amount and the day's rate", () => {
    expect(convert(10000000, 'PHP', 'EUR', toRatesPerEur(rates))).toBe(142444)
    expect(convert(10000000, 'PHP', 'EUR', { PHP: 71 })).toBe(140845)
  })

  it('never sums two currencies, keeping nets side by side and labelling a converted total approximate with its rate day', () => {
    const amounts = [
      { minor: 100000, currency: 'PHP' },
      { minor: 1000, currency: 'EUR' },
      { minor: -5000, currency: 'PHP' },
    ]
    expect(netsByCurrency(amounts)).toEqual([
      { currency: 'PHP', minor: 95000 },
      { currency: 'EUR', minor: 1000 },
    ])
    expect(approxTotal(amounts, 'EUR', rates)).toEqual({ minor: 2353, currency: 'EUR', approx: true, day: '2026-10-07' })
    expect(approxTotal([{ minor: 1000, currency: 'EUR' }], 'EUR', rates)).toEqual({ minor: 1000, currency: 'EUR', approx: false })
  })
})
