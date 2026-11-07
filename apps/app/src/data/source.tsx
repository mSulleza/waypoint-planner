import { focusManager, QueryClientProvider } from '@tanstack/react-query'
import { useGlobalSearchParams, useRouter } from 'expo-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import { followAccount, type Account } from './account'
import { queryClient } from './query'
import { followSampleParam, resumeSampleParam, type SampleParam } from './source-state'
import { getSupabase, storedUserId } from './supabase'

// Where the screens' one snapshot comes from: the signed-in household, or a read-only sample.
export type DataSource = { kind: 'supabase' } | { kind: 'sample'; id: string }

// The account half: who is signed in, and whether the last session ended by itself or with its account deleted (Welcome then says so).
export interface DataSourceValue extends Account {
  source: DataSource
  // Opens a sample before any route that needs it, so a link to the tabs can follow once they are open.
  openSample: (id: string) => void
  // Closes the sample and takes ?sample= out of the URL.
  exitSample: () => void
}

const SUPABASE: DataSource = { kind: 'supabase' }

export const DataSourceContext = createContext<DataSourceValue>({ source: SUPABASE, generation: 0, owner: null, ended: false, deleted: false, openSample: () => undefined, exitSample: () => undefined })

export function useDataSource(): DataSourceValue {
  return useContext(DataSourceContext)
}

function useAccount(): Account {
  const [account, setAccount] = useState<Account>(() => ({ generation: 0, owner: storedUserId(), ended: false, deleted: false }))
  const current = useRef(account)
  useEffect(() => {
    let auth: ReturnType<typeof getSupabase>['auth']
    try {
      auth = getSupabase().auth
    } catch {
      return
    }
    return followAccount(
      auth,
      queryClient,
      () => current.current,
      (next) => {
        current.current = next
        setAccount(next)
      },
    )
  }, [])
  return account
}

// Phones have no window focus; the app coming to the front counts as focus, and the session refresh loop runs only then.
function useAppFocus() {
  useEffect(() => {
    if (Platform.OS === 'web') return
    const sub = AppState.addEventListener('change', (state) => {
      const active = state === 'active'
      focusManager.setFocused(active)
      try {
        const auth = getSupabase().auth
        void (active ? auth.startAutoRefresh() : auth.stopAutoRefresh())
      } catch {
        // Not configured: the load reports it.
      }
    })
    return () => sub.remove()
  }, [])
}

// What the last mount left, for a remount of the whole app by the router.
let kept: SampleParam | null = null

export function DataProvider({ children }: { children: ReactNode }) {
  // ?sample=<id> on any route opens that sample; it stays open while the person moves around, until exitSample.
  const { sample } = useGlobalSearchParams<{ sample?: string | string[] }>()
  const asked = typeof sample === 'string' && sample !== '' ? sample : null
  const [param, setParam] = useState<SampleParam>(() => resumeSampleParam(kept, asked))
  const next = followSampleParam(param, asked)
  if (next !== param) setParam(next)
  kept = next
  const router = useRouter()
  const openSample = useCallback((id: string) => setParam((p) => ({ ...p, open: id })), [])
  const exitSample = useCallback(() => {
    setParam((p) => ({ ...p, open: null }))
    router.setParams({ sample: undefined })
  }, [router])
  const { generation, owner, ended, deleted } = useAccount()
  useAppFocus()
  const sampleId = next.open
  const value = useMemo<DataSourceValue>(
    () => ({ source: sampleId === null ? SUPABASE : { kind: 'sample', id: sampleId }, generation, owner, ended, deleted, openSample, exitSample }),
    [sampleId, generation, owner, ended, deleted, openSample, exitSample],
  )
  return (
    <QueryClientProvider client={queryClient}>
      <DataSourceContext value={value}>{children}</DataSourceContext>
    </QueryClientProvider>
  )
}
