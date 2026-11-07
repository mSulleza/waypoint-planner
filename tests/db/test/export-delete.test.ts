import { createClient } from '@supabase/supabase-js'
import { buildSnapshot, ledgerSum, runEngine, type Rate, type Snapshot } from '@waypoint/core'
import { abroad, SAMPLES } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deleteAccount } from '../../../apps/app/src/data/delete-account'
import { authError } from '../../../apps/app/src/data/errors'
import { exportHousehold } from '../../../apps/app/src/data/export'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-07'
// Noon UTC is 7 Oct in every sample's zone.
const NOON = new Date(`${AS_OF}T12:00:00Z`)
const TABLES = ['households', 'accounts', 'categories', 'plan_items', 'statements', 'transactions'] as const

function memoryStorage(): Storage {
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

interface User {
  client: WaypointClient
  email: string
  password: string
}

async function signUp(): Promise<User> {
  const client = createWaypointClient(url!, key!, { storage: memoryStorage() })
  const email = `export-delete-${randomUUID()}@example.test`
  const password = randomUUID()
  const { data, error } = await client.auth.signUp({ email, password })
  if (error || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { client, email, password }
}

async function importInto(client: WaypointClient, doc: unknown): Promise<Record<string, string>> {
  const { data, error } = await client.rpc('import_household', { p_doc: doc })
  if (error) throw new Error(`import_household: ${error.message}`)
  return (data as { ids: { accounts: Record<string, string> } }).ids.accounts
}

async function snapshotOf(client: WaypointClient, rates: readonly Rate[]): Promise<Snapshot> {
  const { data, error } = await client.rpc('export_household')
  if (error) throw new Error(`export_household: ${error.message}`)
  return buildSnapshot(data, AS_OF, rates)
}

// Each account's balance today and its end-of-day balance on every walked day, under the name the map gives its id.
function balances(snapshot: Snapshot, nameOf: (id: string) => string): Record<string, { today: number; days: number[] }> {
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return Object.fromEntries(snapshot.doc.accounts.map((a) => [nameOf(a.id), { today: ledgerSum(snapshot, a.id, AS_OF), days: [...(run.walk.balances.get(a.id) ?? [])] }]))
}

// Rows a token can read in each household table. Row-level security keys on the token's user id alone, so a deleted account's token still sees any row the delete left.
async function rowsSeenBy(token: string): Promise<Record<string, number>> {
  const db = createClient(url!, key!, { db: { schema: 'waypoint' }, global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
  const counts: Record<string, number> = {}
  for (const table of TABLES) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true })
    if (error) throw new Error(`${table}: ${error.message}`)
    counts[table] = count ?? -1
  }
  return counts
}

// The sign-out the app runs after a delete, without its caches: the session leaves this client.
const signOutOf = (client: WaypointClient) => async () => {
  const { error } = await client.auth.signOut({ scope: 'local' })
  return error ? authError(error) : null
}

describe.skipIf(!url || !key)('Export data and Delete account through the REST API', () => {
  it.each(SAMPLES)('$id: the exported file imports into a new account with every account’s balance equal, today and on every walked day', { timeout: 60_000 }, async ({ build }) => {
    const sample = build(AS_OF)
    const users: User[] = []
    try {
      const a = await signUp()
      users.push(a)
      const b = await signUp()
      users.push(b)
      await importInto(a.client, sample.doc)
      const file = await exportHousehold(a.client, NOON)
      expect(file?.name).toBe(`waypoint-export-${AS_OF}.json`)
      const exported: unknown = JSON.parse(file!.text)
      const intoB = await importInto(b.client, exported)

      // A as the database holds it, read apart from the file, so a file that drops something cannot match.
      const fromA = await snapshotOf(a.client, sample.rates)
      const fromB = await snapshotOf(b.client, sample.rates)
      const backToA = new Map(Object.entries(intoB).map(([aId, bId]) => [bId, aId]))
      expect(fromB.doc.accounts).toHaveLength(sample.doc.accounts.length)
      const inA = balances(fromA, (id) => id)
      expect(balances(fromB, (id) => backToA.get(id)!)).toEqual(inA)
      // Not a vacuous match: some account has moved off its opening balance, and every walk has days.
      expect(fromA.doc.accounts.some((acc) => inA[acc.id]!.today !== acc.opening_balance_minor)).toBe(true)
      expect(Object.values(inA).every((v) => v.days.length > 0)).toBe(true)
    } finally {
      await Promise.all(users.map((u) => u.client.rpc('delete_my_account')))
    }
  })

  it('deletes the sign-in and every row of the household, and signs the client out', { timeout: 30_000 }, async () => {
    const a = await signUp()
    const { data } = await a.client.auth.getSession()
    const token = data.session!.access_token
    await importInto(a.client, abroad(AS_OF).doc)
    const before = await rowsSeenBy(token)
    expect(Object.values(before).every((n) => n > 0)).toBe(true)

    expect(await deleteAccount({ rpc: a.client.rpc, signOut: signOutOf(a.client) })).toBeNull()

    expect(await rowsSeenBy(token)).toEqual({ households: 0, accounts: 0, categories: 0, plan_items: 0, statements: 0, transactions: 0 })
    expect((await a.client.auth.getSession()).data.session).toBeNull()
    const again = await a.client.auth.signInWithPassword({ email: a.email, password: a.password })
    expect(again.error?.code).toBe('invalid_credentials')
  })

  it('refuses a caller with no session, and leaves another account untouched', { timeout: 30_000 }, async () => {
    const a = await signUp()
    const b = await signUp()
    try {
      await importInto(b.client, abroad(AS_OF).doc)
      const { data } = await b.client.auth.getSession()
      const before = await rowsSeenBy(data.session!.access_token)
      const anonymous = createWaypointClient(url!, key!, { storage: memoryStorage() })
      expect((await deleteAccount({ rpc: anonymous.rpc, signOut: signOutOf(anonymous) }))?.kind).toBe('signed_out')
      expect(await deleteAccount({ rpc: a.client.rpc, signOut: signOutOf(a.client) })).toBeNull()
      expect(await rowsSeenBy(data.session!.access_token)).toEqual(before)
      expect((await b.client.auth.getUser()).data.user?.email).toBe(b.email)
    } finally {
      await Promise.all([a, b].map((u) => u.client.rpc('delete_my_account')))
    }
  })
})
