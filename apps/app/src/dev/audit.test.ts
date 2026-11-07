import { describe, expect, it } from 'vitest'
import { moneyLike, ownText, undersized } from './audit'

describe('moneyLike', () => {
  it('finds amounts beside a symbol or a currency code in several locales', () => {
    const amounts = ['€1,234.56', '1.234,56 €', '₱70.20', '-$5.00', 'PHP 1,000', '12 345 JPY', '¥1.2M']
    expect(amounts.filter((t) => !moneyLike(t))).toEqual([])
  })

  it('leaves dates, counts, masked amounts and non-currency codes alone', () => {
    const plain = ['7 Oct', '3 of 12', '2027-03', 'EMI 3 of 12', 'Day 8', '•••', '••• owed', 'Updated 07:42']
    expect(plain.filter((t) => moneyLike(t))).toEqual([])
  })
})

describe('ownText', () => {
  it('joins an element’s own text nodes, so an amount React splits into two of them is still found', () => {
    const text = (value: string) => ({ nodeType: 3, nodeValue: value })
    const child = { nodeType: 1, nodeValue: null }
    const split = { childNodes: [text('Send €'), text('45.00'), child, text(' to savings')] }
    expect(ownText(split)).toBe('Send €45.00 to savings')
    expect(moneyLike(ownText(split))).toBe(true)
    // Each part alone reads as no amount, which is what the audit missed.
    expect(split.childNodes.filter((n) => n.nodeType === 3).some((n) => moneyLike(n.nodeValue ?? ''))).toBe(false)
    expect(ownText({ childNodes: [child] })).toBe('')
  })
})

describe('undersized', () => {
  it('flags a control under the target in either direction and allows sub-pixel rounding', () => {
    expect([undersized(44, 44, 44), undersized(43.6, 44, 44), undersized(40, 44, 44), undersized(120, 36, 44), undersized(48, 47, 48)]).toEqual([false, false, true, true, true])
  })
})
