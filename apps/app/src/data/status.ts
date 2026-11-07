import { asDataError, ERROR_TITLES, type DataError } from './errors'
import type { Household, Loaded } from './query'
import type { DataSource } from './source'

export interface Notice {
  id: 'sample' | 'offline' | 'error' | 'rates' | 'signed_out' | 'no_household'
  tone: 'positive' | 'caution' | 'negative' | 'neutral'
  title: string
  body?: string
  // The server's own words behind an error, shown only on request.
  detail?: string
  // samples: offer the Welcome samples in place of one that does not exist.
  action?: 'retry' | 'sign_in' | 'leave_sample' | 'samples'
}

export type Phase = 'loading' | 'ready' | 'failed' | 'signed_out' | 'no_household'

export interface DataView {
  phase: Phase
  // What screens draw from; null while loading, signed out, without a household, or after a first read that failed.
  household: Household | null
  error: DataError | null
  // Banners for the top of the screen, above the figures they qualify.
  notices: readonly Notice[]
  // The last load failed with a network error.
  offline: boolean
  writable: boolean
}

export interface ViewInput {
  source: DataSource
  data: Loaded | undefined
  error: unknown
  locale: string
  now: Date
  // The device's zone when left out; set in tests.
  timeZone?: string
}

export function updatedAt(fetchedAt: string, { locale, now, timeZone }: Pick<ViewInput, 'locale' | 'now' | 'timeZone'>): string {
  const at = new Date(fetchedAt)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(at)
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d)
  if (day(at) === day(now)) return time
  return `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone }).format(at)} ${time}`
}

export function shortDay(day: string, locale: string, withYear = false): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function failureNotice(failure: DataError, household: Household | null, input: ViewInput): Notice {
  const at = household ? updatedAt(household.fetched_at, input) : null
  if (failure.kind === 'network') {
    return at
      ? { id: 'offline', tone: 'caution', title: `Offline · updated ${at}`, body: 'Showing the numbers saved on this device. Saving is off until Waypoint reaches the server again.', action: 'retry' }
      : { id: 'offline', tone: 'negative', title: 'Offline', body: 'Waypoint could not reach the server, and this device has no saved numbers yet.', action: 'retry' }
  }
  const message = /[.!?]$/.test(failure.message) ? failure.message : `${failure.message}.`
  const body = at ? `${message} The numbers below are from ${at} and may be out of date.` : message
  const notice: Notice = { id: 'error', tone: 'negative', title: ERROR_TITLES[failure.kind], body, action: 'retry' }
  return failure.technical ? { ...notice, detail: failure.technical } : notice
}

// Named only where amounts cross currencies; a one-currency household never converts.
function ratesNotice(household: Household, locale: string): Notice | null {
  const { snapshot, rates } = household
  const currencies = new Set([snapshot.doc.household.base_currency, ...snapshot.doc.accounts.map((a) => a.currency)])
  if (currencies.size < 2 || rates.error === null) return null
  const reason = sentence(rates.error)
  if (rates.source === 'saved' && rates.day) {
    const day = shortDay(rates.day, locale)
    return { id: 'rates', tone: 'caution', title: `Saved exchange rates · ${day}`, body: `${reason}, so amounts across currencies use the ECB rates of ${day} saved on this device.` }
  }
  return { id: 'rates', tone: 'negative', title: 'No exchange rates', body: `${reason}, and this device has none saved. Amounts across currencies cannot be converted.`, action: 'retry' }
}

export function dataView(input: ViewInput): DataView {
  const { source, data } = input
  const error = input.error ? asDataError(input.error) : null
  const offline = error?.kind === 'network'
  const notices: Notice[] = []
  // Retry cannot find a sample that does not exist; the real ones are offered instead.
  if (error?.kind === 'unknown_sample') {
    notices.push({ id: 'error', tone: 'neutral', title: ERROR_TITLES.unknown_sample, body: `${error.message} Open one of these instead.`, action: 'samples' })
    return { phase: 'failed', household: null, error, notices, offline: false, writable: false }
  }
  if (source.kind === 'sample') {
    const name = data?.kind === 'household' && data.sample ? `${data.sample.title}. ` : ''
    notices.push({ id: 'sample', tone: 'neutral', title: 'Sample data', body: `${name}Saving is off in samples.`, action: 'leave_sample' })
  }
  // An ended session keeps nothing on screen: the saved numbers belonged to it.
  if (error?.kind === 'signed_out' || data?.kind === 'signed_out') {
    notices.push({ id: 'signed_out', tone: 'neutral', title: 'Signed out', body: error?.kind === 'signed_out' ? error.message : 'Sign in to load your household.', action: 'sign_in' })
    return { phase: 'signed_out', household: null, error, notices, offline: false, writable: false }
  }
  const household = data?.kind === 'household' ? data : null
  if (error) notices.push(failureNotice(error, household, input))
  else if (household) {
    const rates = ratesNotice(household, input.locale)
    if (rates) notices.push(rates)
  }
  if (data?.kind === 'no_household') {
    if (!error) notices.push({ id: 'no_household', tone: 'neutral', title: 'No household yet', body: 'This account has no household. Set one up to see your numbers.' })
    return { phase: 'no_household', household: null, error, notices, offline, writable: source.kind === 'supabase' && !offline }
  }
  const phase: Phase = household ? 'ready' : error ? 'failed' : 'loading'
  return { phase, household, error, notices, offline, writable: source.kind === 'supabase' && household !== null && !offline }
}
