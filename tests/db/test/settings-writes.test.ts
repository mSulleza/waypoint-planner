import { accountRow, buildSnapshot, householdRow, payoffOrder, runEngine, type Account, type Rate, type Snapshot } from '@waypoint/core'
import { abroad } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sendEdit } from '../../../apps/app/src/data/edits'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'
import { draftOf, readItem } from '../../../apps/app/src/screens/plan/item.model'
import { accountChecks, draftOfAccount, newAccountDraft, newFloor, readAccount, saveAccount, withPreset, type AccountDraft } from '../../../apps/app/src/screens/settings/account.model'
import { archiveCategory, householdDraft, readHousehold, renameCategory, saveHousehold } from '../../../apps/app/src/screens/settings/settings.model'

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
  const { data, error } = await client.auth.signUp({ email: `settings-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { client, id: data.user.id }
}

async function snapshotOf(client: WaypointClient, rates: readonly Rate[]): Promise<Snapshot> {
  const { data, error } = await client.rpc('export_household')
  if (error) throw new Error(`export_household: ${error.message}`)
  return buildSnapshot(data, AS_OF, rates)
}

// What the account editor saves: the draft read, then checked by the schema the database mirrors.
function rowOf(snapshot: Snapshot, draft: AccountDraft, id: string, loaded: Account | null): Account {
  const { input, errors } = readAccount(snapshot, draft, { id, locale: LOCALE, loaded })
  if (Object.keys(errors).length > 0) throw new Error(JSON.stringify(errors))
  return accountRow.parse(input)
}

const named = (snapshot: Snapshot, name: string): Account => {
  const found = snapshot.doc.accounts.find((a) => a.name === name)
  if (!found) throw new Error(`no account ${name}`)
  return found
}

describe.skipIf(!url || !key)('Settings and the account editor through the REST API', () => {
  it('saves household settings, adds a card from a preset, edits floor windows and a payer that transfers follow, and adds, renames and archives a category', { timeout: 60_000 }, async () => {
    const { doc, rates: own } = abroad(AS_OF)
    const { client, id: household } = await signUp()
    const imported = await client.rpc('import_household', { p_doc: doc })
    if (imported.error) throw new Error(`import_household: ${imported.error.message}`)
    // The sample's rates hold no dollar, so a dollar card paid from euros is refused before it is saved, and the rest runs with one.
    const rates = [...own, { quote: 'USD', rate: 1.12, day: AS_OF }]
    let snapshot = await snapshotOf(client, own)
    const noDollar = { ...withPreset(newAccountDraft(snapshot, { kind: 'credit_card' }, LOCALE), 'US-generic', LOCALE), name: 'Travel card', balance: '1250', cut_day: '5', due: '28' }
    expect(accountChecks(snapshot, rowOf(snapshot, noDollar, 'x', null), null, LOCALE)).toEqual({ funded_from_account_id: 'No reference rate for USD, so money cannot move from Main to this account.' })
    snapshot = await snapshotOf(client, rates)

    // Household: payoff order and locale, guarded on what was loaded; a second Save from the same screen matches nothing.
    const loaded = snapshot.doc.household
    const row = householdRow.parse(readHousehold({ ...householdDraft(loaded), payoff_order: 'list', locale: 'en-gb' }, loaded).input)
    const save = saveHousehold(household, loaded, row)
    if (!save) throw new Error('nothing to save')
    await sendEdit(client, save)
    await expect(sendEdit(client, save)).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
    snapshot = await snapshotOf(client, rates)
    expect([snapshot.doc.household.payoff_order, snapshot.doc.household.locale]).toEqual(['list', 'en-GB'])

    // A card from the US preset, paid from Main, saved on its own id: a retry adds no second card.
    const main = named(snapshot, 'Main')
    const card = { ...withPreset(newAccountDraft(snapshot, { kind: 'credit_card' }, LOCALE), 'US-generic', LOCALE), name: 'Travel card', balance: '1250', cut_day: '5', due: '28', funded_from: main.id }
    const cardId = randomUUID()
    const cardRow = rowOf(snapshot, card, cardId, null)
    await sendEdit(client, { kind: 'add_account', row: { ...cardRow, household_id: household } })
    await sendEdit(client, { kind: 'add_account', row: { ...cardRow, household_id: household } })
    snapshot = await snapshotOf(client, rates)
    expect(snapshot.doc.accounts.filter((a) => a.name === 'Travel card')).toEqual([cardRow])
    expect(accountChecks(snapshot, cardRow, null, LOCALE)).toEqual({})
    expect(runEngine(snapshot).ok).toBe(true)

    // A second, higher floor window on Main: the column holds both, and a Save from before it matches nothing.
    const mainNow = named(snapshot, 'Main')
    const mainDraft = draftOfAccount(snapshot, mainNow, LOCALE)
    const windows = { ...mainDraft, floors: [...mainDraft.floors, { ...newFloor('2026-11'), amount: '10000' }] }
    const floorEdit = saveAccount(mainNow, rowOf(snapshot, windows, mainNow.id, mainNow))
    if (!floorEdit) throw new Error('nothing to save')
    await sendEdit(client, floorEdit)
    await expect(sendEdit(client, floorEdit)).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
    snapshot = await snapshotOf(client, rates)
    expect(named(snapshot, 'Main').floor_windows).toEqual([...mainNow.floor_windows, { from_month: '2026-11', to_month: null, amount_minor: 1000000 }])

    // A transfer into the shopping card, then its payer moved from Pesos to Main: the item is untouched and the card's payments leave Main.
    const shopping = named(snapshot, 'Shopping card')
    const extraId = randomUUID()
    const extra = { id: extraId, kind: 'transfer' as const, name: 'Shopping card extra', from_account_id: null, to_account_id: shopping.id, category_id: null, amount_minor: 500000, every: 'month' as const, starts_on: '2026-10-15', ends_on: null, roll: 'none' as const, confidence: 'committed' as const, stops_with_income: false, skip_periods: [] }
    await sendEdit(client, { kind: 'add_item', row: { ...extra, household_id: household } })
    snapshot = await snapshotOf(client, rates)
    const payer = saveAccount(shopping, rowOf(snapshot, { ...draftOfAccount(snapshot, shopping, LOCALE), funded_from: named(snapshot, 'Main').id }, shopping.id, shopping))
    expect(payer?.kind === 'edit_account' && payer.after).toEqual({ funded_from_account_id: named(snapshot, 'Main').id })
    await sendEdit(client, payer!)
    snapshot = await snapshotOf(client, rates)
    const item = snapshot.doc.plan_items.find((p) => p.id === extraId)!
    expect(readItem(snapshot, draftOf(snapshot, item, LOCALE), { id: extraId, locale: LOCALE, loaded: item }).errors).toEqual({})
    expect([item.from_account_id, item.to_account_id]).toEqual([null, shopping.id])
    const run = runEngine(snapshot)
    if (!run.ok) throw new Error(JSON.stringify(run.errors))
    const paymentIn = run.walk.lines.find((l) => l.account_id === shopping.id && l.kind === 'payment' && l.amount_minor > 0)!
    expect(run.walk.lines.find((l) => l.id === paymentIn.pair_id)?.account_id).toBe(named(snapshot, 'Main').id)
    expect(payoffOrder(snapshot).get(named(snapshot, 'Main').id)).toEqual([shopping.id, cardId])

    // A category: added on its id, refused under a name that differs only in case, renamed and archived only while it reads as loaded.
    const catId = randomUUID()
    await sendEdit(client, { kind: 'add_category', row: { id: catId, name: 'Transport', archived_at: null, household_id: household } })
    await expect(sendEdit(client, { kind: 'add_category', row: { id: randomUUID(), name: 'transport', archived_at: null, household_id: household } })).rejects.toMatchObject({ kind: 'rejected', code: 'category_exists' })
    snapshot = await snapshotOf(client, rates)
    const transport = snapshot.doc.categories.find((c) => c.id === catId)!
    await sendEdit(client, renameCategory(transport, 'Travel')!)
    await expect(sendEdit(client, renameCategory(transport, 'Commute')!)).rejects.toMatchObject({ code: 'stale' })
    snapshot = await snapshotOf(client, rates)
    await sendEdit(client, archiveCategory(snapshot.doc.categories.find((c) => c.id === catId)!, '2026-10-07T10:00:00.000Z'))
    snapshot = await snapshotOf(client, rates)
    expect(snapshot.doc.categories.find((c) => c.id === catId)).toMatchObject({ name: 'Travel', archived_at: expect.stringMatching(/^2026-10-07T10:00:00/) })
  })
})
