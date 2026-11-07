import { buildSnapshot, parseRates, runEngine, SnapshotError, todayIn, type Rate, type Snapshot, type Walk } from '@waypoint/core'
import type { Db } from './auth'
import { AgentError } from './errors'

export const RATES_TIMEOUT_MS = 8000

// live: fetched today. saved: today's fetch failed and these are the last good rates. none: failed with nothing kept.
export interface RatesInfo {
  rates: readonly Rate[]
  // The ECB publication day the rates belong to; null when there are none.
  day: string | null
  source: 'live' | 'saved' | 'none'
  // Why the fetch failed, when it did.
  problem: string | null
}

export function ratesDay(rates: readonly Rate[]): string | null {
  let day: string | null = null
  for (const r of rates) if (day === null || r.day > day) day = r.day
  return day
}

function why(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'the rate service did not answer in time'
  if (error instanceof Error && error.message.startsWith('the rate service')) return error.message
  if (error instanceof TypeError) return 'the rate service could not be reached'
  return 'the rate service sent rates that did not pass the checks'
}

export function fetchRates(url: string, fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = RATES_TIMEOUT_MS): () => Promise<Rate[]> {
  return async () => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`the rate service answered HTTP ${res.status}`)
    return parseRates(await res.json())
  }
}

// The day's rates are fetched once and kept in memory; a failed fetch falls back to the last good rates with their own day.
export class DailyRates {
  private kept: { key: string; rates: Rate[] } | null = null

  constructor(private readonly fetchLive: () => Promise<Rate[]>) {}

  async forDay(key: string): Promise<RatesInfo> {
    const kept = this.kept
    if (kept?.key === key) return { rates: kept.rates, day: ratesDay(kept.rates), source: 'live', problem: null }
    try {
      const rates = await this.fetchLive()
      this.kept = { key, rates }
      return { rates, day: ratesDay(rates), source: 'live', problem: null }
    } catch (error) {
      if (kept) return { rates: kept.rates, day: ratesDay(kept.rates), source: 'saved', problem: why(error) }
      return { rates: [], day: null, source: 'none', problem: why(error) }
    }
  }
}

// One read's inputs and its full walk with the card and loan modules (core runEngine).
export interface World {
  snapshot: Snapshot
  walk: Walk
  rates: RatesInfo
  web_url: string | null
}

export interface SessionLike {
  client(): Promise<Db>
  drop(db: Db): void
}

// PostgREST's answers to a token it no longer takes; the session is dropped and the call tried once more.
const REFUSED = new Set(['PGRST301', 'PGRST302', 'PGRST303'])

// What PostgREST answers: Postgres's code, message and DETAIL, or its own PGRST code.
export interface DbError {
  code: string
  message: string
  details?: string | null
  hint?: string | null
}

export interface Reply {
  data: unknown
  error: DbError | null
  status: number
}

// One REST request or SQL function call with the signed-in client.
export type Request = (db: Db) => PromiseLike<Reply>

const zoneOf = (doc: unknown): string => {
  const zone = (doc as { household?: { timezone?: unknown } } | null)?.household?.timezone
  return typeof zone === 'string' ? zone : 'UTC'
}

export class Household {
  // The day key for the rates is the household's own day once its time zone is known.
  private zone = 'UTC'

  constructor(
    private readonly session: SessionLike,
    private readonly rates: DailyRates,
    private readonly web_url: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // A request the server refused for its token never ran, so it is sent once more after signing in again.
  async send(request: Request, retry = true): Promise<Reply> {
    const db = await this.session.client()
    const reply = await request(db)
    if (reply.error && retry && (reply.status === 401 || REFUSED.has(reply.error.code))) {
      this.session.drop(db)
      return this.send(request, false)
    }
    return reply
  }

  private async exported(): Promise<unknown> {
    const { data, error } = await this.send((db) => db.rpc('export_household'))
    if (!error) return data
    throw new AgentError(`export_household failed: ${error.message}${error.code ? ` (${error.code})` : ''}`)
  }

  // Each read is one export_household call plus the day's rates, run through core.
  async load(): Promise<World> {
    const now = this.now()
    const [doc, rates] = await Promise.all([this.exported(), this.rates.forDay(todayIn(this.zone, now))])
    if (doc === null || doc === undefined) throw new AgentError('This account has no household yet. Set one up in the Waypoint app first.')
    let asOf: string
    try {
      asOf = todayIn(zoneOf(doc), now)
    } catch {
      throw new AgentError('The household’s time zone is not one Waypoint knows, so it cannot tell what day it is there.')
    }
    this.zone = zoneOf(doc)
    let snapshot: Snapshot
    try {
      snapshot = buildSnapshot(doc, asOf, rates.rates)
    } catch (error) {
      if (!(error instanceof SnapshotError)) throw error
      throw new AgentError(`The household’s data did not pass the checks: ${error.issues.slice(0, 5).join('; ')}${error.issues.length > 5 ? ` (and ${error.issues.length - 5} more)` : ''}`)
    }
    const run = runEngine(snapshot)
    if (!run.ok) {
      const rateNote = rates.source === 'none' ? ` The day's exchange rates are missing because ${rates.problem}.` : ''
      throw new AgentError(`The projection could not run: ${run.errors.map((e) => (typeof e === 'string' ? e : e.message)).join(' ')}${rateNote}`)
    }
    return { snapshot: run.world.snapshot, walk: run.walk, rates, web_url: this.web_url }
  }
}
