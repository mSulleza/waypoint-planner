import './phone-setup'
import { AuthClient, type GoTrueClient } from '@supabase/auth-js'
import { PostgrestClient } from '@supabase/postgrest-js'
import { DataError, type RpcFailure } from './errors'

// Where the auth client keeps the session (a Supabase Session as JSON), so storedUserId can read it before the client starts.
export const AUTH_STORAGE_KEY = 'waypoint:auth'

// Every table and database function is in this schema, so Waypoint can share a project whose public schema has other tables (spec §14).
const DB_SCHEMA = 'waypoint'

// Sign-in, database functions and table requests only: supabase-js would also ship Realtime, Storage and Functions clients the app never calls.
export interface WaypointClient {
  auth: GoTrueClient
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcFailure | null; status: number }>
  // To-do's marks: one update or delete on a table, under the same row-level security as every read.
  from: PostgrestClient['from']
}

export interface ClientOptions {
  storage?: Storage
  // Looked up on each call when left out, as supabase-js does.
  fetch?: typeof fetch
}

export function createWaypointClient(url: string, key: string, options: ClientOptions = {}): WaypointClient {
  const base = url.endsWith('/') ? url : `${url}/`
  const send: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init))
  const auth = new AuthClient({
    url: new URL('auth/v1', base).href,
    headers: { Authorization: `Bearer ${key}`, apikey: key },
    storageKey: AUTH_STORAGE_KEY,
    storage: options.storage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    fetch: options.fetch,
  })
  // The headers supabase-js sends: the key names the project, and the session's token (the key when signed out) is the caller.
  const rest = new PostgrestClient(new URL('rest/v1', base).href, {
    schema: DB_SCHEMA,
    fetch: async (input, init) => {
      const { data } = await auth.getSession()
      const headers = new Headers(init?.headers)
      if (!headers.has('apikey')) headers.set('apikey', key)
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${data.session?.access_token ?? key}`)
      return send(input, { ...init, headers })
    },
  })
  return { auth, rpc: (fn, args) => rest.rpc(fn, args), from: (table: string) => rest.from(table) }
}

let client: WaypointClient | undefined

// Made on first use, so importing this reads no storage and a missing setting becomes a labelled error, not a crash.
export function getSupabase(): WaypointClient {
  if (client) return client
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new DataError('config', 'This copy of Waypoint has no server address set.', { technical: 'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set; apps/app/.env.example lists them.' })
  client = createWaypointClient(url, key, { storage: globalThis.localStorage })
  return client
}

function storedUser(): { id?: unknown; email?: unknown } | null {
  try {
    const text = globalThis.localStorage?.getItem(AUTH_STORAGE_KEY)
    if (!text) return null
    return (JSON.parse(text) as { user?: { id?: unknown; email?: unknown } } | null)?.user ?? null
  } catch {
    return null
  }
}

const filled = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

// The account whose session is saved on this device, read at once (the auth client may wait on the network before it reports).
export function storedUserId(): string | null {
  return filled(storedUser()?.id)
}

// Its email address, so the delete page names the account it removes.
export function storedEmail(): string | null {
  return filled(storedUser()?.email)
}
