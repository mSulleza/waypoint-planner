import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { followAccount, type Account } from './account'
import { createQueryClient, SUPABASE_KEY } from './query'
import { readSaved, writeSaved } from './saved'
import { signOut } from './signout'
import { AUTH_STORAGE_KEY, createWaypointClient, storedUserId } from './supabase'
import { abroadDoc, memoryStorage, NOON, SESSION } from './test-helpers'

// Stands in for the Auth server: a password sign-in returns SESSION and a sign-out is accepted.
function authServer() {
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
    if (path === '/auth/v1/token') return Response.json(SESSION)
    if (path === '/auth/v1/logout') return new Response(null, { status: 204 })
    return Response.json({}, { status: 404 })
  }
  return createWaypointClient('http://127.0.0.1:54321', 'sb_publishable_test-key', { storage: globalThis.localStorage, fetch: fetchImpl })
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  globalThis.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('followAccount', () => {
  it('tells a sign-out the person asked for from a session that ended by itself, and starts a new query for each account', async () => {
    const client = authServer()
    const queryClient = createQueryClient()
    queryClient.setQueryData([...SUPABASE_KEY, 0], { kind: 'no_household', user_id: 'user-a' })
    let account: Account = { generation: 0, owner: storedUserId(), ended: false, deleted: false }
    const seen: Account[] = []
    const stop = followAccount(
      client.auth,
      queryClient,
      () => account,
      (next) => {
        account = next
        seen.push(next)
      },
    )

    expect(await signOut({ signOut: () => client.auth.signOut({ scope: 'local' }), queryClient })).toBeNull()
    expect(queryClient.getQueryData([...SUPABASE_KEY, 0])).toBeUndefined()
    expect((await client.auth.signInWithPassword({ email: 'a@example.test', password: 'reviewer-password' })).error).toBeNull()
    writeSaved({ user_id: 'user-a', fetched_at: NOON.toISOString(), doc: abroadDoc(), rates: [] })
    // The household load ending a refused session, or another tab signing out: no sign-out was asked for here.
    expect((await client.auth.signOut({ scope: 'local' })).error).toBeNull()
    stop()
    void client.auth.stopAutoRefresh()

    expect(seen).toEqual([
      { generation: 1, owner: null, ended: false, deleted: false },
      { generation: 2, owner: 'user-a', ended: false, deleted: false },
      { generation: 3, owner: null, ended: true, deleted: false },
    ])
    expect(readSaved()).toBeNull()
  })
})
