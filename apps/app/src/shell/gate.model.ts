import type { Phase } from '@/data/status'

// Drawn as the kit's sheet over the screen they opened from.
export const SHEET_ROUTES = ['add', 'statement', 'reconcile'] as const

// Pushed over the tabs; with the tabs and the sheets they open only with a household or a sample to show.
export const PAGE_ROUTES = [
  'budgets',
  'meals/[...path]',
  'import',
  'settings/index',
  'settings/account/[id]',
  'plan/compare',
  'plan/item/[id]',
  'money/[accountId]',
  'debts/[accountId]',
] as const

// Open to everyone: Google Play needs account deletion reachable from the web without the app, and an unknown address says so whoever follows it.
export const PUBLIC_ROUTES = ['delete-account', '+not-found'] as const

export interface GateInput {
  // The signed-in account this device knows of, read from storage at once (data/source owner).
  owner: string | null
  // A read-only sample is open.
  sample: boolean
  // The open data source's phase: the sample's, or the signed-in household's.
  phase: Phase
}

// Which routes are open. The stack sends anyone on a closed route to the first open one: Welcome, then onboarding, then the tabs.
export interface Gate {
  welcome: boolean
  onboarding: boolean
  app: boolean
}

// A stored session counts at once, so restoring it never waits on the network; the server can still end it (phase signed_out).
export function gate({ owner, sample, phase }: GateInput): Gate {
  const signedIn = owner !== null && (sample || phase !== 'signed_out')
  if (sample) return { welcome: !signedIn, onboarding: false, app: true }
  if (!signedIn) return { welcome: true, onboarding: false, app: false }
  // Until the export answers, both stay open, so a reload on either route keeps it.
  return { welcome: false, onboarding: phase === 'no_household' || phase === 'loading', app: phase !== 'no_household' }
}

// Where Back goes with no history, as after a direct visit to the public delete page: the tabs when open, else set-up, else Welcome.
export const homeOf = (open: Gate) => (open.app ? '/' : open.onboarding ? '/onboarding' : '/welcome')
