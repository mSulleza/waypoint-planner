import { parseRates } from '@waypoint/core'
import { abroad } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import ecb from '../../../packages/core/test/fixtures/frankfurter-2026-10-07.json'
import type { Db } from '../src/auth'
import { DailyRates, fetchRates, Household, type SessionLike } from '../src/data'
import { AgentError } from '../src/errors'

const ECB = parseRates(ecb)
const PHP = (rates: readonly { quote: string; rate: number }[]) => rates.find((r) => r.quote === 'PHP')?.rate

describe('the day’s rates', () => {
  it('reads the ECB answer and names an HTTP failure', async () => {
    const ok = fetchRates('https://rates.test', async () => new Response(JSON.stringify(ecb), { status: 200 }))
    expect(PHP(await ok())).toBe(70.203)
    const down = fetchRates('https://rates.test', async () => new Response('', { status: 503 }))
    await expect(down()).rejects.toThrow('the rate service answered HTTP 503')
  })

  it('fetches once a day and falls back to the last good rates with their own day', async () => {
    let calls = 0
    let fail = false
    const rates = new DailyRates(async () => {
      calls++
      if (fail) throw new TypeError('fetch failed')
      return ECB
    })
    expect(await rates.forDay('2026-10-07')).toEqual({ rates: ECB, day: '2026-10-07', source: 'live', problem: null })
    expect(await rates.forDay('2026-10-07')).toMatchObject({ source: 'live' })
    expect(calls).toBe(1)
    fail = true
    expect(await rates.forDay('2026-10-08')).toEqual({ rates: ECB, day: '2026-10-07', source: 'saved', problem: 'the rate service could not be reached' })
    expect(calls).toBe(2)
  })

  it('has no rates, and says why, when the first fetch fails', async () => {
    const rates = new DailyRates(async () => {
      throw new Error('bad shape')
    })
    expect(await rates.forDay('2026-10-07')).toEqual({ rates: [], day: null, source: 'none', problem: 'the rate service sent rates that did not pass the checks' })
  })
})

// A session whose client answers export_household from a script.
function exporting(replies: { data: unknown; error: { message: string; code: string } | null; status: number }[]): SessionLike & { dropped: number; calls: number } {
  const client = { rpc: async () => replies.shift() } as unknown as Db
  const s = { dropped: 0, calls: 0, client: async () => (s.calls++, client), drop: () => void s.dropped++ }
  return s
}

const NOON = () => new Date('2026-10-07T10:00:00Z')

describe('a read', () => {
  it('walks one export with the day’s rates on the household’s own day', async () => {
    const doc = abroad('2026-10-07').doc
    const session = exporting([{ data: doc, error: null, status: 200 }])
    const world = await new Household(session, new DailyRates(async () => ECB), 'http://localhost:8090', NOON).load()
    expect(world.snapshot.as_of).toBe('2026-10-07')
    expect(world.walk.as_of).toBe('2026-10-07')
    expect(PHP(world.snapshot.rates)).toBe(70.203)
    expect(world.web_url).toBe('http://localhost:8090')
  })

  it('signs in again once when the server refuses the token, then reads', async () => {
    const doc = abroad('2026-10-07').doc
    const session = exporting([
      { data: null, error: { message: 'JWT expired', code: 'PGRST303' }, status: 401 },
      { data: doc, error: null, status: 200 },
    ])
    await new Household(session, new DailyRates(async () => ECB), null, NOON).load()
    expect([session.dropped, session.calls]).toEqual([1, 2])
  })

  it('says when the account has no household yet', async () => {
    const session = exporting([{ data: null, error: null, status: 200 }])
    await expect(new Household(session, new DailyRates(async () => ECB), null, NOON).load()).rejects.toThrow(new AgentError('This account has no household yet. Set one up in the Waypoint app first.'))
  })

  it('says why the walk could not run when a currency has no rate', async () => {
    const session = exporting([{ data: abroad('2026-10-07').doc, error: null, status: 200 }])
    const none = new DailyRates(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(new Household(session, none, null, NOON).load()).rejects.toThrow("The day's exchange rates are missing because the rate service could not be reached.")
  })
})
