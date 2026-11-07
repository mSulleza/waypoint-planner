import { buildSnapshot, checkInput, expandPlan, occurrenceId, postBatchInput, type Rate, type Snapshot } from '@waypoint/core'
import { abroad } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sendEdit } from '../../../apps/app/src/data/edits'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'
import { categoryOffer, newCategory, openDraft, readDraft, type Draft } from '../../../apps/app/src/screens/add/add.model'
import { addCategory } from '../../../apps/app/src/screens/settings/settings.model'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-07'
const LOCALE = 'en-PH'

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

async function signUp(): Promise<{ client: WaypointClient; id: string }> {
  const client = createWaypointClient(url!, key!, { storage: memoryStorage() })
  const { data, error } = await client.auth.signUp({ email: `add-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { client, id: data.user.id }
}

async function call<T>(client: WaypointClient, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

async function snapshotOf(client: WaypointClient, rates: readonly Rate[]): Promise<Snapshot> {
  return buildSnapshot(await call<unknown>(client, 'export_household'), AS_OF, rates)
}

type IdMap = Record<'accounts' | 'plan_items', Record<string, string>>

// Abroad imported for a new user, with the ids the database gave its rows.
async function imported() {
  const { doc, rates } = abroad(AS_OF)
  const user = await signUp()
  const { ids } = await call<{ ids: IdMap }>(user.client, 'import_household', { p_doc: doc })
  return { user, ids, rates }
}

// What the sheet's Save sends: the draft read with fresh ids, checked by core, then post_batch.
async function save(client: WaypointClient, snapshot: Snapshot, draft: Draft): Promise<void> {
  const reading = readDraft(snapshot, draft, { locale: LOCALE, ids: { batch_id: randomUUID(), rows: [randomUUID(), randomUUID(), randomUUID()], transfer_id: randomUUID() }, allow_over: false, escrow: null })
  expect(reading.errors).toEqual({})
  const checked = checkInput(postBatchInput, reading.input)
  if (!checked.ok) throw new Error(checked.errors.join('; '))
  expect(await call<{ status: string }>(client, 'post_batch', { p_batch: checked.value })).toMatchObject({ status: 'applied' })
}

describe.skipIf(!url || !key)('The Add sheet through the REST API', () => {
  it('names a new category under row-level security, picks it, and saves the expense tagged with it', { timeout: 60_000 }, async () => {
    const { user, ids, rates } = await imported()
    const before = await snapshotOf(user.client, rates)
    const id = randomUUID()
    const named = newCategory(before, ' Tax adviser ', id, user.id)
    if (!('edit' in named)) throw new Error(named.error)
    await sendEdit(user.client, named.edit)
    // A retry from the same field sends the same id, so it adds no second category.
    await sendEdit(user.client, named.edit)
    const after = await snapshotOf(user.client, rates)
    expect(after.doc.categories.filter((c) => c.name.toLowerCase() === 'tax adviser')).toEqual([{ id, name: 'Tax adviser', archived_at: null }])

    // The name again in another case offers the one saved, and the database refuses a second one.
    expect(newCategory(after, 'TAX ADVISER', randomUUID(), user.id)).toMatchObject({ error: 'A category with this name exists.', use: { id } })
    await expect(sendEdit(user.client, addCategory(randomUUID(), 'tax adviser', user.id))).rejects.toMatchObject({ kind: 'rejected', code: 'category_exists' })
    // Another account cannot add a category to this household.
    const other = await signUp()
    await expect(sendEdit(other.client, addCategory(randomUUID(), 'Intruder', user.id))).rejects.toMatchObject({ kind: 'not_allowed' })

    const pesos = ids.accounts.pesos!
    expect(categoryOffer(after, AS_OF, id).chips.map((c) => c.id)).toContain(id)
    await save(user.client, after, { ...openDraft(after, null, { mode: 'out' }, pesos, LOCALE).draft, amount: '4500.00', category: id })
    const saved = await snapshotOf(user.client, rates)
    expect(saved.doc.categories.map((c) => c.name).sort()).toEqual(['Dining', 'Groceries', 'Home', 'Tax adviser'])
    expect(saved.doc.transactions.filter((t) => t.category_id === id).map((t) => [t.account_id, t.amount_minor, t.kind])).toEqual([[pesos, -450000, 'expense']])
  })

  it('records a bill from the plan with no category, and the occurrence is settled', { timeout: 60_000 }, async () => {
    const { user, ids, rates } = await imported()
    const snapshot = await snapshotOf(user.client, rates)
    const mobile = ids.plan_items.mobile!
    const opened = openDraft(snapshot, null, { plan_item_id: mobile, period: '2026-10-01' }, null, LOCALE).draft
    expect(opened).toMatchObject({ mode: 'out', amount: '1200.00', category: null, link: { plan_item_id: mobile, period: '2026-10-01' } })
    await save(user.client, snapshot, opened)

    const after = await snapshotOf(user.client, rates)
    const row = after.doc.transactions.find((t) => t.plan_item_id === mobile && t.period === '2026-10-01')
    expect(row).toMatchObject({ account_id: ids.accounts.pesos, amount_minor: -120000, kind: 'expense', category_id: null, description: 'Mobile plan' })
    expect(expandPlan(after).byId.get(occurrenceId(mobile, '2026-10-01'))).toMatchObject({ open_minor: 0, state: 'settled' })
  })
})
