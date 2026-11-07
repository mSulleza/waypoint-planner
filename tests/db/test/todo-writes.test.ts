import { buildSnapshot, fxBreakeven, occurrenceId, runEngine, type Rate, type Snapshot } from '@waypoint/core'
import { abroad, type Sample } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sendEdit, type Edit } from '../../../apps/app/src/data/edits'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'
import { linkChoices, todoModel, type ItemRow } from '../../../apps/app/src/screens/months/todo.model'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-07'

// The browser's storage, in memory, so each user keeps its own session.
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

// The app's own client: sign-in, database functions and the table requests To-do sends.
async function signUp(): Promise<WaypointClient> {
  const client = createWaypointClient(url!, key!, { storage: memoryStorage() })
  const { data, error } = await client.auth.signUp({ email: `todo-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return client
}

async function call<T>(client: WaypointClient, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

type IdMap = Record<'plan_items' | 'transactions' | 'accounts', Record<string, string>>

// Abroad plus an Insurance payment of 2,800.00 on Pesos, 20% under the 3,500.00 bill, which no suggestion pairs.
function household(): Sample {
  const sample = abroad(AS_OF)
  sample.doc.transactions.push({ id: 'insurance-paid', account_id: 'pesos', posted_on: AS_OF, amount_minor: -280000, kind: 'expense', description: 'Insurance premium' })
  return sample
}

async function todo(client: WaypointClient, rates: readonly Rate[], month: string) {
  const snapshot: Snapshot = buildSnapshot(await call<unknown>(client, 'export_household'), AS_OF, rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error('the engine did not run')
  const breakeven = await fxBreakeven(snapshot)
  if (breakeven !== null && !breakeven.ok) throw new Error('the breakeven did not run')
  const model = todoModel({ snapshot, walk: run.walk, breakeven, month })
  const row = (id: string) => model.groups.flatMap((g) => g.rows).find((r): r is ItemRow => r.type === 'item' && r.id === id)
  return { snapshot, model, row }
}

describe.skipIf(!url || !key)('To-do marks through the REST API', () => {
  it('links a payment at any amount, unlinks it, skips and unskips, and keeps every row listed', { timeout: 60_000 }, async () => {
    const { doc, rates } = household()
    const a = await signUp()
    const { ids } = await call<{ ids: IdMap }>(a, 'import_household', { p_doc: doc })
    const insurance = occurrenceId(ids.plan_items.insurance!, '2026-10-01')
    const mobile = occurrenceId(ids.plan_items.mobile!, '2026-10-01')

    const before = await todo(a, rates, '2026-10')
    const choice = linkChoices(before.snapshot, insurance).find((c) => c.row_id === ids.transactions['insurance-paid'])
    expect(choice).toMatchObject({ amount_minor: 280000, suggested: false })
    await sendEdit(a, choice!.edit)

    const linked = await todo(a, rates, '2026-10')
    expect(linked.row(insurance)).toMatchObject({ linked_minor: 280000, open_minor: 70000, done: false })
    expect(linked.row(insurance)!.words.map((w) => w.text)).toContain('Partly settled')
    // The row is no longer free to link elsewhere, so the same link again changes nothing.
    await expect(sendEdit(a, choice!.edit)).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })

    await sendEdit(a, linked.row(insurance)!.links[0]!.unlink)
    const unlinked = await todo(a, rates, '2026-10')
    expect(unlinked.row(insurance)).toMatchObject({ linked_minor: 0, open_minor: 350000, links: [], done: false })

    const skip = unlinked.row(mobile)!.skip!.edit
    await sendEdit(a, skip)
    const skipped = await todo(a, rates, '2026-10')
    expect(skipped.row(mobile)).toMatchObject({ done: true, skip: null })
    expect(skipped.row(mobile)!.words[0]).toEqual({ text: 'Skipped', tone: null })
    // A skip list that changed since it loaded is never overwritten.
    await expect(sendEdit(a, skip)).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
    await sendEdit(a, skipped.row(mobile)!.unskip!.edit)
    expect((await todo(a, rates, '2026-10')).row(mobile)).toMatchObject({ done: false, unskip: null })
  })

  it('deletes a payment with both legs of its transfer in one request, and touches nothing of another household', { timeout: 60_000 }, async () => {
    const { doc, rates } = household()
    const a = await signUp()
    const b = await signUp()
    const { ids } = await call<{ ids: IdMap }>(a, 'import_household', { p_doc: doc })
    await call(b, 'import_household', { p_doc: doc })
    const taxSep = occurrenceId(ids.plan_items['tax-set-aside']!, '2026-09-01')
    const sep = await todo(a, rates, '2026-09')
    const link = sep.row(taxSep)!.links[0]!
    expect(link.transfer_id).not.toBeNull()
    expect(link.partner_account_id).toBe(ids.accounts.tax)

    // Another household's row is out of sight: the request matches nothing.
    await expect(sendEdit(b, link.remove)).rejects.toMatchObject({ code: 'stale' })
    const remove: Edit = link.remove
    await sendEdit(a, remove)
    const after = await todo(a, rates, '2026-09')
    expect(after.snapshot.doc.transactions.filter((t) => t.transfer_id === link.transfer_id)).toEqual([])
    expect(after.row(taxSep)).toMatchObject({ links: [], linked_minor: 0, done: false })
    const theirs = buildSnapshot(await call<unknown>(b, 'export_household'), AS_OF, rates)
    expect(theirs.doc.transactions).toHaveLength(doc.transactions.length)
  })
})
