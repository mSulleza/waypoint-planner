import { z } from 'zod'

export interface Rate {
  quote: string
  rate: number
  day: string
}

export type RatesPerEur = Readonly<Record<string, number>>

const frankfurterRates = z
  .array(z.object({ date: z.iso.date(), base: z.literal('EUR'), quote: z.string().regex(/^[A-Z]{3}$/), rate: z.number().positive() }))
  .min(1)

// Reads the body of GET https://api.frankfurter.dev/v2/rates?base=EUR&providers=ECB; the fetch lives in the app and the MCP server.
export function parseRates(json: unknown): Rate[] {
  const rows = frankfurterRates.parse(json)
  const latest = new Map<string, Rate>()
  let day = ''
  for (const row of rows) {
    if (row.quote === 'EUR' && row.rate !== 1) throw new Error(`EUR per EUR came back as ${row.rate}`)
    if (row.date > day) day = row.date
    const seen = latest.get(row.quote)
    if (!seen || row.date > seen.day) latest.set(row.quote, { quote: row.quote, rate: row.rate, day: row.date })
  }
  latest.set('EUR', { quote: 'EUR', rate: 1, day })
  return [...latest.values()].sort((a, b) => (a.quote < b.quote ? -1 : 1))
}

// EUR is the base, so it never lacks a rate.
export function missingRates(currencies: readonly string[], rates: readonly Rate[]): string[] {
  const have = new Set(rates.map((r) => r.quote)).add('EUR')
  return [...new Set(currencies)].filter((c) => !have.has(c))
}

export function toRatesPerEur(rates: readonly Rate[]): RatesPerEur {
  return Object.fromEntries(rates.map((r) => [r.quote, r.rate]))
}
