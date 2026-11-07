import { MASK } from '@waypoint/core'

// ASCII figures and the common currency signs, spelled out rather than \p{...} so phones' regex engines read them alike.
const NUMBER = String.raw`[-+\u2212]?[0-9](?:[0-9.,'\u2019 \u00a0\u202f]*[0-9])?`
const SIGN = String.raw`[$\u00a2-\u00a5\u20a0-\u20c0]`
const FIGURE_BY_MONEY = new RegExp(String.raw`(${SIGN}|\b[A-Z]{3})(\s?)${NUMBER}|${NUMBER}(\s?)(${SIGN}|[A-Z]{3}\b)`, 'g')
const CODE = /^[A-Z]{3}$/

let codes: ReadonlySet<string> | null | undefined

// ISO 4217 codes where the engine lists them; Hermes may not, and then any three capitals count.
function currencyCodes(): ReadonlySet<string> | null {
  if (codes === undefined) codes = typeof Intl.supportedValuesOf === 'function' ? new Set(Intl.supportedValuesOf('currency')) : null
  return codes
}

// Three capitals that are no currency, such as INV in 'INV-0042', frame a reference rather than an amount.
function notMoney(code: string, figure: string, gap: string): boolean {
  if (!CODE.test(code)) return false
  const known = currencyCodes()
  return known ? !known.has(code) : gap === '' && /^[-\u2212]/.test(figure)
}

// Under the privacy mask, a figure beside a currency sign or code in a bank's own words, such as 'Card transaction of 4.60 EUR', reads •••.
export function maskFigures(text: string): string {
  return text.replace(FIGURE_BY_MONEY, (match: string, before: string | undefined, gap: string | undefined, gapAfter: string | undefined, after: string | undefined) => {
    if (before !== undefined) return notMoney(before, match.slice(before.length + (gap ?? '').length), gap ?? '') ? match : `${before}${gap ?? ''}${MASK}`
    return after !== undefined && notMoney(after, match, gapAfter ?? '') ? match : `${MASK}${gapAfter ?? ''}${after ?? ''}`
  })
}
