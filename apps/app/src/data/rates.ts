import { parseRates, type Rate } from '@waypoint/core'
import { readSaved } from './saved'

// The ECB reference rates; the service sends access-control-allow-origin: *, so browsers call it directly.
export const RATES_URL = 'https://api.frankfurter.dev/v2/rates?base=EUR&providers=ECB'
export const RATES_TIMEOUT_MS = 8000

// live: fetched for this load. saved: the fetch failed and these are the rates saved with the last snapshot. none: failed with nothing saved. sample: a sample's own rates.
export type RatesSource = 'live' | 'saved' | 'none' | 'sample'

export interface RatesInfo {
  rates: readonly Rate[]
  // The ECB publication day the rates belong to; null when there are none.
  day: string | null
  source: RatesSource
  // Why the live fetch failed, when it did.
  error: string | null
}

export function ratesDay(rates: readonly Rate[]): string | null {
  let day: string | null = null
  for (const r of rates) if (day === null || r.day > day) day = r.day
  return day
}

export interface FetchRatesOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  saved?: () => readonly Rate[] | null
}

async function fetchLive(fetchImpl: typeof fetch, timeoutMs: number): Promise<Rate[]> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const res = await fetchImpl(RATES_URL, { signal: abort.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`the rate service answered HTTP ${res.status}`)
    return parseRates(await res.json())
  } finally {
    clearTimeout(timer)
  }
}

function why(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'the rate service did not answer in time'
  if (error instanceof Error && error.message.startsWith('the rate service')) return error.message
  if (error instanceof TypeError) return 'the rate service could not be reached'
  return 'the rate service sent rates that did not pass the checks'
}

// Never rejects: on failure it names the reason and falls back to the saved rates with their own day.
export async function fetchRates(options: FetchRatesOptions = {}): Promise<RatesInfo> {
  const { fetchImpl = globalThis.fetch, timeoutMs = RATES_TIMEOUT_MS, saved = () => readSaved()?.rates ?? null } = options
  try {
    const rates = await fetchLive(fetchImpl, timeoutMs)
    return { rates, day: ratesDay(rates), source: 'live', error: null }
  } catch (error) {
    const last = saved()
    const reason = why(error)
    if (last && last.length > 0) return { rates: last, day: ratesDay(last), source: 'saved', error: reason }
    return { rates: [], day: null, source: 'none', error: reason }
  }
}
