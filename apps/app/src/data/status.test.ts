import { buildSnapshot } from '@waypoint/core'
import { abroad, usCardsCar } from '@waypoint/core/fixtures'
import { SAMPLES } from '@waypoint/core/fixtures/samples'
import { describe, expect, it } from 'vitest'
import { DataError } from './errors'
import type { Household, Loaded } from './query'
import type { RatesInfo } from './rates'
import type { DataSource } from './source'
import { dataView, updatedAt, type ViewInput } from './status'
import { AS_OF, NOON } from './test-helpers'

const SUPABASE: DataSource = { kind: 'supabase' }
const FETCHED = '2026-10-07T05:42:00.000Z'
const live: RatesInfo = { rates: [], day: '2026-10-07', source: 'live', error: null }

function householdOf(sample = abroad(AS_OF), rates: RatesInfo = live): Household {
  return { kind: 'household', snapshot: buildSnapshot(sample.doc, AS_OF, sample.rates), rates, fetched_at: FETCHED, user_id: 'user-a', sample: null }
}

const view = (data: Loaded | undefined, error: unknown = null, source: DataSource = SUPABASE) => dataView({ source, data, error, locale: 'en-GB', now: NOON, timeZone: 'Europe/Madrid' } satisfies ViewInput)
const offline = new DataError('network', 'Waypoint could not reach the server.', { technical: 'export_household: TypeError: Failed to fetch (HTTP 0)' })
const server = new DataError('server', 'The server had a problem. Try again in a moment.', { code: 'XX000', technical: 'export_household: boom (XX000, HTTP 500)' })

describe('dataView', () => {
  it('shows a failed first read as a labelled error with Retry and nothing to draw, never as zero', () => {
    const v = view(undefined, server)
    expect(v.phase).toBe('failed')
    expect(v.household).toBeNull()
    expect(v.notices).toEqual([
      { id: 'error', tone: 'negative', title: 'Could not load your household', body: 'The server had a problem. Try again in a moment.', detail: 'export_household: boom (XX000, HTTP 500)', action: 'retry' },
    ])
    expect(v.writable).toBe(false)
  })

  it('puts a failed refresh above the figures it leaves out of date', () => {
    const v = view(householdOf(), server)
    expect(v.phase).toBe('ready')
    expect(v.household).not.toBeNull()
    expect(v.notices[0]).toEqual({
      id: 'error',
      tone: 'negative',
      title: 'Could not load your household',
      body: 'The server had a problem. Try again in a moment. The numbers below are from 07:42 and may be out of date.',
      detail: 'export_household: boom (XX000, HTTP 500)',
      action: 'retry',
    })
  })

  it('reads offline as the saved numbers with the time they were loaded and saving off', () => {
    const v = view(householdOf(), offline)
    expect(v.offline).toBe(true)
    expect(v.writable).toBe(false)
    expect(v.household?.fetched_at).toBe(FETCHED)
    expect(v.notices).toEqual([{ id: 'offline', tone: 'caution', title: 'Offline · updated 07:42', body: 'Showing the numbers saved on this device. Saving is off until Waypoint reaches the server again.', action: 'retry' }])
    expect(view(undefined, offline).notices[0]).toMatchObject({ id: 'offline', tone: 'negative', title: 'Offline' })
  })

  it('keeps an error, an account without a household and a household with empty tables apart', () => {
    const refused = view(undefined, new DataError('not_allowed', 'This account is not allowed to read this household.'))
    const none = view({ kind: 'no_household', user_id: 'user-a' })
    const empty = view(householdOf({ doc: { ...abroad(AS_OF).doc, accounts: [], plan_items: [], statements: [], transactions: [], categories: [] }, rates: [] }))
    expect([refused.phase, none.phase, empty.phase]).toEqual(['failed', 'no_household', 'ready'])
    expect(refused.notices.map((n) => n.title)).toEqual(['Not allowed'])
    expect(none.notices.map((n) => n.title)).toEqual(['No household yet'])
    expect(empty.notices).toEqual([])
    expect(empty.household?.snapshot.doc.accounts).toEqual([])
  })

  it('hides the saved numbers once the session has ended', () => {
    const v = view(householdOf(), new DataError('signed_out', 'Your session has ended. Sign in again.'))
    expect([v.phase, v.household, v.writable]).toEqual(['signed_out', null, false])
    expect(v.notices).toEqual([{ id: 'signed_out', tone: 'neutral', title: 'Signed out', body: 'Your session has ended. Sign in again.', action: 'sign_in' }])
  })

  it('marks a sample by name, offers a way out and turns saving off', () => {
    const entry = SAMPLES.find((s) => s.id === 'abroad')!
    const v = view({ ...householdOf(), user_id: null, sample: entry }, null, { kind: 'sample', id: 'abroad' })
    expect(v.writable).toBe(false)
    expect(v.notices).toEqual([{ id: 'sample', tone: 'neutral', title: 'Sample data', body: 'EUR income paying PHP debts. Saving is off in samples.', action: 'leave_sample' }])
    // While it builds, the banner already says it is a sample.
    expect(view(undefined, null, { kind: 'sample', id: 'abroad' }).notices).toEqual([{ id: 'sample', tone: 'neutral', title: 'Sample data', body: 'Saving is off in samples.', action: 'leave_sample' }])
  })

  it('offers the real samples for an unknown one, with no sample banner and no Retry', () => {
    const v = view(undefined, new DataError('unknown_sample', 'There is no sample called ‘nope’.'), { kind: 'sample', id: 'nope' })
    expect([v.phase, v.household, v.writable, v.offline]).toEqual(['failed', null, false, false])
    expect(v.notices).toEqual([{ id: 'error', tone: 'neutral', title: 'No such sample', body: 'There is no sample called ‘nope’. Open one of these instead.', action: 'samples' }])
  })

  it('names fallback rates only where amounts cross currencies', () => {
    const saved: RatesInfo = { rates: [], day: '2026-10-05', source: 'saved', error: 'the rate service could not be reached' }
    const none: RatesInfo = { rates: [], day: null, source: 'none', error: 'the rate service could not be reached' }
    expect(view(householdOf(abroad(AS_OF), saved)).notices).toEqual([
      { id: 'rates', tone: 'caution', title: 'Saved exchange rates · 5 Oct', body: 'The rate service could not be reached, so amounts across currencies use the ECB rates of 5 Oct saved on this device.' },
    ])
    expect(view(householdOf(abroad(AS_OF), none)).notices[0]).toMatchObject({ id: 'rates', tone: 'negative', title: 'No exchange rates', action: 'retry' })
    expect(view(householdOf(usCardsCar(AS_OF), none)).notices).toEqual([])
  })
})

describe('updatedAt', () => {
  it('gives the time alone today and the day before it otherwise', () => {
    const at = { locale: 'en-GB', now: NOON, timeZone: 'Europe/Madrid' }
    expect(updatedAt(FETCHED, at)).toBe('07:42')
    expect(updatedAt('2026-10-05T18:05:00.000Z', at)).toBe('5 Oct 20:05')
  })
})
