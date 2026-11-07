import { minorDigits } from '@waypoint/core'

// The text a prefilled amount shows in the field: no grouping, the locale's decimal mark, exact from minor units.
export function amountText(minor: number, currency: string, locale: string): string {
  const digits = minorDigits(currency)
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.'
  const sign = minor < 0 ? '-' : ''
  const text = String(Math.abs(minor)).padStart(digits + 1, '0')
  return digits === 0 ? `${sign}${text}` : `${sign}${text.slice(0, -digits)}${decimal}${text.slice(-digits)}`
}

// A typed day that reads as a real date: YYYY-MM-DD, and no 31 April.
export const isDay = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text
