import { QueryClient, queryOptions, type MutationOptions } from '@tanstack/react-query'
import { buildSnapshot, checkInput, importDoc, postBatchInput, SnapshotError, todayIn, type ImportDocInput, type PostBatchInput, type Rate, type Snapshot } from '@waypoint/core'
import type { SampleEntry } from '@waypoint/core/fixtures/samples'
import { asDataError, authError, DataError, rpcError, type RpcFailure } from './errors'
import { noteSave } from './last-save'
import { ratesDay, type RatesInfo } from './rates'
import { accountEpoch, forgetSaved, readSaved, writeSaved } from './saved'

export interface Household {
  kind: 'household'
  snapshot: Snapshot
  rates: RatesInfo
  // When this copy came from the server, as an ISO instant; a sample's is when it was built.
  fetched_at: string
  // The account it belongs to; null for a sample.
  user_id: string | null
  sample: SampleEntry | null
}

// Signed out, signed in without a household, and a household (which may have empty tables) are three different answers.
export type Loaded = Household | { kind: 'no_household'; user_id: string } | { kind: 'signed_out' }

// The slice of the Supabase client a load uses, so tests can stand in for the server.
export interface HouseholdClient {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null }; error: unknown }>
    signOut(options: { scope: 'local' }): Promise<{ error: unknown }>
  }
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcFailure | null; status: number }>
}

export interface LoadDeps {
  client: () => HouseholdClient
  fetchRates: () => Promise<RatesInfo>
  now: () => Date
}

export const HOUSEHOLD_KEY = ['household'] as const
export const SUPABASE_KEY = [...HOUSEHOLD_KEY, 'supabase'] as const

function zoneOf(doc: unknown): string {
  const zone = (doc as { household?: { timezone?: unknown } } | null)?.household?.timezone
  return typeof zone === 'string' ? zone : 'UTC'
}

const BAD_DATA = 'Some of this household’s data did not pass the checks, so Waypoint cannot show its numbers.'

// today is the household's own day, so a household in Manila and its owner in Madrid agree on what has happened.
export function snapshotOf(doc: unknown, rates: readonly Rate[], now: Date): Snapshot {
  let asOf: string
  try {
    asOf = todayIn(zoneOf(doc), now)
  } catch {
    const issue = 'household.timezone: must be an IANA time zone such as Europe/Madrid'
    throw new DataError('bad_data', BAD_DATA, { detail: [issue], technical: issue })
  }
  try {
    return buildSnapshot(doc, asOf, rates)
  } catch (error) {
    if (!(error instanceof SnapshotError)) throw error
    const [first, ...rest] = error.issues
    throw new DataError('bad_data', BAD_DATA, { detail: error.issues, technical: rest.length > 0 ? `${first} (and ${rest.length} more)` : (first ?? error.message) })
  }
}

// Still the account the load started for. The epoch catches a sign-out whose request is still out (its session is still saved); the session check catches another account.
async function sameAccount(client: HouseholdClient, user_id: string, epoch: number): Promise<boolean> {
  if (accountEpoch() !== epoch) return false
  const { data, error } = await client.auth.getSession()
  // A failed check (no network for a token refresh) cannot tell; the epoch still covers sign-outs on this device.
  return accountEpoch() === epoch && (error !== null || data.session?.user.id === user_id)
}

// A session the server refused ends on this device too, so the gate settles on Welcome instead of every screen asking again.
async function refused(client: HouseholdClient, problem: DataError): Promise<DataError> {
  if (problem.kind === 'signed_out') await client.auth.signOut({ scope: 'local' }).catch(() => undefined)
  return problem
}

// One load: the export and the day's rates side by side, one snapshot from both, and a saved copy for offline reading.
export async function loadHousehold(deps: LoadDeps): Promise<Loaded> {
  const epoch = accountEpoch()
  const client = deps.client()
  const { data, error } = await client.auth.getSession()
  if (error) throw await refused(client, authError(error))
  const session = data.session
  if (!session) {
    forgetSaved()
    return { kind: 'signed_out' }
  }
  const user_id = session.user.id
  const [exported, rates] = await Promise.all([client.rpc('export_household'), deps.fetchRates()])
  // Signed out (or into another account) while the export was on its way: these numbers are no longer this device's to keep.
  if (!(await sameAccount(client, user_id, epoch))) return { kind: 'signed_out' }
  if (exported.error) throw await refused(client, rpcError('export_household', exported.error, exported.status))
  if (exported.data === null || exported.data === undefined) {
    forgetSaved()
    return { kind: 'no_household', user_id }
  }
  const now = deps.now()
  const snapshot = snapshotOf(exported.data, rates.rates, now)
  const fetched_at = now.toISOString()
  writeSaved({ user_id, fetched_at, doc: exported.data, rates: [...rates.rates] })
  return { kind: 'household', snapshot, rates, fetched_at, user_id, sample: null }
}

// The saved copy as a household for the signed-in account, or undefined when there is none, it is another account's (then dropped), or it no longer passes the checks.
export function savedHousehold(now: Date, owner: string | null): Household | undefined {
  const saved = readSaved()
  if (!saved || owner === null) return undefined
  if (saved.user_id !== owner) {
    forgetSaved()
    return undefined
  }
  try {
    const snapshot = snapshotOf(saved.doc, saved.rates, now)
    return { kind: 'household', snapshot, rates: { rates: saved.rates, day: ratesDay(saved.rates), source: 'saved', error: null }, fetched_at: saved.fetched_at, user_id: saved.user_id, sample: null }
  } catch {
    forgetSaved()
    return undefined
  }
}

export const MARK_SIZE_ID = 'mark-size'

// Welcome lists SAMPLE_LIST; the households load only when one opens. An export made with EXPO_PUBLIC_PERF_SAMPLES=1 also opens the large one by its id.
export async function findSample(id: string): Promise<SampleEntry | undefined> {
  const { SAMPLES } = await import('@waypoint/core/fixtures/samples')
  const entry = SAMPLES.find((e) => e.id === id)
  if (entry || id !== MARK_SIZE_ID) return entry
  // The flag is inlined at export, so other bundles fold this to null and leave the large household out.
  const large = process.env.EXPO_PUBLIC_PERF_SAMPLES === '1' ? await import('@waypoint/core/fixtures/mark-size') : null
  return large ? { id: MARK_SIZE_ID, title: 'Large household for performance runs', build: large.markSize } : undefined
}

export async function loadSample(id: string, now: Date): Promise<Household> {
  const entry = await findSample(id)
  if (!entry) throw new DataError('unknown_sample', `There is no sample called ‘${id}’.`)
  // Built once for its time zone, then again for that zone's today.
  const sample = entry.build(todayIn(entry.build(todayIn('UTC', now)).doc.household.timezone, now))
  const snapshot = snapshotOf(sample.doc, sample.rates, now)
  return { kind: 'household', snapshot, rates: { rates: sample.rates, day: ratesDay(sample.rates), source: 'sample', error: null }, fetched_at: now.toISOString(), user_id: null, sample: entry }
}

// generation changes with the signed-in account (owner), so a new account starts a new query whose initial data is read afresh.
export function householdQuery(deps: LoadDeps, generation: number, owner: string | null) {
  let initial: Household | undefined
  return queryOptions<Loaded, Error, Loaded, readonly (string | number)[]>({
    queryKey: [...SUPABASE_KEY, generation],
    queryFn: () => loadHousehold(deps),
    // The saved copy shows at once and counts as old, so the first mount still loads.
    initialData: () => (initial = savedHousehold(deps.now(), owner)),
    initialDataUpdatedAt: () => (initial ? Date.parse(initial.fetched_at) : undefined),
  })
}

export function sampleQuery(id: string, now: () => Date) {
  return queryOptions<Loaded, Error, Loaded, readonly (string | number)[]>({
    queryKey: [...HOUSEHOLD_KEY, 'sample', id],
    queryFn: () => loadSample(id, now()),
    staleTime: Infinity,
  })
}

// A network failure shows Offline at once (a retry would also wait for the window to regain focus); a server error gets one more try.
function retryOnce(failures: number, error: Error): boolean {
  return failures < 1 && asDataError(error).kind === 'server'
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // A Snapshot is indexed by object identity (core snapshotIndex and runEngine's memo), so a refetch must not copy it.
      queries: { structuralSharing: false, networkMode: 'always', retry: retryOnce, refetchOnWindowFocus: true },
      // Fails at once instead of waiting for the browser to report a connection.
      mutations: { networkMode: 'always', retry: false },
    },
  })
}

export const queryClient = createQueryClient()

export interface PostBatchResult {
  status: 'applied' | 'already_applied'
  batch_id: string
  inserted: number
  balances_before: Record<string, number>
  balances_after: Record<string, number>
}

export async function postBatch(client: HouseholdClient, input: PostBatchInput): Promise<PostBatchResult> {
  const checked = checkInput(postBatchInput, input)
  if (!checked.ok) throw new DataError('rejected', 'This change did not pass the checks.', { code: 'bad_input', detail: { error: 'bad_input', issues: checked.errors }, technical: `bad_input: ${checked.errors.join('; ')}` })
  const { data, error, status } = await client.rpc('post_batch', { p_batch: checked.value })
  if (error) throw rpcError('post_batch', error, status)
  return data as PostBatchResult
}

// post_batch refused a batch made against balances that have moved since the screen loaded them.
export function staleRefusal(error: unknown): boolean {
  return error instanceof DataError && error.kind === 'rejected' && error.code === 'balance_mismatch'
}

// usePostBatch's mutation. Each reload is awaited, so a save or a stale refusal finishes with the latest numbers on screen.
export function postBatchOptions(queryClient: QueryClient, client: () => HouseholdClient, writable: boolean): MutationOptions<PostBatchResult, Error, PostBatchInput> {
  return {
    mutationFn: async (input) => {
      if (!writable) throw new DataError('read_only', 'Saving is off offline and in samples.')
      return postBatch(client(), input)
    },
    onSuccess: (_result, input) => {
      noteSave(input.rows)
      return refreshAfterWrite(queryClient)
    },
    onError: (error) => (staleRefusal(error) ? refreshAfterWrite(queryClient) : undefined),
  }
}

export interface ImportResult {
  household_id: string
  // Each document id and the uuid it was saved under, per table.
  ids: Record<string, Record<string, string>>
}

// Checked by core first, so a document the server would refuse never leaves the device; the import is one transaction, so a refusal writes nothing.
// null: the account already has a household, as after a retry whose first reply never arrived, so loading it is all that is left.
export async function importHousehold(client: HouseholdClient, doc: ImportDocInput): Promise<ImportResult | null> {
  const checked = checkInput(importDoc, doc)
  if (!checked.ok) throw new DataError('rejected', 'This household did not pass the checks.', { code: 'bad_input', detail: { error: 'bad_input', issues: checked.errors }, technical: `bad_input: ${checked.errors.join('; ')}` })
  const { data, error, status } = await client.rpc('import_household', { p_doc: checked.value })
  if (error) {
    const failure = rpcError('import_household', error, status)
    if (failure.code === 'household_not_empty') return null
    throw failure
  }
  return data as ImportResult
}

// Marks the household stale and reloads it in place: the old numbers stay on screen until the new ones replace them.
export function refreshAfterWrite(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: HOUSEHOLD_KEY })
}
