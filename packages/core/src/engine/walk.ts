import { daysInMonth } from '../dates'
import { fxTerms, grossFor, netOf } from '../money'
import { missingRates, toRatesPerEur, type RatesPerEur } from '../rates'
import { floorAndTarget, type Account } from '../schema/rows'
import { snapshotIndex, type Snapshot } from '../snapshot'
import { NO_CARDS, NO_LOANS, type CardModule, type DebtModule, type DebtMove, type DebtOutput, type ExtraOffer, type LoanModule } from './debts'
import { addShares, expandPlan } from './events'
import { fundingCurrency, shiftRates } from './fx'
import { rollUp, type DayTrack } from './rollup'
import { fundingOrder, sizeTopUp } from './topups'
import { ORDER, type EngineEvent, type LineFlag, type LineItem, type LineSource, type MonthFigures, type WalkError, type WalkFailure, type WalkMode, type WalkResult } from './types'

export interface WalkOptions {
  // 'metrics' skips line items; balances and month figures are the same.
  mode?: WalkMode
  // A fraction: −0.1 makes the funding currency worth 10% less.
  fx_shift_pct?: number
  cards?: CardModule
  loans?: LoanModule
}

interface Track extends DayTrack {
  account: Account
  balance: number
  // Every movement but top-ups, per walked day: known before the walk, so a top-up can look ahead to month end.
  flow: Float64Array
}

interface Terms {
  rate: number
  feePct: number
}

const NONE: readonly LineFlag[] = Object.freeze([])
const TO_SEND: readonly LineFlag[] = Object.freeze(['to_send'])
const OVERDUE: readonly LineFlag[] = Object.freeze(['overdue'])

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

// Every day from `from` to `to`, counted without parsing each one.
function walkedDays(from: string, to: string): string[] {
  const days: string[] = []
  let [y, m, d] = [Number(from.slice(0, 4)), Number(from.slice(5, 7)), Number(from.slice(8, 10))]
  let length = daysInMonth(from)
  for (;;) {
    const day = `${pad(y, 4)}-${pad(m)}-${pad(d)}`
    days.push(day)
    if (day >= to) return days
    if (++d > length) {
      d = 1
      if (++m > 12) [y, m] = [y + 1, 1]
      length = daysInMonth(`${pad(y, 4)}-${pad(m)}`)
    }
  }
}

// The database cannot see these, so the engine names them (spec §4).
function shapeErrors(snapshot: Snapshot): WalkError[] {
  const { accounts } = snapshotIndex(snapshot)
  const errors: WalkError[] = []
  for (const s of snapshot.doc.statements) {
    const a = accounts.get(s.account_id)
    if (a && a.kind !== 'credit_card') errors.push({ code: 'statement_not_on_card', message: `Statement '${s.id}' is on '${a.id}', which is not a credit card`, ids: [s.id, a.id] })
  }
  for (const t of snapshot.doc.transactions) {
    const a = accounts.get(t.account_id)
    if (a && t.posted_on < a.opening_date) errors.push({ code: 'row_before_opening', message: `Transaction '${t.id}' on '${a.id}' is dated ${t.posted_on}, before the account opens on ${a.opening_date}`, ids: [t.id, a.id] })
  }
  return errors
}

// Rate and source fee for every pair money may cross in this walk; a missing rate is an error, never a zero.
function conversions(snapshot: Snapshot, rates: RatesPerEur, pairs: readonly [Account, Account][]): { terms: Map<string, Terms>; errors: WalkError[] } {
  const terms = new Map<string, Terms>()
  const missing = new Map<string, Set<string>>()
  for (const [from, to] of pairs) {
    const key = `${from.id}>${to.id}`
    if (terms.has(key)) continue
    // No fee set means the money moves at the bare rate.
    const found = fxTerms(from.currency, to.currency, rates, from.kind === 'cash' ? (from.fx_fee_pct ?? 0) : 0)
    if (found) terms.set(key, found)
    else for (const code of missingRates([from.currency, to.currency], snapshot.rates)) missing.set(code, (missing.get(code) ?? new Set()).add(from.id).add(to.id))
  }
  const errors: WalkError[] = [...missing].map(([code, ids]) => ({ code: 'missing_rate', message: `No reference rate for ${code}, so money cannot move between ${[...ids].sort().map((id) => `'${id}'`).join(', ')}`, ids: [...ids].sort() }))
  return { terms, errors }
}

const byLine = (a: LineItem, b: LineItem) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// A cash account ending a walked day below zero, after that day's top-ups.
export interface BelowZero {
  account_id: string
  date: string
}

export type BelowZeroResult = { ok: true; first: BelowZero | null } | WalkFailure

// Per account, 1 on each walked day (index as in Walk.days) that does not count as below zero.
export type DayMask = ReadonlyMap<string, Uint8Array>

interface Stopped {
  ok: true
  stopped: true
  first: BelowZero | null
}

// The day-by-day walk from as_of to the horizon end (spec §6.2, §6.7, §6.8): starts from ledger sums, never walks a past day, and only top-ups read balances.
export function walk(snapshot: Snapshot, options: WalkOptions = {}): WalkResult {
  const result = run(snapshot, options, null)
  if ('stopped' in result) throw new Error('A walk without a stop rule stopped')
  return result
}

// The first day a cash account ends below zero, other than the days `ignore` masks; the walk stops there and keeps no figures or lines (spec §6.8).
export function firstBelowZero(snapshot: Snapshot, options: Omit<WalkOptions, 'mode'> = {}, ignore: DayMask = new Map()): BelowZeroResult {
  const result = run(snapshot, { ...options, mode: 'metrics' }, ignore)
  if (!result.ok) return result
  if (!('stopped' in result)) throw new Error('A walk with a stop rule ran to the end without stopping')
  return { ok: true, first: result.first }
}

function run(snapshot: Snapshot, options: WalkOptions, stop: DayMask | null): WalkResult | Stopped {
  const mode = options.mode ?? 'full'
  const shift = options.fx_shift_pct ?? 0
  if (!(shift > -1 && shift < 1)) throw new RangeError(`fx_shift_pct must be a fraction above −1 and below 1: ${shift}`)
  const index = snapshotIndex(snapshot)
  const asOf = snapshot.as_of
  const accounts = snapshot.doc.accounts
  const funding = fundingOrder(accounts)
  const shapeIssues = [...shapeErrors(snapshot), ...funding.errors]
  if (shapeIssues.length > 0) return Object.freeze({ ok: false, errors: shapeIssues })

  const plan = expandPlan(snapshot)
  const currency = fundingCurrency(snapshot)
  const rates = shiftRates(toRatesPerEur(snapshot.rates), currency, shift)
  const pairs: [Account, Account][] = funding.edges.map((e) => [e.source, e.target])
  for (const a of accounts) {
    const funder = a.funded_from_account_id === null ? undefined : index.accounts.get(a.funded_from_account_id)
    if (a.kind !== 'cash' && funder) pairs.push([funder, a])
  }
  // A weekend roll can carry the horizon's last occurrence past its end, outside the walk; events are in date order, so those are a tail.
  let kept = plan.events.length
  while (kept > 0 && (plan.events[kept - 1] as EngineEvent).date > plan.horizon_end) kept--
  const events = plan.events.slice(0, kept)
  for (const e of events) {
    if (e.kind !== 'transfer' || e.to_account_id === null) continue
    const [from, to] = [index.accounts.get(e.account_id), index.accounts.get(e.to_account_id)]
    if (from && to) pairs.push([from, to])
  }
  const fx = conversions(snapshot, rates, pairs)
  if (fx.errors.length > 0) return Object.freeze({ ok: false, errors: fx.errors })
  const termsOf = (from: Account, to: Account): Terms => {
    const found = fx.terms.get(`${from.id}>${to.id}`)
    if (!found) throw new Error(`No conversion was checked for '${from.id}' to '${to.id}'`)
    return found
  }

  const days = walkedDays(asOf, plan.horizon_end)
  const n = days.length
  const dayAt = new Map<string, number>()
  const months: string[] = []
  const monthStart: number[] = []
  const monthOf = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    const day = days[i] as string
    dayAt.set(day, i)
    const key = day.slice(0, 7)
    if (key !== months[months.length - 1]) {
      months.push(key)
      monthStart.push(i)
    }
    monthOf[i] = months.length - 1
  }
  monthStart.push(n)
  const M = months.length

  const tracks = new Map<string, Track>()
  for (const account of accounts) {
    let start = account.opening_balance_minor
    for (const row of index.rowsByAccount.get(account.id) ?? []) {
      if (row.posted_on > asOf) break
      start += row.amount_minor
    }
    const track: Track = {
      account,
      account_id: account.id,
      start,
      balance: start,
      flow: new Float64Array(n),
      balances: new Float64Array(n),
      topUpInByDay: null,
      inByMonth: new Float64Array(M),
      outByMonth: new Float64Array(M),
      topUpInByMonth: new Float64Array(M),
      topUpOutByMonth: new Float64Array(M),
      floorByMonth: new Float64Array(M),
      targetByMonth: new Float64Array(M),
      floorSet: new Uint8Array(M),
    }
    if (account.kind === 'cash') {
      months.forEach((key, m) => {
        const { floor, target } = floorAndTarget(account.floor_windows, key)
        track.floorByMonth[m] = floor
        track.targetByMonth[m] = target
        track.floorSet[m] = account.floor_windows.some((w) => w.from_month <= key && (w.to_month === null || key <= w.to_month)) ? 1 : 0
      })
    }
    tracks.set(account.id, track)
  }
  const trackOf = (id: string): Track => {
    const found = tracks.get(id)
    if (!found) throw new RangeError(`No account '${id}' in the snapshot`)
    return found
  }
  // A debt event dated before as_of is part of a card's replay and moves the walk's balance on as_of.
  const dayOf = (day: string): number => {
    if (day < asOf) return 0
    const i = dayAt.get(day)
    if (i === undefined) throw new RangeError(`${day} is after the walk, which ends ${plan.horizon_end}`)
    return i
  }
  const post = (t: Track, i: number, amount: number) => {
    t.flow[i] = (t.flow[i] ?? 0) + amount
    const m = monthOf[i] ?? 0
    if (amount > 0) t.inByMonth[m] = (t.inByMonth[m] ?? 0) + amount
    else t.outByMonth[m] = (t.outByMonth[m] ?? 0) - amount
  }

  const full = mode === 'full'
  const lines: LineItem[] = []
  const estimated = (occurrenceId: string) => index.planItems.get(plan.byId.get(occurrenceId)?.plan_item_id ?? '')?.confidence === 'estimated'
  const flagsOf = (e: EngineEvent): readonly LineFlag[] => {
    const late = e.overdue
    const chip = e.occurrence_ids.some(estimated)
    return late && chip ? Object.freeze(['overdue', 'estimated']) : late ? OVERDUE : chip ? Object.freeze(['estimated']) : NONE
  }
  const eventLine = (e: EngineEvent, id: string, accountId: string, amount: number, date: string, pairId: string | null): LineItem => ({
    id,
    source: e.row_id === null ? 'plan' : 'row',
    kind: e.kind,
    order: e.order,
    account_id: accountId,
    amount_minor: amount,
    date,
    until: e.kind === 'allowance' ? e.until : date,
    state: e.row_id === null ? (plan.byId.get(e.occurrence_ids[0] ?? '')?.state ?? null) : null,
    flags: flagsOf(e),
    occurrence_ids: e.occurrence_ids,
    row_id: e.row_id,
    pair_id: pairId,
  })

  const debtEvents: Record<'credit_card' | 'loan', EngineEvent[]> = { credit_card: [], loan: [] }
  for (const e of events) {
    const t = trackOf(e.account_id)
    const i = dayOf(e.date)
    const date = days[i] ?? asOf
    if (e.kind === 'allowance') {
      // Every share has the allowance's sign and falls in its month, so the month total moves once.
      addShares(e, t.flow, i)
      const m = monthOf[i] ?? 0
      if (e.amount_minor > 0) t.inByMonth[m] = (t.inByMonth[m] ?? 0) + e.amount_minor
      else t.outByMonth[m] = (t.outByMonth[m] ?? 0) - e.amount_minor
      if (full) lines.push(eventLine(e, e.id, t.account_id, e.amount_minor, date, null))
    } else if (e.kind === 'transfer' && e.to_account_id !== null) {
      // Gross leaves and net lands the same day, converted at the source's fee.
      const to = trackOf(e.to_account_id)
      const { rate, feePct } = termsOf(t.account, to.account)
      const gross = -e.amount_minor
      const net = netOf(gross, rate, feePct)
      post(t, i, -gross)
      post(to, i, net)
      if (full) lines.push(eventLine(e, `${e.id}#out`, t.account_id, -gross, date, `${e.id}#in`), eventLine(e, `${e.id}#in`, to.account_id, net, date, `${e.id}#out`))
    } else {
      post(t, i, e.amount_minor)
      if (full) lines.push(eventLine(e, e.id, t.account_id, e.amount_minor, date, null))
    }
    if (t.account.kind !== 'cash') debtEvents[t.account.kind].push(e)
  }

  const moveLine = (move: DebtMove, source: LineSource, id: string, accountId: string, amount: number, pairId: string | null): LineItem => ({
    id,
    source,
    kind: move.kind,
    order: move.order,
    account_id: accountId,
    amount_minor: amount,
    date: move.date,
    until: move.date,
    state: null,
    flags: move.overdue ? OVERDUE : NONE,
    occurrence_ids: move.occurrence_ids,
    row_id: null,
    pair_id: pairId,
  })
  const conversion = (debtId: string): Terms => {
    const debt = trackOf(debtId).account
    const funder = debt.funded_from_account_id === null ? undefined : index.accounts.get(debt.funded_from_account_id)
    return funder ? termsOf(funder, debt) : { rate: 1, feePct: 0 }
  }
  const landed = (debtId: string, amount: number): number => {
    const { rate, feePct } = conversion(debtId)
    return netOf(grossFor(amount, rate, feePct), rate, feePct)
  }
  const callDebts = <K extends 'credit_card' | 'loan'>(module: DebtModule<K>, kind: K, offers: readonly ExtraOffer[]): DebtOutput => {
    const own = accounts.filter((a) => a.kind === kind)
    const ids = new Set(own.map((a) => a.id))
    return module.walk({ snapshot, plan, days, accounts: own, events: debtEvents[kind], landed, conversion, offers: offers.filter((o) => ids.has(o.account_id)) })
  }
  const postDebts = (out: DebtOutput, kind: 'credit_card' | 'loan', source: LineSource): unknown => {
    for (const move of out.moves) {
      const debt = tracks.get(move.account_id)
      const i = dayAt.get(move.date)
      if (!debt || debt.account.kind !== kind) throw new Error(`The ${source} module moved '${move.account_id}', which is not one of its debts`)
      if (i === undefined) throw new Error(`The ${source} module dated '${move.id}' ${move.date}, outside the walk`)
      if (move.from_account_id === null) {
        post(debt, i, move.amount_minor)
        if (full) lines.push(moveLine(move, source, move.id, debt.account_id, move.amount_minor, null))
        continue
      }
      if (move.from_account_id !== debt.account.funded_from_account_id || move.amount_minor <= 0) {
        throw new Error(`The ${source} module's payment '${move.id}' must be positive and leave '${debt.account.funded_from_account_id}'`)
      }
      const cash = trackOf(move.from_account_id)
      const { rate, feePct } = termsOf(cash.account, debt.account)
      const gross = grossFor(move.amount_minor, rate, feePct)
      const net = netOf(gross, rate, feePct)
      post(cash, i, -gross)
      post(debt, i, net)
      if (full) lines.push(moveLine(move, source, `${move.id}#out`, cash.account_id, -gross, `${move.id}#in`), moveLine(move, source, `${move.id}#in`, debt.account_id, net, `${move.id}#out`))
    }
    return out.summary
  }
  // Extra crosses from cards to loans and back until neither passes anything new; each pass settles at least one more debt down a payoff order.
  const cardsModule = options.cards ?? NO_CARDS
  const loansModule = options.loans ?? NO_LOANS
  let toCards: readonly ExtraOffer[] = []
  let cardOut = callDebts(cardsModule, 'credit_card', toCards)
  let loanOut = callDebts(loansModule, 'loan', cardOut.overflow ?? [])
  for (let pass = 0; ; pass++) {
    const back = loanOut.overflow ?? []
    if (JSON.stringify(back) === JSON.stringify(toCards)) break
    if (pass > accounts.length) throw new Error('Extra for debts kept moving between the card and loan modules')
    toCards = back
    cardOut = callDebts(cardsModule, 'credit_card', toCards)
    loanOut = callDebts(loansModule, 'loan', cardOut.overflow ?? [])
  }
  const cards = postDebts(cardOut, 'credit_card', 'card')
  const loans = postDebts(loanOut, 'loan', 'loan')

  // ahead[i]: the lowest the target's known flows take it from day i to month end, relative to day i.
  const edges = funding.edges.map(({ source, target }) => {
    const t = trackOf(target.id)
    const ahead = new Float64Array(n)
    const sums = new Float64Array(n)
    let run = 0
    for (let i = 0; i < n; i++) sums[i] = run += t.flow[i] ?? 0
    for (let m = 0; m < M; m++) {
      let low = Infinity
      for (let i = (monthStart[m + 1] ?? n) - 1; i >= (monthStart[m] ?? 0); i--) {
        low = Math.min(low, sums[i] ?? 0)
        ahead[i] = low - (sums[i] ?? 0)
      }
    }
    t.topUpInByDay = new Float64Array(n)
    return { source: trackOf(source.id), target: t, ahead, ...termsOf(source, target) }
  })

  const all = [...tracks.values()]
  const cash = all.filter((t) => t.account.kind === 'cash')
  for (let i = 0; i < n; i++) {
    const m = monthOf[i] ?? 0
    for (let a = 0; a < all.length; a++) {
      const t = all[a] as Track
      t.balance += t.flow[i] ?? 0
    }
    for (let k = 0; k < edges.length; k++) {
      const { source, target, ahead, rate, feePct } = edges[k] as (typeof edges)[number]
      const floor = target.floorByMonth[m] ?? 0
      if (target.balance >= floor) continue
      // What it needs to stay at its floor through month end, against what the source holds above its own floor at the end of this day.
      const sized = sizeTopUp(floor - target.balance - (ahead[i] ?? 0), source.balance - (source.floorByMonth[m] ?? 0), rate, feePct)
      if (!sized) continue
      source.balance -= sized.gross
      target.balance += sized.net
      source.topUpOutByMonth[m] = (source.topUpOutByMonth[m] ?? 0) + sized.gross
      target.topUpInByMonth[m] = (target.topUpInByMonth[m] ?? 0) + sized.net
      if (target.topUpInByDay) target.topUpInByDay[i] = (target.topUpInByDay[i] ?? 0) + sized.net
      if (full) {
        const [day, id] = [days[i] ?? asOf, `top-up:${source.account_id}>${target.account_id}:${days[i]}`]
        const flags = m === 0 ? TO_SEND : NONE
        const leg = (suffix: string, accountId: string, amount: number, pair: string): LineItem => ({
          id: `${id}#${suffix}`,
          source: 'top_up',
          kind: 'top_up',
          order: ORDER.top_up,
          account_id: accountId,
          amount_minor: amount,
          date: day,
          until: day,
          state: null,
          flags,
          occurrence_ids: [],
          row_id: null,
          pair_id: `${id}#${pair}`,
        })
        lines.push(leg('out', source.account_id, -sized.gross, 'in'), leg('in', target.account_id, sized.net, 'out'))
      }
    }
    for (let a = 0; a < all.length; a++) {
      const t = all[a] as Track
      t.balances[i] = t.balance
    }
    if (stop === null) continue
    for (let a = 0; a < cash.length; a++) {
      const t = cash[a] as Track
      if (t.balance < 0 && stop.get(t.account_id)?.[i] !== 1) return { ok: true, stopped: true, first: { account_id: t.account_id, date: days[i] ?? asOf } }
    }
  }
  if (stop !== null) return { ok: true, stopped: true, first: null }

  const figures = new Map<string, readonly MonthFigures[]>()
  for (const t of all) if (t.account.kind === 'cash') figures.set(t.account_id, Object.freeze(rollUp(t, days, months, monthStart).map((f) => Object.freeze(f))))
  lines.sort(byLine)
  for (const line of lines) Object.freeze(line)
  return Object.freeze({
    ok: true,
    as_of: asOf,
    horizon_end: plan.horizon_end,
    mode,
    funding_currency: currency,
    fx_shift_pct: shift,
    rates: Object.freeze({ ...rates }),
    days: Object.freeze(days),
    months: Object.freeze(months),
    start: new Map(all.map((t) => [t.account_id, t.start])),
    balances: new Map(all.map((t) => [t.account_id, t.balances])),
    figures,
    lines: Object.freeze(lines),
    cards,
    loans,
  })
}
