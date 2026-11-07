import { convert, minorDigits, toRatesPerEur, type ImportDoc, type Rate } from '@waypoint/core'

// From this width the tabs, the FX chip and Settings sit in a sidebar; below it, the tabs sit at the bottom and the header holds the rest.
export const SIDEBAR_MIN_WIDTH = 1024

export const TABS = [
  { name: 'index', title: 'Today', href: '/' },
  { name: 'months', title: 'Months', href: '/months' },
  { name: 'money/index', title: 'Money', href: '/money' },
  { name: 'debts/index', title: 'Debts', href: '/debts' },
  { name: 'plan/index', title: 'Plan', href: '/plan' },
  { name: 'meals/index', title: 'Meals', href: '/meals' },
  { name: 'lending/index', title: 'Lending', href: '/lending' },
] as const

export type TabName = (typeof TABS)[number]['name']

// A tab is one of the five; a page is pushed over them and has Back; a flow (onboarding) stands alone, with nothing to leave to.
export type ScreenKind = 'tab' | 'page' | 'flow'

export interface Chrome {
  sidebar: boolean
  back: boolean
  add: boolean
  settings: boolean
  fx: boolean
}

// What the header carries. Settings is in it on every screen without the sidebar, except the settings pages themselves.
export function chrome(kind: ScreenKind, width: number, onSettings = false): Chrome {
  if (kind === 'flow') return { sidebar: false, back: false, add: false, settings: false, fx: false }
  const sidebar = kind === 'tab' && width >= SIDEBAR_MIN_WIDTH
  return { sidebar, back: kind === 'page', add: kind === 'tab', settings: !sidebar && !onSettings, fx: kind === 'tab' && !sidebar }
}

export interface FxPair {
  from: string
  to: string
  // One unit of `from` in its minor units, and what it buys of `to`.
  unit_minor: number
  quote_minor: number
}

export function householdCurrencies(doc: ImportDoc): string[] {
  const open = doc.accounts.filter((a) => a.archived_at === null).map((a) => a.currency)
  return [...new Set([doc.household.base_currency, ...open])]
}

// Each other currency against the base, with the stronger one as the unit so the rate reads above 1 ('€1 = ₱70.20'); empty with one currency.
export function fxPairs(base: string, currencies: readonly string[], rates: readonly Rate[]): FxPair[] {
  const perEur = toRatesPerEur(rates)
  const pairs: FxPair[] = []
  for (const other of [...new Set(currencies)].filter((c) => c !== base).sort()) {
    const oneBase = convert(10 ** minorDigits(base), base, other, perEur)
    if (oneBase === null) continue
    const [from, to] = oneBase >= 10 ** minorDigits(other) ? [base, other] : [other, base]
    const unit = 10 ** minorDigits(from)
    const quote = convert(unit, from, to, perEur)
    if (quote !== null) pairs.push({ from, to, unit_minor: unit, quote_minor: quote })
  }
  return pairs
}

// The account the Add sheet opens on when this device remembers none: where money last went out, else the first open cash account.
export function lastAccountId(doc: ImportDoc): string | null {
  const open = new Set(doc.accounts.filter((a) => a.archived_at === null).map((a) => a.id))
  let last: { id: string; day: string } | null = null
  for (const t of doc.transactions) {
    if (t.kind === 'expense' && open.has(t.account_id) && (last === null || t.posted_on >= last.day)) last = { id: t.account_id, day: t.posted_on }
  }
  if (last) return last.id
  const cash = doc.accounts.filter((a) => a.kind === 'cash' && a.archived_at === null).sort((a, b) => a.sort_order - b.sort_order)
  return cash[0]?.id ?? null
}

// The list a page belongs to, which Back opens when the app opened on the page from a link (the tabs' anchor would give Today).
export function parentOf(path: string): '/money' | '/debts' | '/plan' | '/meals' | '/settings' | null {
  if (/^\/money\/[^/]+$/.test(path)) return '/money'
  if (/^\/debts\/[^/]+$/.test(path)) return '/debts'
  if (/^\/plan\/(compare|item\/[^/]+)$/.test(path)) return '/plan'
  if (/^\/meals\/.+$/.test(path)) return '/meals'
  if (/^\/settings\/account\/[^/]+$/.test(path) || path === '/import') return '/settings'
  return null
}

// The address the app opened on, and whether the person has moved away from it since.
export interface Landing {
  first: string | null
  moved: boolean
}

export const NO_LANDING: Landing = { first: null, moved: false }

export function followRoute(landing: Landing, path: string): Landing {
  if (landing.first === null) return { first: path, moved: false }
  return landing.moved || path === landing.first ? landing : { ...landing, moved: true }
}

// Still on the page the app opened on, so nothing in the app led here.
export const landedHere = (landing: Landing, path: string) => !landing.moved && landing.first === path
