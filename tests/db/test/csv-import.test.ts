import { buildSnapshot, type Rate, type Snapshot } from '@waypoint/core'
import { csvDrafts, guessCsvMapping, readCsv, readCsvMappingDraft, savedMapping, type CsvMapping, type CsvTable } from '@waypoint/core/csv'
import { abroad } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sendEdit } from '../../../apps/app/src/data/edits'
import { recordedIds } from '../../../apps/app/src/data/imports'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'
import { importBatch, reviewRows } from '../../../apps/app/src/screens/import/import.model'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-09'
const fixture = (name: string) => readFileSync(new URL(`../../../packages/core/test/fixtures/csv/${name}`, import.meta.url), 'utf8')

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
  accounts: Record<string, string>
  rates: readonly Rate[]
}

async function call<T>(client: WaypointClient, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

// A new user with the abroad sample, whose Main (EUR) and Tax (EUR) accounts open on 1 September 2026.
async function imported(): Promise<User> {
  const { doc, rates } = abroad(AS_OF)
  const client = createWaypointClient(url!, key!, { storage: memoryStorage() })
  const [email, password] = [`csv-${randomUUID()}@example.test`, randomUUID()]
  const { error } = await client.auth.signUp({ email, password })
  if (error) throw new Error(`sign-up failed: ${error.message}`)
  const { ids } = await call<{ ids: { accounts: Record<string, string> } }>(client, 'import_household', { p_doc: doc })
  return { client, email, password, accounts: ids.accounts, rates }
}

// Another browser profile: the same person, signed in afresh with nothing on the device.
async function secondProfile(user: User): Promise<WaypointClient> {
  const client = createWaypointClient(url!, key!, { storage: memoryStorage() })
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error) throw new Error(`sign-in failed: ${error.message}`)
  return client
}

async function snapshotOf(user: User, client = user.client): Promise<Snapshot> {
  return buildSnapshot(await call<unknown>(client, 'export_household'), AS_OF, user.rates)
}

function table(text: string): CsvTable {
  const read = readCsv(text)
  if (!read.ok) throw new Error(read.error)
  return read.table
}

// The review as the screen builds it: drafts, the one read of ids already on the account, and the ticked rows as one batch.
async function review(user: User, client: WaypointClient, accountId: string, file: CsvTable, mapping: CsvMapping) {
  const snapshot = await snapshotOf(user, client)
  const account = snapshot.doc.accounts.find((a) => a.id === accountId)!
  const read = csvDrafts(file, mapping, account)
  if (!read.ok) throw new Error(read.errors.join('; '))
  const days = { from: read.value.drafts.map((d) => d.posted_on).sort()[0]!, to: read.value.drafts.map((d) => d.posted_on).sort().at(-1)! }
  const recorded = await recordedIds(client, accountId, days.from, days.to)
  const rows = reviewRows(snapshot, accountId, read.value.drafts, recorded, () => randomUUID())
  return { snapshot, rows, batch: importBatch(accountId, rows, new Map(), randomUUID(), snapshot.doc.categories) }
}

const countBy = (snapshot: Snapshot, accountId: string) => snapshot.doc.transactions.filter((t) => t.account_id === accountId).length

describe.skipIf(!url || !key)('CSV import through post_batch and the REST API', () => {
  it('imports a made-up Wise file as one batch, greys every row the second time, and Undo deletes exactly that batch', { timeout: 60_000 }, async () => {
    const user = await imported()
    const main = user.accounts.main!
    const wise = table(fixture('wise-statement.csv'))
    const guessed = readCsvMappingDraft(guessCsvMapping(wise, 'en-PH'))
    if (!guessed.ok) throw new Error(guessed.errors.join('; '))
    const mapping = guessed.value
    expect(mapping).toEqual({ date: 'Date', date_order: 'dmy', amount: { column: 'Amount' }, decimal: '.', description: 'Description', reference: 'TransferWise ID' })

    // The mapping is saved on the account, so a second browser profile maps the next file by itself.
    await sendEdit(user.client, { kind: 'csv_mapping', account_id: main, mapping })
    const other = await secondProfile(user)
    const saved = (await snapshotOf(user, other)).doc.accounts.find((a) => a.id === main)?.csv_mapping
    expect(savedMapping(saved, wise)).toEqual(mapping)

    const first = await review(user, user.client, main, wise, mapping)
    const before = countBy(first.snapshot, main)
    expect(first.rows.filter((r) => r.recorded)).toEqual([])
    expect(first.batch?.rows).toHaveLength(8)
    const applied = await call<{ status: string; inserted: number }>(user.client, 'post_batch', { p_batch: first.batch })
    expect(applied).toMatchObject({ status: 'applied', inserted: 8 })

    // The same file again, on the other profile: every row is greyed and nothing is left to send.
    const again = await review(user, other, main, wise, mapping)
    expect(again.rows.map((r) => r.recorded)).toEqual(Array(8).fill(true))
    expect(again.batch).toBeNull()

    // A device that reviewed before the import still holds the rows ticked: post_batch names each one, and writes none.
    const stale = { batch_id: randomUUID(), rows: first.batch!.rows.map((r) => ({ ...r, id: randomUUID() })) }
    const refused = await user.client.rpc('post_batch', { p_batch: stale })
    expect(refused.error?.message).toMatch(/^already_recorded: /)
    expect(JSON.parse(refused.error?.details ?? '{}')).toMatchObject({ error: 'already_recorded', external_ids: first.batch!.rows.map((r) => r.external_id) })

    // Another save on the same account, outside the import, survives its Undo.
    const kept = { batch_id: randomUUID(), rows: [{ id: randomUUID(), account_id: main, posted_on: '2026-10-08', amount_minor: -500, kind: 'expense', category_id: null, description: 'Kept', transfer_id: null, plan_item_id: null, period: null, external_id: null }] }
    await call(user.client, 'post_batch', { p_batch: kept })
    await sendEdit(other, { kind: 'delete_batch', batch_id: first.batch!.batch_id })
    const after = await snapshotOf(user)
    expect(after.doc.transactions.filter((t) => t.batch_id === first.batch!.batch_id)).toEqual([])
    expect(after.doc.transactions.filter((t) => t.batch_id === kept.batch_id).map((t) => t.description)).toEqual(['Kept'])
    expect(countBy(after, main)).toBe(before + 1)
    // Undo twice: the second finds nothing, so it says the rows changed elsewhere.
    await expect(sendEdit(user.client, { kind: 'delete_batch', batch_id: first.batch!.batch_id })).rejects.toMatchObject({ code: 'stale' })
  })

  it('keeps three identical rows apart on the first import and finds all of them on the second', { timeout: 60_000 }, async () => {
    const user = await imported()
    const tax = user.accounts.tax!
    const file = table(fixture('paid-out-in.csv'))
    const mapping: CsvMapping = { date: 'Date', date_order: 'dmy', amount: { debit: 'Paid out', credit: 'Paid in' }, decimal: '.', description: 'Description', reference: null }
    const first = await review(user, user.client, tax, file, mapping)
    expect(first.batch?.rows.map((r) => [r.amount_minor, r.kind, r.description])).toEqual([
      [-320, 'expense', 'CORNER SHOP'],
      [-320, 'expense', 'CORNER SHOP'],
      [-320, 'expense', 'CORNER SHOP'],
      [125000, 'income', 'EXAMPLE LTD, SALARY'],
      [-1875, 'expense', 'CITY WATER'],
    ])
    await call(user.client, 'post_batch', { p_batch: first.batch })
    const again = await review(user, user.client, tax, file, mapping)
    expect(again.rows.every((r) => r.recorded)).toBe(true)
    expect(again.batch).toBeNull()
  })
})
