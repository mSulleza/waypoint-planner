import { QueryObserver } from '@tanstack/react-query'
import { parseRates } from '@waypoint/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ecb from '../../../../packages/core/test/fixtures/frankfurter-2026-10-07.json'
import { followAccount, type Account } from '../data/account'
import { createQueryClient, householdQuery, type LoadDeps } from '../data/query'
import type { RatesInfo } from '../data/rates'
import { readSaved, writeSaved } from '../data/saved'
import { dataView } from '../data/status'
import { AUTH_STORAGE_KEY, createWaypointClient, storedUserId, type WaypointClient } from '../data/supabase'
import { abroadDoc, memoryStorage, NOON, SESSION } from '../data/test-helpers'
import { gate } from './gate.model'

const RATES = parseRates(ecb)
const live = async (): Promise<RatesInfo> => ({ rates: RATES, day: '2026-10-07', source: 'live', error: null })

// What local Supabase answered on 8 Oct 2026 for a stored access token whose signature no longer verifies.
const REFUSED_READ = { status: 401, body: { code: 'PGRST301', details: 'None of the keys was able to decode the JWT', hint: null, message: 'No suitable key or wrong key type' } }
const REFUSED_LOGOUT = { status: 403, body: { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature, token signature is invalid: crypto/ecdsa: verification error' } }

const READ = 'rest/v1/rpc/export_household'
// A loop asks again far faster than the test's timers run, so the stand-in goes offline after this many reads and the count shows it.
const LOOP = 50

// Stands in for the Auth and database endpoints, recording each request's path.
function refusingServer() {
  const sent: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname.slice(1)
    sent.push(path)
    if (sent.filter((p) => p === READ).length > LOOP) throw new TypeError('Failed to fetch')
    const reply = path === READ ? REFUSED_READ : path === 'auth/v1/logout' ? REFUSED_LOGOUT : { status: 404, body: {} }
    return Response.json(reply.body, { status: reply.status })
  }
  return { sent, client: createWaypointClient('http://127.0.0.1:54321', 'sb_publishable_test-key', { storage: globalThis.localStorage, fetch: fetchImpl }) }
}

// The root stack declares Welcome, then onboarding, then the tabs: the route on screen stays while open, and a closed one gives way to the first open route.
const ORDER = ['welcome', 'onboarding', 'app'] as const
type Route = (typeof ORDER)[number]

// The app as _layout runs it: the account listener, the root's useSnapshot that feeds the gate, and the screen on top, given its own useSnapshot each time the stack moves as Screen does (Welcome has none, so this asks at least as often as the app).
function startApp(client: WaypointClient, route: Route) {
  const queryClient = createQueryClient()
  const deps: LoadDeps = { client: () => client, fetchRates: live, now: () => NOON }
  let account: Account = { generation: 0, owner: storedUserId(), ended: false, deleted: false }
  const options = () => householdQuery(deps, account.generation, account.owner)
  const root = new QueryObserver(queryClient, options())
  let screen = new QueryObserver(queryClient, options())
  let leaveScreen = screen.subscribe(() => undefined)
  const moves: Route[] = [route]
  const draw = () => {
    for (const observer of [root, screen]) observer.setOptions(options())
    const { data, error } = root.getCurrentResult()
    const { phase } = dataView({ source: { kind: 'supabase' }, data, error, locale: 'en-GB', now: NOON })
    const open = gate({ owner: account.owner, sample: false, phase })
    const next = open[route] ? route : ORDER.find((r) => open[r])!
    if (next === route) return
    route = next
    moves.push(next)
    leaveScreen()
    screen = new QueryObserver(queryClient, options())
    leaveScreen = screen.subscribe(() => undefined)
  }
  const stopAccount = followAccount(
    client.auth,
    queryClient,
    () => account,
    (next) => {
      account = next
      draw()
    },
  )
  const leaveRoot = root.subscribe(draw)
  return {
    queryClient,
    moves,
    account: () => account,
    stop: () => {
      leaveScreen()
      leaveRoot()
      stopAccount()
      queryClient.clear()
      void client.auth.stopAutoRefresh()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  // A session this device kept, whose access token the server no longer accepts (a rotated signing key, another project's token).
  globalThis.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(SESSION))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the gate with a session the server refuses', () => {
  it('settles on Welcome after one read when nothing is saved, as for a new account before onboarding', async () => {
    const { sent, client } = refusingServer()
    const app = startApp(client, 'app')
    await settle()
    const reads = sent.filter((p) => p === READ).length
    const { moves, account } = app
    app.stop()
    expect(reads).toBe(1)
    expect(moves).toEqual(['app', 'welcome'])
    expect(sent.filter((p) => p === 'auth/v1/logout')).toHaveLength(1)
    expect(account()).toEqual({ generation: 1, owner: null, ended: true, deleted: false })
    expect(storedUserId()).toBeNull()
  })

  it('stays on Welcome without another read when the window regains focus', async () => {
    const { sent, client } = refusingServer()
    const app = startApp(client, 'onboarding')
    await settle()
    await app.queryClient.refetchQueries({ type: 'active' })
    await settle()
    const { moves } = app
    app.stop()
    expect(sent.filter((p) => p === READ)).toHaveLength(1)
    expect(moves).toEqual(['onboarding', 'welcome'])
  })

  it('drops the saved household of a refused session and shows Welcome', async () => {
    writeSaved({ user_id: 'user-a', fetched_at: NOON.toISOString(), doc: abroadDoc(), rates: RATES })
    const { sent, client } = refusingServer()
    const app = startApp(client, 'app')
    await settle()
    const { moves } = app
    app.stop()
    expect(sent.filter((p) => p === READ)).toHaveLength(1)
    expect(moves).toEqual(['app', 'welcome'])
    expect(readSaved()).toBeNull()
  })
})
