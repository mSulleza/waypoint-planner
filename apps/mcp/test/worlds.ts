import { buildSnapshot, runEngine, type Snapshot } from '@waypoint/core'
import type { Sample, SampleDoc } from '@waypoint/core/fixtures'
import { createHash } from 'node:crypto'
import type { Reply, World } from '../src/data'
import type { WriteIO } from '../src/tools/write/shape'

// Database ids are uuids; a fixture's readable id maps to a fixed one, so a batch passes post_batch's schema.
export function uuid(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-9${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const ID_FIELDS = ['id', 'account_id', 'funded_from_account_id', 'from_account_id', 'to_account_id', 'category_id', 'plan_item_id', 'transfer_id'] as const

export function withUuids(doc: SampleDoc): void {
  for (const table of [doc.accounts, doc.categories, doc.plan_items, doc.statements, doc.transactions] as Record<string, unknown>[][]) {
    for (const row of table) for (const field of ID_FIELDS) if (typeof row[field] === 'string') row[field] = uuid(row[field])
  }
}

// The samples' own made-up rates (PHP 70), so the figures match core's fixture facts.
export function worldAt(build: (asOf: string) => Sample, asOf: string, edit?: (doc: SampleDoc) => void): World {
  const sample = build(asOf)
  edit?.(sample.doc)
  const run = runEngine(buildSnapshot(sample.doc, asOf, sample.rates))
  if (!run.ok) throw new Error(`the sample did not walk: ${JSON.stringify(run.errors)}`)
  return { snapshot: run.world.snapshot, walk: run.walk, rates: { rates: sample.rates, day: asOf, source: 'live', problem: null }, web_url: 'http://localhost:8090' }
}

// Every name and description a person typed in the household.
export function typedText(snapshot: Snapshot): Set<string> {
  const { accounts, plan_items, categories, transactions } = snapshot.doc
  return new Set([...accounts.map((a) => a.name), ...plan_items.map((i) => i.name), ...categories.map((c) => c.name), ...transactions.map((t) => t.description)].filter((t) => t.length > 0))
}

// Strings outside data_text that hold typed text, by path.
export function typedOutside(value: unknown, typed: Set<string>, path = '$'): string[] {
  if (typeof value === 'string') return [...typed].some((t) => value === t || (t.length >= 5 && value.includes(t))) ? [`${path}: ${value}`] : []
  if (Array.isArray(value)) return value.flatMap((v, i) => typedOutside(v, typed, `${path}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => (k === 'data_text' ? [] : typedOutside(v, typed, `${path}.${k}`)))
  return []
}

export const OWNER = uuid('owner')

type Call = [method: string, args: unknown[]]

// A client that records every call a request makes and answers with the scripted reply, as PostgREST would.
function recording(reply: Reply): { db: unknown; calls: Call[] } {
  const calls: Call[] = []
  const chain: object = new Proxy(
    {},
    {
      get: (_, prop) => (prop === 'then' ? (resolve: (r: Reply) => void) => resolve(reply) : (...args: unknown[]) => (calls.push([String(prop), args]), chain)),
    },
  )
  const auth = { getSession: async () => ({ data: { session: { user: { id: OWNER } } } }) }
  const db = new Proxy({}, { get: (_, prop) => (prop === 'auth' ? auth : prop === 'then' ? undefined : (...args: unknown[]) => (calls.push([String(prop), args]), chain)) })
  return { db, calls }
}

export interface FakeIO extends WriteIO {
  // Each request's calls, in the order sent.
  requests: Call[][]
}

// A write's input and output with no database: replies answer requests in turn, and `after` stands for the second export.
export function fakeIO(before: World, replies: Reply[] = [], after: World = before): FakeIO {
  const requests: Call[][] = []
  return {
    before,
    requests,
    after: async () => after,
    send: async (request) => {
      const reply = replies.shift()
      if (!reply) throw new Error('no reply scripted for this request')
      const { db, calls } = recording(reply)
      requests.push(calls)
      return request(db as Parameters<typeof request>[0])
    },
  }
}

export const ok = (data: unknown): Reply => ({ data, error: null, status: 200 })
export const refused = (code: string, message: string, details: unknown = null, status = 400): Reply => ({ data: null, error: { code, message, details: details === null || typeof details === 'string' ? details : JSON.stringify(details), hint: null }, status })
