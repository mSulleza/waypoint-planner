import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { waypointClient, type Db } from './client'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const TABLES = ['households', 'accounts', 'categories', 'plan_items', 'statements', 'transactions'] as const

interface User {
  db: Db
  id: string
}

async function signUp(): Promise<User> {
  const db = waypointClient(url!, key!)
  const { data, error } = await db.auth.signUp({ email: `schema-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { db, id: data.user.id }
}

// Table requests alone, without import_household: a household, a cash account and a category.
async function writeHousehold({ db, id }: User, name: string): Promise<{ account: string; category: string }> {
  const household = await db.from('households').insert({ id, base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-IE', track_from: '2026-10-01' })
  if (household.error) throw new Error(`households: ${household.error.message}`)
  const account = await db.from('accounts').insert({ household_id: id, name, kind: 'cash', currency: 'EUR', opening_date: '2026-10-01' }).select('id').single()
  if (account.error) throw new Error(`accounts: ${account.error.message}`)
  const category = await db.from('categories').insert({ household_id: id, name: `${name} food` }).select('id').single()
  if (category.error) throw new Error(`categories: ${category.error.message}`)
  return { account: (account.data as { id: string }).id, category: (category.data as { id: string }).id }
}

async function countsOf(db: Db): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of TABLES) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true })
    if (error) throw new Error(`${table}: ${error.message}`)
    counts[table] = count ?? -1
  }
  return counts
}

describe.skipIf(!url || !key)('the waypoint schema through the REST API', () => {
  it('serves no Waypoint table or function from public, the schema a client gets without one', async () => {
    const db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } })
    const table = await db.from('households').select('id')
    expect(table.error?.code).toBe('PGRST205')
    const fn = await db.rpc('export_household')
    expect(fn.error?.code).toBe('PGRST202')
  })

  it('refuses every table to a signed-out caller', async () => {
    const db = waypointClient(url!, key!)
    const refused = await Promise.all(TABLES.map(async (table) => (await db.from(table).select('*', { count: 'exact', head: true })).status))
    expect(refused).toEqual(TABLES.map(() => 401))
  })

  it('lets each user read and write its own rows, and never the other user’s', { timeout: 30_000 }, async () => {
    const a = await signUp()
    const b = await signUp()
    try {
      const rowsOfA = await writeHousehold(a, 'A')
      await writeHousehold(b, 'B')
      const own = { households: 1, accounts: 1, categories: 1, plan_items: 0, statements: 0, transactions: 0 }
      expect(await countsOf(a.db)).toEqual(own)
      expect(await countsOf(b.db)).toEqual(own)

      const seen = await b.db.from('accounts').select('household_id, name')
      expect(seen.data).toEqual([{ household_id: b.id, name: 'B' }])
      const renamed = await b.db.from('categories').update({ name: 'Taken' }).eq('id', rowsOfA.category).select('id')
      expect([renamed.error, renamed.data]).toEqual([null, []])
      const removed = await b.db.from('accounts').delete().eq('id', rowsOfA.account).select('id')
      expect([removed.error, removed.data]).toEqual([null, []])
      const planted = await b.db.from('categories').insert({ household_id: a.id, name: 'Planted' })
      expect(planted.error?.code).toBe('42501')

      const exported = await b.db.rpc('export_household')
      expect(exported.error).toBeNull()
      expect((exported.data as { accounts: { name: string }[] }).accounts.map((x) => x.name)).toEqual(['B'])

      const kept = await a.db.from('categories').select('id, name')
      expect(kept.data).toEqual([{ id: rowsOfA.category, name: 'A food' }])
      expect(await countsOf(a.db)).toEqual(own)
    } finally {
      await a.db.rpc('delete_my_account')
      await b.db.rpc('delete_my_account')
    }
  })
})
