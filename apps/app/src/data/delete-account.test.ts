import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { followAccount, type Account } from './account'
import { deleteAccount } from './delete-account'
import { createQueryClient } from './query'
import { readSaved, writeSaved } from './saved'
import { signOut } from './signout'
import { AUTH_STORAGE_KEY, createWaypointClient, storedUserId } from './supabase'
import { abroadDoc, memoryStorage, NOON, SESSION } from './test-helpers'

type Reply = { status: number; body?: unknown } | 'offline'

// Replies as the local Supabase answered curl on 9 Oct 2026: delete_my_account is 204, and a sign-out after it is 403 user_not_found, which auth-js lets pass.
const DELETED: Reply = { status: 204 }
const LOGOUT_AFTER: Reply = { status: 403, body: { code: 403, error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' } }
const NOT_SIGNED_IN: Reply = { status: 401, body: { code: '42501', details: null, hint: null, message: 'permission denied for function delete_my_account' } }
const SERVER_DOWN: Reply = { status: 503, body: { code: 'PGRST002', details: null, hint: null, message: 'Could not query the database for the schema cache. Retrying.' } }

function server(remove: Reply) {
  const sent: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname.slice(1)
    sent.push(path)
    const reply = path === 'rest/v1/rpc/delete_my_account' ? remove : path === 'auth/v1/logout' ? LOGOUT_AFTER : { status: 404, body: {} }
    if (reply === 'offline') throw new TypeError('Failed to fetch')
    return reply.body === undefined ? new Response(null, { status: reply.status }) : Response.json(reply.body, { status: reply.status })
  }
  const client = createWaypointClient('http://127.0.0.1:54321', 'sb_publishable_test-key', { storage: globalThis.localStorage, fetch: fetchImpl })
  const queryClient = createQueryClient()
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
  const run = async () => {
    const result = await deleteAccount({ rpc: client.rpc, signOut: () => signOut({ signOut: () => client.auth.signOut({ scope: 'local' }), queryClient }, 'deleted') })
    stop()
    void client.auth.stopAutoRefresh()
    return result
  }
  return { sent, seen, run }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  globalThis.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION))
  writeSaved({ user_id: 'user-a', fetched_at: NOON.toISOString(), doc: abroadDoc(), rates: [] })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deleteAccount', () => {
  it('deletes the account on the server, then signs this device out with the reason, so Welcome says so and nothing of it stays', async () => {
    const { sent, seen, run } = server(DELETED)
    expect(await run()).toBeNull()
    expect(sent).toEqual(['rest/v1/rpc/delete_my_account', 'auth/v1/logout'])
    expect(seen).toEqual([{ generation: 1, owner: null, ended: false, deleted: true }])
    expect(storedUserId()).toBeNull()
    expect(globalThis.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(readSaved()).toBeNull()
  })

  it('keeps the session and the saved copy when the server refuses or cannot be reached, and says which', async () => {
    for (const [reply, kind, message] of [
      [NOT_SIGNED_IN, 'signed_out', 'Your session has ended. Sign in again.'],
      ['offline', 'network', 'Waypoint could not reach the server.'],
      [SERVER_DOWN, 'server', 'The server had a problem. Try again in a moment.'],
    ] as const) {
      const { sent, seen, run } = server(reply)
      const failed = await run()
      expect([failed?.kind, failed?.message]).toEqual([kind, message])
      expect(sent).toEqual(['rest/v1/rpc/delete_my_account'])
      expect(seen).toEqual([])
      expect(storedUserId()).toBe('user-a')
      expect(readSaved()?.user_id).toBe('user-a')
    }
  })
})
