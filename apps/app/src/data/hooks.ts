import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { expandPlan, fundingCurrency, fxBreakeven, ledgerMonth, runEngine, yieldToScreen, type EngineRun, type FxBreakeven, type ImportDocInput, type LedgerRow, type Snapshot, type WalkFailure, type WalkMode } from '@waypoint/core'
import { createElement, startTransition, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LocaleContext, useLocale } from '@/ui/theme'
import { DataError } from './errors'
import { fetchRates } from './rates'
import { householdQuery, importHousehold, postBatchOptions, refreshAfterWrite, sampleQuery, type LoadDeps } from './query'
import { useDataSource, type DataSource } from './source'
import { dataView, type DataView } from './status'
import { getSupabase } from './supabase'

const now = () => new Date()

const DEPS: LoadDeps = {
  client: () => getSupabase(),
  fetchRates: () => fetchRates(),
  now,
}

export interface SnapshotState extends DataView {
  source: DataSource
  snapshot: Snapshot | undefined
  // A first load with nothing saved to show; later loads keep the old numbers on screen.
  loading: boolean
  // True only while a pull-to-refresh the person started is running; background reloads stay silent.
  refreshing: boolean
  refetch: () => void
  onRefresh: () => Promise<void>
}

// The one snapshot every screen reads: reloaded when the app regains focus, on pull-to-refresh and after each write.
export function useSnapshot(): SnapshotState {
  const { source, generation, owner } = useDataSource()
  const locale = useLocale()
  const query = useQuery(source.kind === 'sample' ? sampleQuery(source.id, now) : householdQuery(DEPS, generation, owner))
  const { data, error, refetch } = query
  const view = useMemo(() => dataView({ source, data, error, locale, now: new Date() }), [source, data, error, locale])
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }, [refetch])
  const again = useCallback(() => void refetch(), [refetch])
  return { ...view, source, snapshot: view.household?.snapshot, loading: view.phase === 'loading', refreshing, refetch: again, onRefresh }
}

// Snapshots runEngine has walked with no patch in full mode, so a screen can tell a cached walk from one that would hold the thread.
const WALKED = new WeakSet<Snapshot>()

// Walks the shared snapshot through core runEngine; screens on one snapshot share its walk.
export function useEngine(patch?: unknown, mode?: WalkMode): EngineRun | undefined {
  const { snapshot } = useSnapshot()
  if (!snapshot) return undefined
  const run = runEngine(snapshot, patch, mode)
  if (patch === undefined && (mode ?? 'full') === 'full') WALKED.add(snapshot)
  return run
}

// useEngine's walk, but one not made yet runs between frames, the plan's expansion in one task and the walk in the next, so a large household never holds the thread for long. Meanwhile the last walk drawn for the same household stays on screen, as other screens keep old numbers through a reload; undefined before the first.
export function useEngineSoon(): EngineRun | undefined {
  const { snapshot } = useSnapshot()
  const { source, generation, owner } = useDataSource()
  const [, setWalked] = useState<Snapshot | null>(null)
  const last = useRef<{ key: string; run: EngineRun } | null>(null)
  const key = `${source.kind === 'sample' ? `sample:${source.id}` : `household:${owner ?? ''}`} ${generation}`
  const warm = snapshot !== undefined && WALKED.has(snapshot)
  useEffect(() => {
    if (!snapshot || warm) return
    let live = true
    void nextTask()
      .then(() => {
        if (live) expandPlan(snapshot)
        return nextTask()
      })
      .then(() => {
        if (!live) return
        try {
          runEngine(snapshot)
        } finally {
          // A walk that throws throws again in the render, as useEngine's does. The screen then draws as a transition, which React splits between frames.
          WALKED.add(snapshot)
          startTransition(() => setWalked(snapshot))
        }
      })
    return () => {
      live = false
    }
  }, [snapshot, warm])
  if (!snapshot) return undefined
  if (!warm) return last.current?.key === key ? last.current.run : undefined
  const run = runEngine(snapshot)
  last.current = { key, run }
  return run
}

export type BreakevenResult = FxBreakeven | WalkFailure | null

const BREAKEVENS = new WeakMap<Snapshot, Promise<BreakevenResult | Error>>()

// A macrotask without the timer clamp that background browser tabs stretch to a second; phones keep core's own setTimeout.
function pause(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(null)
  })
}

// Hands the thread back to the screen once, so engine work started after it never shares a task with the render that asked for it.
export const nextTask = (): Promise<void> => (typeof MessageChannel === 'function' ? pause() : yieldToScreen())

// One FX breakeven per snapshot, shared by every screen that waits on it; a throw comes back as the Error. Its first walk starts a task later, so it never lengthens the render that asked for it.
export function breakevenOf(snapshot: Snapshot): Promise<BreakevenResult | Error> {
  let found = BREAKEVENS.get(snapshot)
  if (!found) {
    found = nextTask()
      .then(() => fxBreakeven(snapshot, typeof MessageChannel === 'function' ? { pause } : {}))
      .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    BREAKEVENS.set(snapshot, found)
  }
  return found
}

export type Breakeven = { ready: false } | { ready: true; value: BreakevenResult | Error }

const PENDING: Breakeven = { ready: false }
const NONE: Breakeven = { ready: true, value: null }

// The shared snapshot's FX breakeven, worked out between frames; at once in a one-currency household, which has none. The result is one object per snapshot, so it can key a memo.
export function useBreakeven(): Breakeven {
  const { snapshot } = useSnapshot()
  const single = snapshot !== undefined && fundingCurrency(snapshot) === null
  const [done, setDone] = useState<{ snapshot: Snapshot; result: Breakeven } | null>(null)
  useEffect(() => {
    if (!snapshot || single) return
    let live = true
    void breakevenOf(snapshot).then((value) => live && setDone({ snapshot, result: { ready: true, value } }))
    return () => {
      live = false
    }
  }, [snapshot, single])
  if (single) return NONE
  return done && done.snapshot === snapshot ? done.result : PENDING
}

export type LedgerMonth = { state: 'loading' } | { state: 'missing'; account_id: string } | { state: 'ready'; rows: readonly LedgerRow[] }

// A month of one account's ledger, read from the snapshot already loaded, with no request of its own.
export function useLedgerMonth(accountId: string, month: string): LedgerMonth {
  const { snapshot } = useSnapshot()
  return useMemo<LedgerMonth>(() => {
    if (!snapshot) return { state: 'loading' }
    if (!snapshot.doc.accounts.some((a) => a.id === accountId)) return { state: 'missing', account_id: accountId }
    return { state: 'ready', rows: ledgerMonth(snapshot, accountId, month) }
  }, [snapshot, accountId, month])
}

// False offline, in samples, and until a signed-in household (or its absence) is known.
export function useWritesEnabled(): boolean {
  return useSnapshot().writable
}

export function usePostBatch() {
  const queryClient = useQueryClient()
  const writable = useWritesEnabled()
  return useMutation(postBatchOptions(queryClient, DEPS.client, writable))
}

// Onboarding's one write. It finishes once the new household has loaded, which closes onboarding and opens Today.
export function useImportHousehold() {
  const queryClient = useQueryClient()
  const writable = useWritesEnabled()
  return useMutation({
    mutationFn: async (doc: ImportDocInput) => {
      if (!writable) throw new DataError('read_only', 'Saving is off while Waypoint cannot reach the server.')
      return importHousehold(DEPS.client(), doc)
    },
    onSuccess: () => refreshAfterWrite(queryClient),
  })
}

// Formats amounts in the household's locale once it is loaded; the device's until then.
export function HouseholdLocale({ children }: { children: ReactNode }) {
  const { household } = useSnapshot()
  return createElement(LocaleContext, { value: household?.snapshot.doc.household.locale }, children)
}
