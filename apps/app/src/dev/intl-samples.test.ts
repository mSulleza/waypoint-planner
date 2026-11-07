import { describe, expect, it } from 'vitest'
import { intlSamples } from './intl-samples'

describe('intlSamples on Node', () => {
  const s = intlSamples()
  it('reads currency decimals from Intl', () => {
    const digits = Object.fromEntries(s.money.filter((m) => m.locale === 'en-US').map((m) => [m.currency, m.maxFractionDigits]))
    expect(digits).toEqual({ EUR: 2, PHP: 2, USD: 2, JPY: 0, KWD: 3 })
  })
  it('formats one instant in two zones', () => {
    expect(s.manila).toBe('8 Oct, 06:30')
    expect(s.madrid).toBe('8 Oct, 00:30')
  })
})
