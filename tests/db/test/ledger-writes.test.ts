import { buildSnapshot, daysBetween, ledgerSum, type Rate, type Snapshot } from '@waypoint/core'
import { abroad } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sendEdit } from '../../../apps/app/src/data/edits'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'
import { deleteEdit, editDraft, editTarget, readEdit, type EditDraft } from '../../../apps/app/src/screens/money/ledger.model'
import { adjustmentBatch, reconcileView } from '../../../apps/app/src/screens/money/reconcile.model'

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

interface User {
  client: WaypointClient
  // The household is the user: row-level security checks household_id against the signed-in id.
  id: string
}

async function signUp(): Promise<User> {
  const client = createWaypointClient(url!, key!, { storage: memoryStorage() })
  const { data, error } = await client.auth.signUp({ email: `ledger-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { client, id: data.user.id }
}

async function call<T>(client: WaypointClient, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

type IdMap = Record<'transactions' | 'accounts' | 'transfers', Record<string, string>>

async function snapshotOf(client: WaypointClient, rates: readonly Rate[]): Promise<Snapshot> {
  return buildSnapshot(await call<unknown>(client, 'export_household'), AS_OF, rates)
}

async function imported(): Promise<{ user: User; ids: IdMap; rates: readonly Rate[] }> {
  const { doc, rates } = abroad(AS_OF)
  const user = await signUp()
  const { ids } = await call<{ ids: IdMap }>(user.client, 'import_household', { p_doc: doc })
  return { user, ids, rates }
}

const legsOf = (snapshot: Snapshot, transferId: string) => snapshot.doc.transactions.filter((t) => t.transfer_id === transferId).sort((a, b) => a.amount_minor - b.amount_minor)

function edit(snapshot: Snapshot, user: User, rowId: string, change: Partial<EditDraft>) {
  const target = editTarget(snapshot, rowId)
  if (!target) throw new Error(`no row ${rowId}`)
  const read = readEdit(target, { ...editDraft(target, LOCALE), ...change }, { locale: LOCALE, household_id: user.id, day: (d) => d })
  if (!read.ok || read.edit === null) throw new Error(`no edit: ${JSON.stringify(read)}`)
  return read.edit
}

describe.skipIf(!url || !key)('ledger edits through the REST API', () => {
  it('moves both legs of a transfer by the same number of days in one write, so the gap between them stays', { timeout: 60_000 }, async () => {
    const { user, ids, rates } = await imported()
    const transfer = ids.transfers['rewards-paid-before']!
    const before = await snapshotOf(user.client, rates)
    const [out, into] = legsOf(before, transfer)
    expect([out!.posted_on, into!.posted_on]).toEqual(['2026-09-10', '2026-09-11'])

    // The card's leg moves from 11 to 14 September; the deferred pair check sees both legs move in one statement.
    await sendEdit(user.client, edit(before, user, ids.transactions['rewards-paid-before-in']!, { day: '2026-09-14' }))
    const after = legsOf(await snapshotOf(user.client, rates), transfer)
    expect(after.map((t) => [t.id, t.posted_on, t.amount_minor])).toEqual([
      [out!.id, '2026-09-13', -3800000],
      [into!.id, '2026-09-14', 3800000],
    ])
    expect(daysBetween(after[0]!.posted_on, after[1]!.posted_on)).toBe(1)
  })

  it('sets both legs of a same-currency transfer to a new amount in one write, and keeps its link', { timeout: 60_000 }, async () => {
    const { user, ids, rates } = await imported()
    const transfer = ids.transfers['tax-last']!
    const before = await snapshotOf(user.client, rates)
    await sendEdit(user.client, edit(before, user, ids.transactions['tax-last-in']!, { amount: '650.00' }))
    const after = legsOf(await snapshotOf(user.client, rates), transfer)
    expect(after.map((t) => [t.account_id, t.amount_minor])).toEqual([
      [ids.accounts.main, -65000],
      [ids.accounts.tax, 65000],
    ])
    expect(after[0]!.plan_item_id).not.toBeNull()
  })

  it('deletes both legs of a transfer in one request when one is deleted, and another household cannot touch them', { timeout: 60_000 }, async () => {
    const { user, ids, rates } = await imported()
    const other = await signUp()
    const transfer = ids.transfers['topup-now']!
    const before = await snapshotOf(user.client, rates)
    const target = editTarget(before, ids.transactions['topup-now-in']!)!

    // Another household's edit of these rows is refused, and its delete matches nothing.
    await expect(sendEdit(other.client, edit(before, other, ids.transactions['topup-now-in']!, { day: '2026-10-03' }))).rejects.toMatchObject({ kind: expect.stringMatching(/not_allowed|rejected/) })
    await expect(sendEdit(other.client, deleteEdit(target))).rejects.toMatchObject({ code: 'stale' })
    expect(legsOf(await snapshotOf(user.client, rates), transfer).map((t) => t.posted_on)).toEqual(['2026-10-02', '2026-10-02'])

    await sendEdit(user.client, deleteEdit(target))
    expect(legsOf(await snapshotOf(user.client, rates), transfer)).toEqual([])
  })

  it('refuses an edit of a row or a transfer deleted elsewhere, and never writes either back', { timeout: 60_000 }, async () => {
    const { user, ids, rates } = await imported()
    const before = await snapshotOf(user.client, rates)
    const transfer = ids.transfers['rewards-paid-before']!
    const row = ids.transactions['groceries-4']!
    const moveTransfer = edit(before, user, ids.transactions['rewards-paid-before-in']!, { day: '2026-09-14' })
    const changeRow = edit(before, user, row, { amount: '95' })

    // Another device deletes both while this screen still shows them.
    await sendEdit(user.client, deleteEdit(editTarget(before, ids.transactions['rewards-paid-before-out']!)!))
    await sendEdit(user.client, deleteEdit(editTarget(before, row)!))
    await expect(sendEdit(user.client, moveTransfer)).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
    await expect(sendEdit(user.client, changeRow)).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
    const after = await snapshotOf(user.client, rates)
    expect([legsOf(after, transfer), after.doc.transactions.filter((t) => t.id === row)]).toEqual([[], []])
  })

  it('keeps a link removed elsewhere, refuses an edit of a row changed elsewhere, and matches any note as loaded', { timeout: 60_000 }, async () => {
    const { user, ids, rates } = await imported()
    const before = await snapshotOf(user.client, rates)
    const out = before.doc.transactions.find((t) => t.id === ids.transactions['tax-last-out'])!
    const amountEdit = edit(before, user, out.id, { amount: '650.00' })

    // Another device unlinks the transfer; this screen's amount edit still lands, and does not link it back.
    await sendEdit(user.client, { kind: 'unlink', row_id: out.id, plan_item_id: out.plan_item_id!, period: out.period! })
    await sendEdit(user.client, amountEdit)
    expect(legsOf(await snapshotOf(user.client, rates), ids.transfers['tax-last']!).map((t) => [t.amount_minor, t.plan_item_id, t.period])).toEqual([
      [-65000, null, null],
      [65000, null, null],
    ])

    // Another device changes a row's amount first: this screen's edit, made on the old figure, is refused and the other device's stands.
    const row = ids.transactions['groceries-4']!
    const noteEdit = edit(before, user, row, { note: 'Supermarket run' })
    await sendEdit(user.client, edit(before, user, row, { amount: '95' }))
    await expect(sendEdit(user.client, noteEdit)).rejects.toMatchObject({ code: 'stale' })
    const held = async () => (await snapshotOf(user.client, rates)).doc.transactions.find((t) => t.id === row)!
    expect([(await held()).amount_minor, (await held()).description]).toEqual([-9500, 'Supermarket'])

    // A note with commas, quotes and brackets, and an empty one, still match as loaded.
    for (const note of ['Café, “bakery” (2 items) & tip', '']) {
      await sendEdit(user.client, edit(await snapshotOf(user.client, rates), user, row, { note }))
      await sendEdit(user.client, edit(await snapshotOf(user.client, rates), user, row, { amount: note === '' ? '97' : '96' }))
      expect([(await held()).amount_minor, (await held()).description]).toEqual([note === '' ? -9700 : -9600, note])
    }
  })

  it('posts an adjustment only when asked, landing exactly on the bank’s figure, and refuses one made against a balance that has changed', { timeout: 60_000 }, async () => {
    const { user, ids, rates } = await imported()
    const main = ids.accounts.main!
    const before = await snapshotOf(user.client, rates)
    const opening = ledgerSum(before, main, AS_OF)
    const view = reconcileView(before, main, '6,512.34', LOCALE)!
    expect(view.gap_minor).toBe(651234 - opening)
    const read = adjustmentBatch(before, view, 'Interest credited', { batch_id: randomUUID(), row_id: randomUUID() })
    if (!read.ok) throw new Error(read.error)
    await call(user.client, 'post_batch', { p_batch: read.batch })
    const after = await snapshotOf(user.client, rates)
    expect(ledgerSum(after, main, AS_OF)).toBe(651234)
    expect(after.doc.transactions.filter((t) => t.kind === 'adjustment').map((t) => [t.account_id, t.amount_minor, t.description])).toEqual([[main, 651234 - opening, 'Interest credited']])

    // The same figures again, from the screen as it stood before: the balance moved, so nothing is written.
    const stale = adjustmentBatch(before, view, 'Interest credited', { batch_id: randomUUID(), row_id: randomUUID() })
    if (!stale.ok) throw new Error(stale.error)
    const { error } = await user.client.rpc('post_batch', { p_batch: stale.batch })
    expect(error?.message).toMatch(/^balance_mismatch/)
    expect(ledgerSum(await snapshotOf(user.client, rates), main, AS_OF)).toBe(651234)
  })
})
