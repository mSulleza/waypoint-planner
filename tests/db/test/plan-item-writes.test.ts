import { buildSnapshot, occurrencesOf, planItemRow, type PlanItem, type Rate, type Snapshot } from '@waypoint/core'
import { abroad } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sendEdit } from '../../../apps/app/src/data/edits'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'
import { draftOf, endPlan, linksOf, newDraft, readItem, savePlan, splitPlan, withKind, type ItemDraft } from '../../../apps/app/src/screens/plan/item.model'

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
  const { data, error } = await client.auth.signUp({ email: `plan-item-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { client, id: data.user.id }
}

async function snapshotOf(client: WaypointClient, rates: readonly Rate[]): Promise<Snapshot> {
  const { data, error } = await client.rpc('export_household')
  if (error) throw new Error(`export_household: ${error.message}`)
  return buildSnapshot(data, AS_OF, rates)
}

// What the plan item editor saves: the draft read, then checked by the schema the database mirrors.
function rowOf(snapshot: Snapshot, draft: ItemDraft, id: string, loaded: PlanItem | null): PlanItem {
  const { input, errors } = readItem(snapshot, draft, { id, locale: LOCALE, loaded })
  if (Object.keys(errors).length > 0) throw new Error(JSON.stringify(errors))
  return planItemRow.parse(input)
}

describe.skipIf(!url || !key)('the plan item editor through the REST API and split_plan_item', () => {
  it('changes from a month into a second row with earlier links kept, keeps a linked account, deletes only unlinked items and saves installment months', { timeout: 60_000 }, async () => {
    const { doc, rates } = abroad(AS_OF)
    const { client, id: household } = await signUp()
    const { data, error } = await client.rpc('import_household', { p_doc: doc })
    if (error) throw new Error(`import_household: ${error.message}`)
    const ids = (data as { ids: Record<'plan_items' | 'transactions' | 'accounts', Record<string, string>> }).ids
    const named = (snapshot: Snapshot, name: string) => snapshot.doc.plan_items.filter((p) => p.name === name).sort((a, b) => (a.starts_on < b.starts_on ? -1 : 1))
    const edited = (snapshot: Snapshot, loaded: PlanItem, change: (d: ItemDraft) => ItemDraft) => rowOf(snapshot, change(draftOf(snapshot, loaded, LOCALE)), loaded.id, loaded)

    // A groceries budget changed from next month: two rows, October's budget untouched.
    let snapshot = await snapshotOf(client, rates)
    const groceries = named(snapshot, 'Groceries')[0]!
    const more = splitPlan(snapshot, groceries, edited(snapshot, groceries, (d) => ({ ...d, amount: '450' })), [], '2026-11', LOCALE)
    if (!more.ok) throw new Error(more.reason)
    await sendEdit(client, { kind: 'split_item', id: groceries.id, ...more.value })
    snapshot = await snapshotOf(client, rates)
    expect(named(snapshot, 'Groceries').map((p) => [p.amount_minor, p.starts_on, p.ends_on])).toEqual([
      [40000, '2026-09-01', '2026-10-31'],
      [45000, '2026-11-01', null],
    ])

    // Rent, linked for September and October, changed from November: both links stay on the row that covers them.
    const rent = named(snapshot, 'Rent')[0]!
    const rentLinks = linksOf(snapshot, rent.id)
    expect(rentLinks.map((t) => [t.id, t.period])).toEqual([
      [ids.transactions['rent-last'], '2026-09-01'],
      [ids.transactions['rent-now'], '2026-10-01'],
    ])
    const raise = splitPlan(snapshot, rent, edited(snapshot, rent, (d) => ({ ...d, amount: '950' })), rentLinks, '2026-11', LOCALE)
    if (!raise.ok) throw new Error(raise.reason)
    await sendEdit(client, { kind: 'split_item', id: rent.id, ...raise.value })
    snapshot = await snapshotOf(client, rates)
    const [before, after] = named(snapshot, 'Rent')
    expect([before?.id, before?.amount_minor, before?.ends_on, after?.amount_minor, after?.starts_on]).toEqual([rent.id, 90000, '2026-10-31', 95000, '2026-11-01'])
    expect(linksOf(snapshot, rent.id).map((t) => t.period)).toEqual(['2026-09-01', '2026-10-01'])
    expect(linksOf(snapshot, after!.id)).toEqual([])

    // Save never moves a linked bill to another account: the editor holds it, and the database refuses it if sent.
    const mobile = named(snapshot, 'Mobile plan')[0]!
    const moved = edited(snapshot, mobile, (d) => ({ ...d, from: ids.accounts.main! }))
    expect(savePlan(snapshot, mobile, moved, linksOf(snapshot, mobile.id), LOCALE)).toMatchObject({ ok: false })
    const loaded = { kind: mobile.kind, name: mobile.name, from_account_id: mobile.from_account_id, to_account_id: null, category_id: null, amount_minor: mobile.amount_minor, every: mobile.every, starts_on: mobile.starts_on, ends_on: null, roll: mobile.roll, confidence: mobile.confidence, stops_with_income: mobile.stops_with_income }
    await expect(sendEdit(client, { kind: 'edit_item', id: mobile.id, before: loaded, after: { from_account_id: ids.accounts.main! } })).rejects.toMatchObject({ kind: 'rejected', code: 'check_plan_item' })
    // A Save made from a screen loaded before another change matches no row.
    await expect(sendEdit(client, { kind: 'edit_item', id: mobile.id, before: { ...loaded, amount_minor: 1 }, after: { amount_minor: 130000 } })).rejects.toMatchObject({ code: 'stale' })
    // End before November keeps September's link.
    const end = endPlan(mobile, linksOf(snapshot, mobile.id), '2026-11', '2031-10', LOCALE)
    if (!end.ok) throw new Error(end.reason)
    await sendEdit(client, end.value)

    // Delete: refused while a payment links to the item, done when none does.
    await expect(sendEdit(client, { kind: 'delete_item', id: rent.id })).rejects.toMatchObject({ kind: 'rejected', code: 'linked' })
    await sendEdit(client, { kind: 'delete_item', id: ids.plan_items['camera-sale']! })

    // A 12-month installment from the editor's defaults.
    const draft = { ...withKind(snapshot, newDraft(snapshot, {}), 'installment'), name: 'Phone', amount: '1500' }
    const phone = randomUUID()
    await sendEdit(client, { kind: 'add_item', row: { ...rowOf(snapshot, draft, phone, null), household_id: household } })

    snapshot = await snapshotOf(client, rates)
    expect(named(snapshot, 'Mobile plan').map((p) => [p.from_account_id, p.ends_on])).toEqual([[ids.accounts.pesos, '2026-10-31']])
    expect(linksOf(snapshot, mobile.id).map((t) => t.period)).toEqual(['2026-09-01'])
    expect(snapshot.doc.plan_items.some((p) => p.name === 'Sell the old camera')).toBe(false)
    expect(named(snapshot, 'Rent')).toHaveLength(2)
    expect(named(snapshot, 'Phone').map((p) => [p.id, p.kind, p.every, p.starts_on, p.ends_on, p.amount_minor])).toEqual([[phone, 'installment', 'month', '2026-11-01', '2027-10-01', 150000]])
  })

  it('adds a bill every 3 months from the editor, changes it from a month inside its quarter, and the database refuses a budget every 3 months', { timeout: 60_000 }, async () => {
    const { doc, rates } = abroad(AS_OF)
    const { client, id: household } = await signUp()
    const { data, error } = await client.rpc('import_household', { p_doc: doc })
    if (error) throw new Error(`import_household: ${error.message}`)
    const ids = (data as { ids: Record<'accounts' | 'categories', Record<string, string>> }).ids
    let snapshot = await snapshotOf(client, rates)

    const fee = randomUUID()
    const draft: ItemDraft = { ...withKind(snapshot, newDraft(snapshot, {}), 'bill'), name: 'Accountant', from: ids.accounts.pesos!, amount: '4500', every: 'quarter', starts_on: '2026-10-15' }
    await sendEdit(client, { kind: 'add_item', row: { ...rowOf(snapshot, draft, fee, null), household_id: household } })
    snapshot = await snapshotOf(client, rates)
    const loaded = snapshot.doc.plan_items.find((p) => p.id === fee)!
    expect([loaded.every, loaded.starts_on, loaded.amount_minor]).toEqual(['quarter', '2026-10-15', 450000])

    // From November, inside October's quarter: the copy starts in January on the 20th.
    const edited = rowOf(snapshot, { ...draftOf(snapshot, loaded, LOCALE), amount: '5000', starts_on: '2026-10-20' }, fee, loaded)
    const later = splitPlan(snapshot, loaded, edited, [], '2026-11', LOCALE)
    if (!later.ok) throw new Error(later.reason)
    await sendEdit(client, { kind: 'split_item', id: fee, ...later.value })
    snapshot = await snapshotOf(client, rates)
    const rows = snapshot.doc.plan_items.filter((p) => p.name === 'Accountant').sort((a, b) => (a.starts_on < b.starts_on ? -1 : 1))
    expect(rows.map((p) => [p.every, p.starts_on, p.ends_on, p.amount_minor])).toEqual([
      ['quarter', '2026-10-15', '2026-10-31', 450000],
      ['quarter', '2027-01-20', null, 500000],
    ])
    expect(occurrencesOf(snapshot, '2027-12-31').filter((o) => rows.some((p) => p.id === o.plan_item_id)).map((o) => [o.period, o.date, o.amount_minor])).toEqual([
      ['2026-10-01', '2026-10-15', 450000],
      ['2027-01-01', '2027-01-20', 500000],
      ['2027-04-01', '2027-04-20', 500000],
      ['2027-07-01', '2027-07-20', 500000],
      ['2027-10-01', '2027-10-20', 500000],
    ])

    const budget = { household_id: household, kind: 'allowance', name: 'Food', from_account_id: ids.accounts.main, category_id: ids.categories['cat-groceries'], amount_minor: 30000, every: 'quarter', starts_on: '2026-11-01' }
    const refused = await client.from('plan_items').insert(budget)
    expect([refused.error?.code, refused.error?.message]).toEqual(['23514', 'new row for relation "plan_items" violates check constraint "plan_items_quarter_check"'])
  })
})
