import { parseRates } from '@waypoint/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ecb from '../../../../packages/core/test/fixtures/frankfurter-2026-10-07.json'
import { fetchRates, RATES_URL } from './rates'
import { readSaved, writeSaved } from './saved'
import { memoryStorage } from './test-helpers'

const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
const unreachable = vi.fn(async () => {
  throw new TypeError('Failed to fetch')
})
const older = [
  { quote: 'EUR', rate: 1, day: '2026-10-05' },
  { quote: 'PHP', rate: 69.9, day: '2026-10-05' },
]

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchRates', () => {
  it('reads the ECB rates for the day from the one URL', async () => {
    const fetchImpl = reply(ecb)
    const got = await fetchRates({ fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(RATES_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(RATES_URL).toBe('https://api.frankfurter.dev/v2/rates?base=EUR&providers=ECB')
    expect(got.source).toBe('live')
    expect(got.day).toBe('2026-10-07')
    expect(got.error).toBeNull()
    expect(got.rates.find((r) => r.quote === 'PHP')).toEqual({ quote: 'PHP', rate: 70.203, day: '2026-10-07' })
    expect(got.rates).toEqual(parseRates(ecb))
  })

  it('falls back to the rates saved with the last snapshot, with their own day, and names why', async () => {
    writeSaved({ user_id: 'user-a', fetched_at: '2026-10-05T07:42:00.000Z', doc: {}, rates: older })
    const got = await fetchRates({ fetchImpl: unreachable })
    expect(got).toEqual({ rates: older, day: '2026-10-05', source: 'saved', error: 'the rate service could not be reached' })
  })

  it('labels each kind of failure', async () => {
    const saved = () => older
    const slow = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const reasons = await Promise.all([
      fetchRates({ fetchImpl: reply({ message: 'down' }, 503), saved }),
      fetchRates({ fetchImpl: reply([{ date: '2026-10-07', base: 'EUR', quote: 'PHP', rate: -1 }]), saved }),
      fetchRates({ fetchImpl: slow as unknown as typeof fetch, timeoutMs: 5, saved }),
      fetchRates({ fetchImpl: unreachable, saved }),
    ])
    expect(reasons.map((r) => [r.source, r.error])).toEqual([
      ['saved', 'the rate service answered HTTP 503'],
      ['saved', 'the rate service sent rates that did not pass the checks'],
      ['saved', 'the rate service did not answer in time'],
      ['saved', 'the rate service could not be reached'],
    ])
  })

  it('never rejects and never invents rates when nothing is saved', async () => {
    expect(readSaved()).toBeNull()
    expect(await fetchRates({ fetchImpl: unreachable })).toEqual({ rates: [], day: null, source: 'none', error: 'the rate service could not be reached' })
  })
})
