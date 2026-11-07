import { buildSnapshot, runEngine, walkMetrics, type Snapshot, type WalkMetrics } from '@waypoint/core'
import { markSize, SAMPLES, type Sample } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { waypointClient, type Db } from './client'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-07'
const FIXTURES: { id: string; build: (asOf: string) => Sample }[] = [...SAMPLES, { id: 'mark-size', build: markSize }]
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

type IdMap = Record<string, Record<string, string>>

async function signUp(): Promise<Db> {
  const db = waypointClient(url!, key!)
  const { data, error } = await db.auth.signUp({ email: `metrics-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return db
}

async function call<T>(db: Db, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

// The same snapshot the app builds from one load: runEngine's walk, then core's metrics.
function metricsOf(snapshot: Snapshot): WalkMetrics {
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return walkMetrics(run.world.snapshot, run.walk)
}

// Lists follow the snapshot's id order, which import changes; sort them by the document id they name.
function byAccount(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(byAccount)
    const id = (v: unknown) => (typeof v === 'object' && v !== null && 'account_id' in v ? `${String(v.account_id)} ${'statement_id' in v ? String(v.statement_id) : ''}` : null)
    return items.every((v) => id(v) !== null) ? [...items].sort((a, b) => (id(a)! < id(b)! ? -1 : 1)) : items
  }
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, byAccount(v)]))
  return value
}

// Every imported uuid back to the document id it was made for.
function toDocumentIds(metrics: WalkMetrics, ids: IdMap): unknown {
  const back = new Map<string, string>()
  for (const table of Object.values(ids)) for (const [doc, fresh] of Object.entries(table)) back.set(fresh, doc)
  const text = JSON.stringify(metrics).replace(UUID, (id) => {
    const doc = back.get(id)
    if (doc === undefined) throw new Error(`no document id for ${id}`)
    return doc
  })
  return byAccount(JSON.parse(text))
}

describe.skipIf(!url || !key)('metrics through the database', () => {
  it.each(FIXTURES)('$id walks to the same metrics after import and export as its own snapshot', { timeout: 60_000 }, async ({ build }) => {
    const sample = build(AS_OF)
    const own = metricsOf(buildSnapshot(sample.doc, AS_OF, sample.rates))
    expect(own.cash.length).toBeGreaterThan(0)
    expect(own.cash.some((c) => c.lowest_minor !== 0)).toBe(true)
    const db = await signUp()
    try {
      const imported = await call<{ ids: IdMap }>(db, 'import_household', { p_doc: sample.doc })
      const exported = await call<unknown>(db, 'export_household')
      const fromDb = metricsOf(buildSnapshot(exported, AS_OF, sample.rates))
      expect(toDocumentIds(fromDb, imported.ids)).toEqual(byAccount(JSON.parse(JSON.stringify(own))))
    } finally {
      await db.rpc('delete_my_account')
    }
  })
})
