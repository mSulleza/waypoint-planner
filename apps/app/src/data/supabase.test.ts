import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rpcError } from './errors'
import { AUTH_STORAGE_KEY, createWaypointClient, storedUserId } from './supabase'
import { memoryStorage } from './test-helpers'

const URL_BASE = 'http://127.0.0.1:54321'
const KEY = 'sb_publishable_test-key'

interface Sent {
  url: string
  method: string
  headers: Headers
}

// Stands in for the Supabase server's auth and database endpoints.
function server(rpc: () => Promise<Response> = async () => Response.json({ version: 1 })) {
  const sent: Sent[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    sent.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
    if (url.startsWith(`${URL_BASE}/auth/v1/token`)) {
      const user = { id: 'user-a', aud: 'authenticated', role: 'authenticated', email: 'a@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-10-08T00:00:00Z' }
      return Response.json({ access_token: 'token-a', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-a', user })
    }
    if (url === `${URL_BASE}/rest/v1/rpc/export_household`) return rpc()
    return new Response('{}', { status: 404 })
  }
  return { sent, fetchImpl }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createWaypointClient', () => {
  it('calls database functions with the publishable key, and with the session token once signed in', async () => {
    const { sent, fetchImpl } = server()
    const client = createWaypointClient(URL_BASE, KEY, { storage: globalThis.localStorage, fetch: fetchImpl })
    const before = await client.rpc('export_household')
    expect([before.data, before.error, before.status]).toEqual([{ version: 1 }, null, 200])
    const signedOut = sent.at(-1)!
    expect([signedOut.method, signedOut.headers.get('apikey'), signedOut.headers.get('authorization')]).toEqual(['POST', KEY, `Bearer ${KEY}`])

    const { error } = await client.auth.signInWithPassword({ email: 'a@example.test', password: 'secret-password' })
    expect(error).toBeNull()
    expect(sent.find((s) => s.url.includes('/auth/v1/token'))!.headers.get('apikey')).toBe(KEY)
    await client.rpc('export_household')
    const signedIn = sent.at(-1)!
    expect([signedIn.url, signedIn.headers.get('apikey'), signedIn.headers.get('authorization')]).toEqual([`${URL_BASE}/rest/v1/rpc/export_household`, KEY, 'Bearer token-a'])
  })

  it('sends database functions and table requests to the waypoint schema', async () => {
    const { sent, fetchImpl } = server()
    const client = createWaypointClient(URL_BASE, KEY, { storage: globalThis.localStorage, fetch: fetchImpl })
    await client.rpc('export_household')
    await client.from('households').select('id')
    await client.from('transactions').delete().eq('id', 'r1')
    expect(sent.map((s) => [s.method, s.headers.get('content-profile'), s.headers.get('accept-profile')])).toEqual([
      ['POST', 'waypoint', null],
      ['GET', null, 'waypoint'],
      ['DELETE', 'waypoint', null],
    ])
  })

  it('answers a call that never reached the server with status 0, which reads as offline', async () => {
    const { fetchImpl } = server(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createWaypointClient(URL_BASE, KEY, { storage: globalThis.localStorage, fetch: fetchImpl })
    const { error, status } = await client.rpc('export_household')
    expect(status).toBe(0)
    expect(rpcError('export_household', error!, status).kind).toBe('network')
  })
})

describe('storedUserId', () => {
  it('reads the account the auth client saved, before the client starts, and nothing once it signs out', async () => {
    expect(storedUserId()).toBeNull()
    const { fetchImpl } = server()
    const client = createWaypointClient(URL_BASE, KEY, { storage: globalThis.localStorage, fetch: fetchImpl })
    await client.auth.signInWithPassword({ email: 'a@example.test', password: 'secret-password' })
    expect(globalThis.localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull()
    expect(storedUserId()).toBe('user-a')
    await client.auth.signOut({ scope: 'local' })
    expect(storedUserId()).toBeNull()
  })

  it('reads a damaged or foreign value as nobody', () => {
    globalThis.localStorage.setItem(AUTH_STORAGE_KEY, '{not json')
    expect(storedUserId()).toBeNull()
    globalThis.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user: { id: 7 } }))
    expect(storedUserId()).toBeNull()
  })
})
