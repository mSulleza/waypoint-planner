import { buildSnapshot, ledgerSum, type ImportDoc, type Snapshot } from '@waypoint/core'
import { markSize, SAMPLES, type Sample } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { waypointClient, type Db } from './client'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-07'
const FIXTURES: { id: string; build: (asOf: string) => Sample }[] = [...SAMPLES, { id: 'mark-size', build: markSize }]

const TABLES = ['accounts', 'categories', 'plan_items', 'statements', 'transactions'] as const
type IdMap = Record<(typeof TABLES)[number] | 'transfers' | 'batches', Record<string, string>>

// Every field that holds an id, and the map that renames it.
const ID_FIELDS: Record<(typeof TABLES)[number], Record<string, keyof IdMap>> = {
  accounts: { id: 'accounts', funded_from_account_id: 'accounts' },
  categories: { id: 'categories' },
  plan_items: { id: 'plan_items', from_account_id: 'accounts', to_account_id: 'accounts', category_id: 'categories' },
  statements: { id: 'statements', account_id: 'accounts' },
  transactions: { id: 'transactions', account_id: 'accounts', category_id: 'categories', plan_item_id: 'plan_items', transfer_id: 'transfers', batch_id: 'batches' },
}

// The document as the import should have stored it: every id swapped for the one import_household returned.
function renamed(doc: ImportDoc, ids: IdMap): unknown {
  const out: Record<string, unknown> = { ...doc }
  for (const table of TABLES) {
    out[table] = doc[table].map((row) => {
      const copy: Record<string, unknown> = { ...row }
      for (const [field, map] of Object.entries(ID_FIELDS[table])) {
        const id = copy[field]
        if (typeof id !== 'string') continue
        const fresh = ids[map][id]
        if (fresh === undefined) throw new Error(`import_household returned no id for ${map} '${id}'`)
        copy[field] = fresh
      }
      return copy
    })
  }
  return out
}

async function signUp(): Promise<Db> {
  const db = waypointClient(url!, key!)
  const { data, error } = await db.auth.signUp({ email: `roundtrip-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return db
}

async function call<T>(db: Db, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

function sums(snapshot: Snapshot, ids: (accountId: string) => string): Record<string, number> {
  return Object.fromEntries(snapshot.doc.accounts.map((a) => [ids(a.id), ledgerSum(snapshot, a.id, AS_OF)]))
}

describe.skipIf(!url || !key)('export then import', () => {
  it.each(FIXTURES)('$id keeps every row, field and ledger sum through two households', { timeout: 30_000 }, async ({ build }) => {
    const sample = build(AS_OF)
    const source = buildSnapshot(sample.doc, AS_OF, sample.rates)
    const users: Db[] = []
    try {
      const a = await signUp()
      users.push(a)
      const b = await signUp()
      users.push(b)
      const intoA = await call<{ household_id: string; ids: IdMap }>(a, 'import_household', { p_doc: sample.doc })
      const exportA = await call<unknown>(a, 'export_household')
      const fromA = buildSnapshot(exportA, AS_OF, sample.rates)
      const intoB = await call<{ household_id: string; ids: IdMap }>(b, 'import_household', { p_doc: exportA })
      const exportB = await call<unknown>(b, 'export_household')
      const fromB = buildSnapshot(exportB, AS_OF, sample.rates)

      expect(intoB.household_id).not.toBe(intoA.household_id)
      const counts = (s: Snapshot) => TABLES.map((table) => s.doc[table].length)
      expect(counts(fromA)).toEqual(counts(source))
      expect(counts(fromB)).toEqual(counts(source))

      expect(source.doc.accounts.some((acc) => ledgerSum(source, acc.id, AS_OF) !== acc.opening_balance_minor)).toBe(true)
      const bySource = sums(source, (id) => id)
      const inA = new Map(Object.entries(intoA.ids.accounts).map(([doc, fresh]) => [fresh, doc]))
      const inB = new Map(Object.entries(intoB.ids.accounts).map(([fromAId, fresh]) => [fresh, inA.get(fromAId)!]))
      expect(sums(fromA, (id) => inA.get(id)!)).toEqual(bySource)
      expect(sums(fromB, (id) => inB.get(id)!)).toEqual(bySource)

      expect(fromA.doc).toEqual(buildSnapshot(renamed(source.doc, intoA.ids), AS_OF, sample.rates).doc)
      expect(fromB.doc).toEqual(buildSnapshot(renamed(fromA.doc, intoB.ids), AS_OF, sample.rates).doc)

      await call(a, 'delete_my_account')
      expect(await call(a, 'export_household')).toBeNull()
      expect(await call(b, 'export_household')).toEqual(exportB)
      await call(b, 'delete_my_account')
      expect(await call(b, 'export_household')).toBeNull()
    } finally {
      await Promise.all(users.map((db) => db.rpc('delete_my_account')))
    }
  })
})
