import { abroad } from '@waypoint/core/fixtures'
import type { RpcFailure } from './errors'
import type { HouseholdClient } from './query'

export const AS_OF = '2026-10-07'
// Noon in Madrid on AS_OF.
export const NOON = new Date('2026-10-07T10:00:00Z')

// The browser's storage, in memory; vi.stubGlobal puts it on globalThis.
export function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, String(v)),
  }
}

export interface Reply {
  data: unknown
  error: RpcFailure | null
  status: number
}

type Session = { user: { id: string } } | null

// Stands in for the Supabase server: a session (or none, or one that changes) and one reply per function, which may arrive later; signOut ends the session and is recorded as a call.
export function fakeClient(replies: Record<string, () => Reply | Promise<Reply>>, session: Session | (() => Session) = { user: { id: 'user-a' } }, authError: unknown = null): HouseholdClient & { calls: string[] } {
  const calls: string[] = []
  let ended = false
  const current = () => (ended ? null : typeof session === 'function' ? session() : session)
  return {
    calls,
    auth: {
      getSession: async () => ({ data: { session: current() }, error: ended ? null : authError }),
      signOut: async () => {
        calls.push('signOut')
        ended = true
        return { error: null }
      },
    },
    rpc: async (fn: string) => {
      calls.push(fn)
      const reply = replies[fn]
      if (!reply) throw new Error(`no reply for ${fn}`)
      return reply()
    },
  }
}

// A promise settled from outside, for a reply that arrives while something else happens.
export function later<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

// A Supabase Auth session as the server returns it after a sign-in, good for the next hour.
export const SESSION = {
  access_token: 'token-a',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'refresh-a',
  user: { id: 'user-a', aud: 'authenticated', role: 'authenticated', email: 'a@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-10-08T00:00:00Z' },
}

export const abroadDoc = () => abroad(AS_OF).doc
export const ok = (data: unknown): Reply => ({ data, error: null, status: 200 })
