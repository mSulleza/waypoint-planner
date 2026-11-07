import { describe, expect, it } from 'vitest'
import { moneyLike } from '../dev/audit'
import { maskFigures } from './mask-text'

describe('maskFigures', () => {
  it.each([
    ['Card transaction of 4.60 EUR issued by Corner Bakery', 'Card transaction of ••• EUR issued by Corner Bakery'],
    ['Refund EUR 12.40', 'Refund EUR •••'],
    ['Paid €1,250.00 to Example Ltd', 'Paid €••• to Example Ltd'],
    ['Top-up ₱ 5 000', 'Top-up ₱ •••'],
    ['4.60EUR', '•••EUR'],
  ])('masks the figure in %s', (text, masked) => {
    expect(maskFigures(text)).toBe(masked)
    expect(moneyLike(maskFigures(text))).toBe(false)
  })

  it('leaves dates, counts and words without a currency alone', () => {
    expect(maskFigures('Sent money to Alex Sample on 05-10-2026, 2 items')).toBe('Sent money to Alex Sample on 05-10-2026, 2 items')
  })

  it('leaves a reference whose letters are no currency code, and still masks one that is', () => {
    expect(maskFigures('Received money from Example Ltd with reference INV-0042')).toBe('Received money from Example Ltd with reference INV-0042')
    expect(maskFigures('Order ABC 123 shipped, 4 BOX')).toBe('Order ABC 123 shipped, 4 BOX')
    expect(maskFigures('Fee EUR-5.00 and 12 USD')).toBe('Fee EUR••• and ••• USD')
  })
})
