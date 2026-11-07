import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordedIds } from './imports'
import { createWaypointClient } from './supabase'
import { memoryStorage } from './test-helpers'

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('recordedIds', () => {
  it('reads the account’s external ids, each with its day and amount, around the file’s days in one request', async () => {
    const urls: URL[] = []
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
      return Response.json([
        { external_id: 'CARD-1', posted_on: '2026-10-02', amount_minor: -1250 },
        { external_id: 'csv:00ff', posted_on: '2026-10-08', amount_minor: 90000 },
      ])
    }
    const client = createWaypointClient('http://127.0.0.1:54321', 'sb_publishable_test-key', { storage: globalThis.localStorage, fetch: fetchImpl })
    expect(await recordedIds(client, 'a1', '2026-10-01', '2026-10-08')).toEqual(
      new Map([
        ['CARD-1', { posted_on: '2026-10-02', amount_minor: -1250 }],
        ['csv:00ff', { posted_on: '2026-10-08', amount_minor: 90000 }],
      ]),
    )
    expect(urls.map((u) => [u.pathname, [...u.searchParams.entries()]])).toEqual([
      [
        '/rest/v1/transactions',
        [
          ['select', 'external_id,posted_on,amount_minor'],
          ['account_id', 'eq.a1'],
          ['posted_on', 'gte.2026-09-24'],
          ['posted_on', 'lte.2026-10-15'],
          ['external_id', 'not.is.null'],
        ],
      ],
    ])
  })

  it('reports a refused read as an error, never as no rows', async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ code: '42501', message: 'permission denied', details: null, hint: null }, { status: 403 })
    const client = createWaypointClient('http://127.0.0.1:54321', 'sb_publishable_test-key', { storage: globalThis.localStorage, fetch: fetchImpl })
    await expect(recordedIds(client, 'a1', '2026-10-01', '2026-10-08')).rejects.toMatchObject({ kind: 'not_allowed' })
  })
})
