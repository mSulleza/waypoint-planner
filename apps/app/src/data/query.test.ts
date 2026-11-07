import { AuthRetryableFetchError } from '@supabase/auth-js'
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query'
import { buildSnapshot, importDoc, parseRates, runEngine, SCHEMA_VERSION, snapshotIndex, type ImportDocInput, type Snapshot } from '@waypoint/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ecb from '../../../../packages/core/test/fixtures/frankfurter-2026-10-07.json'
import { DataError } from './errors'
import { lastSave } from './last-save'
import { createQueryClient, findSample, HOUSEHOLD_KEY, householdQuery, importHousehold, loadHousehold, loadSample, postBatch, postBatchOptions, refreshAfterWrite, savedHousehold, snapshotOf, staleRefusal, type Household, type Loaded } from './query'
import type { RatesInfo } from './rates'
import { readSaved, SNAPSHOT_KEY, writeSaved } from './saved'
import { signOut } from './signout'
import { abroadDoc, AS_OF, fakeClient, later, memoryStorage, NOON, ok, type Reply } from './test-helpers'

const RATES = parseRates(ecb)
const live = async (): Promise<RatesInfo> => ({ rates: RATES, day: '2026-10-07', source: 'live', error: null })
const deps = (client: ReturnType<typeof fakeClient>, now = NOON) => ({ client: () => client, fetchRates: live, now: () => now })
const household = (loaded: Loaded): Household => {
  if (loaded.kind !== 'household') throw new Error(`expected a household, got ${loaded.kind}`)
  return loaded
}
const failure = async (promise: Promise<unknown>): Promise<DataError> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof DataError) return error
    throw error
  }
  throw new Error('expected a DataError')
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('loadHousehold', () => {
  it('builds one snapshot from the export and the rates, as of today in the household time zone', async () => {
    const client = fakeClient({ export_household: () => ok(abroadDoc()) })
    // 23:30 UTC on the 7th is already the 8th in Madrid.
    const got = household(await loadHousehold(deps(client, new Date('2026-10-07T23:30:00Z'))))
    expect(client.calls).toEqual(['export_household'])
    expect(got.snapshot.as_of).toBe('2026-10-08')
    expect(got.snapshot.rates).toEqual(RATES)
    expect(got.rates.source).toBe('live')
    expect(got.user_id).toBe('user-a')
    expect(() => snapshotIndex(got.snapshot)).not.toThrow()
  })

  it('saves the export with its rates under the versioned key after each successful load', async () => {
    const doc = abroadDoc()
    await loadHousehold(deps(fakeClient({ export_household: () => ok(doc) })))
    expect(SNAPSHOT_KEY).toBe(`waypoint:snapshot:v${SCHEMA_VERSION}`)
    expect(readSaved()).toEqual({ user_id: 'user-a', fetched_at: NOON.toISOString(), doc, rates: RATES })
    const again = savedHousehold(NOON, 'user-a')!
    expect(again.snapshot).toEqual(buildSnapshot(doc, AS_OF, RATES))
    expect(again.rates).toEqual({ rates: RATES, day: '2026-10-07', source: 'saved', error: null })
    expect(again.fetched_at).toBe(NOON.toISOString())
  })

  it('tells a refused read, an account without a household and a household with empty tables apart', async () => {
    const empty = { version: 1, household: abroadDoc().household }
    const refused = await failure(loadHousehold(deps(fakeClient({ export_household: () => ({ data: null, error: { message: 'permission denied for function export_household', code: '42501' }, status: 403 }) }))))
    const none = await loadHousehold(deps(fakeClient({ export_household: () => ok(null) })))
    const blank = household(await loadHousehold(deps(fakeClient({ export_household: () => ok(empty) }))))
    const signedOut = await loadHousehold(deps(fakeClient({ export_household: () => ok(abroadDoc()) }, null)))
    expect(refused.kind).toBe('not_allowed')
    expect(none).toEqual({ kind: 'no_household', user_id: 'user-a' })
    expect(blank.snapshot.doc.accounts).toEqual([])
    expect(blank.snapshot.doc.plan_items).toEqual([])
    expect(signedOut).toEqual({ kind: 'signed_out' })
  })

  it('labels every failed read and never returns a household for one', async () => {
    const reply = (r: Reply) => fakeClient({ export_household: () => r })
    const kinds = await Promise.all([
      failure(loadHousehold(deps(reply({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 })))),
      failure(loadHousehold(deps(reply({ data: null, error: { message: 'JWT expired', code: 'PGRST303' }, status: 401 })))),
      failure(loadHousehold(deps(reply({ data: null, error: { message: 'boom', code: 'XX000' }, status: 500 })))),
      failure(loadHousehold(deps(reply(ok({ version: 1, household: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-GB', track_from: AS_OF }, accounts: [{ id: 'a' }] }))))),
      failure(loadHousehold(deps(fakeClient({}, null, new AuthRetryableFetchError('Failed to fetch', 0))))),
    ])
    expect(kinds.map((e) => e.kind)).toEqual(['network', 'signed_out', 'server', 'bad_data', 'network'])
    expect(kinds[3]!.detail).toEqual(expect.arrayContaining([expect.stringMatching(/^doc\.accounts\[0\]/)]))
    expect(readSaved()).toBeNull()
    // Plain words on screen; the server's own words only behind Details.
    expect(kinds.map((e) => e.message)).toEqual([
      'Waypoint could not reach the server.',
      'Your session has ended. Sign in again.',
      'The server had a problem. Try again in a moment.',
      'Some of this household’s data did not pass the checks, so Waypoint cannot show its numbers.',
      'Waypoint could not reach the server.',
    ])
    expect(kinds[2]!.technical).toBe('export_household: boom (XX000, HTTP 500)')
    expect(kinds[3]!.technical).toBe("doc.accounts[0].kind: Invalid discriminator value. Expected 'cash' | 'credit_card' | 'loan'")
  })

  it('ends a session the server refused on this device, so the next load asks nothing, and keeps the session through other failures', async () => {
    const refusing = fakeClient({ export_household: () => ({ data: null, error: { message: 'No suitable key or wrong key type', code: 'PGRST301' }, status: 401 }) })
    expect((await failure(loadHousehold(deps(refusing)))).kind).toBe('signed_out')
    expect(await loadHousehold(deps(refusing))).toEqual({ kind: 'signed_out' })
    expect(refusing.calls).toEqual(['export_household', 'signOut'])

    const unrenewable = fakeClient({}, { user: { id: 'user-a' } }, new Error('Invalid Refresh Token: Refresh Token Not Found'))
    expect((await failure(loadHousehold(deps(unrenewable)))).kind).toBe('signed_out')
    expect(unrenewable.calls).toEqual(['signOut'])

    const offline = fakeClient({ export_household: () => ({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }) })
    const broken = fakeClient({ export_household: () => ({ data: null, error: { message: 'boom', code: 'XX000' }, status: 500 }) })
    const unreachable = fakeClient({}, { user: { id: 'user-a' } }, new AuthRetryableFetchError('Failed to fetch', 0))
    for (const client of [offline, broken, unreachable]) await failure(loadHousehold(deps(client)))
    expect([offline.calls, broken.calls, unreachable.calls]).toEqual([['export_household'], ['export_household'], []])
  })

  it('drops the saved copy when the account is signed out or has no household', async () => {
    writeSaved({ user_id: 'user-a', fetched_at: NOON.toISOString(), doc: abroadDoc(), rates: RATES })
    await loadHousehold(deps(fakeClient({ export_household: () => ok(null) })))
    expect(readSaved()).toBeNull()
    writeSaved({ user_id: 'user-a', fetched_at: NOON.toISOString(), doc: abroadDoc(), rates: RATES })
    await loadHousehold(deps(fakeClient({}, null)))
    expect(readSaved()).toBeNull()
  })
})

describe('sign-out and another account', () => {
  it('a sign-out while the export is on its way leaves nothing saved, when the export lands before the sign-out ends', async () => {
    let session: { user: { id: string } } | null = { user: { id: 'user-a' } }
    const reply = later<Reply>()
    const client = fakeClient({ export_household: () => reply.promise }, () => session)
    const load = loadHousehold(deps(client))
    await vi.waitFor(() => expect(client.calls).toEqual(['export_household']))
    // The sign-out request is still out, so the session is still there when the export lands.
    const logout = later<{ error: unknown }>()
    const out = signOut({ signOut: () => logout.promise, queryClient: createQueryClient() })
    reply.resolve(ok(abroadDoc()))
    expect(await load).toEqual({ kind: 'signed_out' })
    expect(readSaved()).toBeNull()
    session = null
    logout.resolve({ error: null })
    expect(await out).toBeNull()
    expect(readSaved()).toBeNull()
  })

  it('a sign-out while the export is on its way leaves nothing saved, when the export lands after it', async () => {
    let session: { user: { id: string } } | null = { user: { id: 'user-a' } }
    const reply = later<Reply>()
    const client = fakeClient({ export_household: () => reply.promise }, () => session)
    const load = loadHousehold(deps(client))
    await vi.waitFor(() => expect(client.calls).toEqual(['export_household']))
    const out = await signOut({
      signOut: async () => {
        session = null
        return { error: null }
      },
      queryClient: createQueryClient(),
    })
    expect(out).toBeNull()
    reply.resolve(ok(abroadDoc()))
    expect(await load).toEqual({ kind: 'signed_out' })
    expect(readSaved()).toBeNull()
  })

  it('never saves an export for an account that is no longer the one signed in', async () => {
    let session = { user: { id: 'user-a' } }
    const reply = later<Reply>()
    const client = fakeClient({ export_household: () => reply.promise }, () => session)
    const load = loadHousehold(deps(client))
    await vi.waitFor(() => expect(client.calls).toEqual(['export_household']))
    session = { user: { id: 'user-b' } }
    reply.resolve(ok(abroadDoc()))
    expect(await load).toEqual({ kind: 'signed_out' })
    expect(readSaved()).toBeNull()
  })

  it('shows the saved copy only to the account it belongs to, and drops it for another', () => {
    writeSaved({ user_id: 'user-a', fetched_at: NOON.toISOString(), doc: abroadDoc(), rates: RATES })
    expect(savedHousehold(NOON, null)).toBeUndefined()
    expect(savedHousehold(NOON, 'user-a')?.user_id).toBe('user-a')
    const asB = new QueryObserver(createQueryClient(), householdQuery(deps(fakeClient({ export_household: () => ok(null) }, { user: { id: 'user-b' } })), 1, 'user-b'))
    expect(asB.getCurrentResult().data).toBeUndefined()
    expect(readSaved()).toBeNull()
  })
})

describe('the household query', () => {
  it('starts from the saved copy, marked as old, so a cold start shows numbers and still loads', async () => {
    writeSaved({ user_id: 'user-a', fetched_at: '2026-10-07T05:42:00.000Z', doc: abroadDoc(), rates: RATES })
    const client = createQueryClient()
    const client2 = fakeClient({ export_household: () => ok(abroadDoc()) })
    const observer = new QueryObserver(client, householdQuery(deps(client2), 0, 'user-a'))
    const first = observer.getCurrentResult()
    expect(first.data?.kind).toBe('household')
    expect(first.dataUpdatedAt).toBe(Date.parse('2026-10-07T05:42:00.000Z'))
    expect(first.isStale).toBe(true)
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.waitFor(() => expect(client2.calls).toEqual(['export_household']))
    unsubscribe()
  })

  it('keeps the Snapshot object a refetch returns, so its index and the engine memo survive', async () => {
    const client = createQueryClient()
    const loaded = household(await client.fetchQuery(householdQuery(deps(fakeClient({ export_household: () => ok(abroadDoc()) })), 0, 'user-a')))
    expect(() => snapshotIndex(loaded.snapshot)).not.toThrow()
    expect(client.getDefaultOptions().queries?.structuralSharing).toBe(false)
  })
})

describe('writes', () => {
  it('refreshes the shared household in place after a write, keeping the old numbers until the new ones land', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { structuralSharing: false, retry: false } } })
    const loads: ((value: string) => void)[] = []
    const observer = new QueryObserver(client, { queryKey: ['household', 'test'], queryFn: () => new Promise<string>((resolve) => loads.push(resolve)) })
    const seen: { data: string | undefined; isLoading: boolean }[] = []
    const unsubscribe = observer.subscribe((r) => seen.push({ data: r.data, isLoading: r.isLoading }))
    await vi.waitFor(() => expect(loads).toHaveLength(1))
    loads[0]!('before the write')
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe('before the write'))

    const refreshed = refreshAfterWrite(client)
    await vi.waitFor(() => expect(loads).toHaveLength(2))
    const during = observer.getCurrentResult()
    expect([during.data, during.isFetching, during.isLoading, during.status]).toEqual(['before the write', true, false, 'success'])
    loads[1]!('after the write')
    await refreshed
    expect(observer.getCurrentResult().data).toBe('after the write')
    // The skeleton state (loading with no data) appears only before the first load.
    expect(seen.filter((s) => s.isLoading).every((s) => s.data === undefined)).toBe(true)
    expect(seen.slice(seen.findIndex((s) => s.data !== undefined)).every((s) => s.data !== undefined && !s.isLoading)).toBe(true)
    unsubscribe()
  })

  it('checks a batch before sending it and labels what post_batch refuses', async () => {
    const batch = {
      batch_id: '00000000-0000-4000-8000-000000000001',
      rows: [{ id: '00000000-0000-4000-8000-000000000002', account_id: '00000000-0000-4000-8000-000000000003', posted_on: AS_OF, amount_minor: -100, kind: 'expense' as const, category_id: null, description: '', transfer_id: null, plan_item_id: null, period: null, external_id: null }],
    }
    const unsent = fakeClient({})
    const bad = await failure(postBatch(unsent, { ...batch, rows: [] }))
    expect([bad.kind, bad.code, bad.message, unsent.calls]).toEqual(['rejected', 'bad_input', 'This change did not pass the checks.', []])

    const detail = { error: 'over_remainder', id: batch.rows[0]!.id, account_id: batch.rows[0]!.account_id, amount_minor: 100, remaining_minor: 50, cut_date: '2026-09-20' }
    const refused = await failure(postBatch(fakeClient({ post_batch: () => ({ data: null, error: { message: 'over_remainder: payment above the remaining due', code: 'P0001', details: JSON.stringify(detail) }, status: 400 }) }), batch))
    expect([refused.kind, refused.code, refused.detail, refused.message]).toEqual(['rejected', 'over_remainder', detail, 'The server did not accept this change.'])
    expect(refused.technical).toBe('post_batch: over_remainder: payment above the remaining due (P0001, HTTP 400)')

    const applied = { status: 'applied', batch_id: batch.batch_id, inserted: 1, balances_before: {}, balances_after: {} }
    expect(await postBatch(fakeClient({ post_batch: () => ok(applied) }), batch)).toEqual(applied)
  })

  it('reloads the household before a save or a refusal against moved balances finishes, and for no other refusal', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { structuralSharing: false, retry: false }, mutations: { retry: false } } })
    let loads = 0
    const observer = new QueryObserver(client, { queryKey: [...HOUSEHOLD_KEY, 'test'], queryFn: async () => ++loads })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.waitFor(() => expect(loads).toBe(1))
    const batch = {
      batch_id: '00000000-0000-4000-8000-000000000001',
      rows: [{ id: '00000000-0000-4000-8000-000000000002', account_id: '00000000-0000-4000-8000-000000000003', posted_on: AS_OF, amount_minor: 100, kind: 'adjustment' as const, category_id: null, description: 'Interest', transfer_id: null, plan_item_id: null, period: null, external_id: null }],
      expect_before: { '00000000-0000-4000-8000-000000000003': 690000 },
    }
    const refusing = (message: string, detail: unknown) => fakeClient({ post_batch: () => ({ data: null, error: { message, code: 'P0001', details: JSON.stringify(detail) }, status: 400 }) })
    const send = (server: ReturnType<typeof fakeClient>, input = batch, writable = true) => new MutationObserver(client, postBatchOptions(client, () => server, writable)).mutate(input)
    const saves = lastSave().seq

    // Reconcile's adjustment, made against a balance another device has since moved: the refusal arrives with the new figures loaded.
    const moved = { error: 'balance_mismatch', when: 'before', accounts: [{ account_id: '00000000-0000-4000-8000-000000000003', expected_minor: 690000, actual_minor: 689900 }] }
    const stale = await failure(send(refusing('balance_mismatch: before the batch, account 00000000-0000-4000-8000-000000000003 is 689900, not the expected 690000', moved)))
    expect([stale.kind, stale.code, stale.detail, staleRefusal(stale), loads]).toEqual(['rejected', 'balance_mismatch', moved, true, 2])

    // A refusal about the batch itself, a batch the device's own check stops, and saving while it is off leave the household as loaded.
    const over = await failure(send(refusing('over_remainder: payment above the remaining due', { error: 'over_remainder' })))
    const unchecked = await failure(send(fakeClient({}), { ...batch, rows: [] }))
    const off = await failure(send(fakeClient({}), batch, false))
    expect([over.code, unchecked.code, off.kind, loads, lastSave().seq]).toEqual(['over_remainder', 'bad_input', 'read_only', 2, saves])

    const applied = { status: 'applied', batch_id: batch.batch_id, inserted: 1, balances_before: {}, balances_after: {} }
    expect(await send(fakeClient({ post_batch: () => ok(applied) }))).toEqual(applied)
    expect([loads, lastSave()]).toEqual([3, { seq: saves + 1, rows: [{ account_id: '00000000-0000-4000-8000-000000000003', posted_on: AS_OF }] }])
    unsubscribe()
  })

  it('checks a household before importing it, sends it once, and reads an account that already has one as set up', async () => {
    const doc = abroadDoc()
    const unsent = fakeClient({})
    const bad = await failure(importHousehold(unsent, { ...doc, accounts: [...(doc.accounts ?? []), { id: 'main', name: '', kind: 'cash', currency: 'EUR', opening_date: AS_OF }] } as ImportDocInput))
    expect([bad.kind, bad.code, bad.message, unsent.calls]).toEqual(['rejected', 'bad_input', 'This household did not pass the checks.', []])
    expect((bad.detail as { issues: string[] }).issues).toContain("accounts[5].name: must not be empty")

    const sent: unknown[] = []
    const made = { household_id: 'user-a', ids: { accounts: { main: '00000000-0000-4000-8000-000000000001' } } }
    const client = fakeClient({ import_household: () => ok(made) })
    const rpc = client.rpc
    client.rpc = (fn, args) => {
      sent.push([fn, args])
      return rpc(fn, args)
    }
    expect(await importHousehold(client, doc)).toEqual(made)
    expect(sent).toEqual([['import_household', { p_doc: importDoc.parse(doc) }]])

    const existing = fakeClient({ import_household: () => ({ data: null, error: { message: 'household_not_empty: this household already holds accounts or categories; import_household fills an empty household only', code: 'P0001', details: '{"error": "household_not_empty"}' }, status: 400 }) })
    expect(await importHousehold(existing, doc)).toBeNull()

    const check = { message: 'new row for relation "plan_items" violates check constraint "plan_items_amount_check"', code: '23514', details: null }
    const refused = await failure(importHousehold(fakeClient({ import_household: () => ({ data: null, error: check, status: 400 }) }), doc))
    expect([refused.kind, refused.code, refused.message]).toEqual(['rejected', '23514', 'The server did not accept this change.'])
  })
})

describe('one rate store', () => {
  it('reads every rate from the loaded snapshot, and an FX lever shifts the walk without replacing them', async () => {
    const loaded = household(await loadHousehold(deps(fakeClient({ export_household: () => ok(abroadDoc()) }))))
    const snapshot: Snapshot = loaded.snapshot
    const base = runEngine(snapshot)
    const shifted = runEngine(snapshot, { fx_shift_pct: -0.1 })
    if (!base.ok || !shifted.ok) throw new Error('the engine did not run')
    expect(shifted.world.snapshot).toBe(snapshot)
    expect(snapshot.rates).toEqual(RATES)
    expect(readSaved()!.rates).toEqual(RATES)
    expect(base.walk.rates.PHP).toBe(70.203)
    expect(shifted.walk.rates.PHP).not.toBe(70.203)
    expect(snapshot.rates.find((r) => r.quote === 'PHP')!.rate).toBe(70.203)
  })
})

describe('samples', () => {
  it('opens each Welcome sample with its own rates and no request', async () => {
    expect(await Promise.all(['abroad', 'us-cards-car', 'mortgage'].map(async (id) => (await findSample(id))?.id))).toEqual(['abroad', 'us-cards-car', 'mortgage'])
    const got = await loadSample('abroad', NOON)
    expect(got.sample?.id).toBe('abroad')
    expect(got.snapshot.as_of).toBe(AS_OF)
    expect(got.rates.source).toBe('sample')
    expect(got.user_id).toBeNull()
  })

  it('adds the large sample only in a perf export, and names an unknown id', async () => {
    expect(await findSample('mark-size')).toBeUndefined()
    await expect(loadSample('mark-size', NOON)).rejects.toThrow('There is no sample called ‘mark-size’.')
    vi.stubEnv('EXPO_PUBLIC_PERF_SAMPLES', '1')
    expect((await findSample('mark-size'))?.title).toBe('Large household for performance runs')
    expect((await loadSample('mark-size', NOON)).snapshot.doc.plan_items).toHaveLength(150)
    expect(await findSample('nope')).toBeUndefined()
  })

  it('reads as_of in the sample household time zone', async () => {
    expect((await loadSample('us-cards-car', new Date('2026-10-08T03:00:00Z'))).snapshot.as_of).toBe('2026-10-07')
    expect(snapshotOf(abroadDoc(), RATES, new Date('2026-10-08T03:00:00Z')).as_of).toBe('2026-10-08')
  })
})
