import { toRatesPerEur } from '../rates'
import type { Snapshot } from '../snapshot'
import { CARDS } from './cards'
import type { CardModule, LoanModule } from './debts'
import { fundingCurrency } from './fx'
import { LOANS } from './loans'
import type { WalkFailure } from './types'
import { firstBelowZero, walk, type BelowZero } from './walk'

declare function setTimeout(callback: () => void, ms: number): unknown

// The multiplier m on the funding currency's value is searched on a grid of thousandths from 0.5 to 1.5 (spec §6.8).
export const BREAKEVEN_LOWEST = 500
export const BREAKEVEN_HIGHEST = 1500
export const BREAKEVEN_MAX_WALKS = 14

// A cash account below zero even at m = 1.5: no rate fixes it, so it is its own alert and the search ignores those days.
export interface RateIndependent {
  account_id: string
  // The first such day, and how many walked days end below zero at m = 1.5.
  date: string
  days: number
}

export interface BreakevenRate {
  // Units of this currency per unit of the funding currency, today and at the breakeven.
  currency: string
  today: number
  breakeven: number
}

export interface FxBreakeven {
  ok: true
  funding_currency: string
  // The lowest m at which no cash account ends a day below zero, rate-independent days aside, to 0.001.
  multiplier: number
  // 1 − m: how far the funding currency can weaken before a day ends below zero.
  margin: number
  // m = 0.5 already passes, so the breakeven is 0.5 or lower.
  below_range: boolean
  rates: readonly BreakevenRate[]
  // The first failing day at the highest m that still fails: the constraint that sets the breakeven; null when 0.5 passes.
  binding: BelowZero | null
  rate_independent: readonly RateIndependent[]
  walks: number
}

export interface BreakevenOptions {
  cards?: CardModule
  loans?: LoanModule
  // Hands the thread back to the screen between walks.
  pause?: () => Promise<void>
}

// Hands the thread back to the screen for one macrotask, so a run of walks never freezes it.
export const yieldToScreen = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

const shiftOf = (k: number) => (k - 1000) / 1000

// FX breakeven by bisection: one full walk at m = 1.5 finds the rate-independent days, then at most 13 metrics walks each stop at their first new failing day. Null in a one-currency household.
export async function fxBreakeven(snapshot: Snapshot, options: BreakevenOptions = {}): Promise<FxBreakeven | WalkFailure | null> {
  const funding = fundingCurrency(snapshot)
  if (funding === null) return null
  const modules = { cards: options.cards ?? CARDS, loans: options.loans ?? LOANS }
  const pause = options.pause ?? yieldToScreen

  const top = walk(snapshot, { ...modules, mode: 'metrics', fx_shift_pct: shiftOf(BREAKEVEN_HIGHEST) })
  if (!top.ok) return top
  let walks = 1
  const ignore = new Map<string, Uint8Array>()
  const independent: RateIndependent[] = []
  for (const account of snapshot.doc.accounts) {
    const balances = top.balances.get(account.id)
    if (account.kind !== 'cash' || !balances) continue
    const mask = new Uint8Array(balances.length)
    let [first, days] = [-1, 0]
    balances.forEach((b, i) => {
      if (b >= 0) return
      mask[i] = 1
      days++
      if (first < 0) first = i
    })
    if (days === 0) continue
    ignore.set(account.id, mask)
    independent.push({ account_id: account.id, date: top.days[first] ?? top.as_of, days })
  }
  independent.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.account_id < b.account_id ? -1 : 1))

  const failsAt = async (k: number): Promise<BelowZero | null | WalkFailure> => {
    if (walks >= BREAKEVEN_MAX_WALKS) throw new Error(`The breakeven search needs more than ${BREAKEVEN_MAX_WALKS} walks`)
    await pause()
    walks++
    const result = firstBelowZero(snapshot, { ...modules, fx_shift_pct: shiftOf(k) }, ignore)
    return result.ok ? result.first : result
  }
  // hi always passes (m = 1.5 has no new failing day by construction); lo fails until 0.5 is shown to pass.
  let [lo, hi] = [BREAKEVEN_LOWEST, BREAKEVEN_HIGHEST]
  let binding = await failsAt(lo)
  if (binding !== null && 'ok' in binding) return binding
  if (binding === null) hi = lo
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    const found = await failsAt(mid)
    if (found !== null && 'ok' in found) return found
    if (found === null) hi = mid
    else [lo, binding] = [mid, found]
  }

  const perEur = toRatesPerEur(snapshot.rates)
  const fundingPerEur = funding === 'EUR' ? 1 : perEur[funding]
  const currencies = [...new Set(snapshot.doc.accounts.map((a) => a.currency))].filter((c) => c !== funding).sort()
  const rates: BreakevenRate[] = []
  for (const currency of currencies) {
    const quote = currency === 'EUR' ? 1 : perEur[currency]
    if (quote === undefined || fundingPerEur === undefined) continue
    const today = quote / fundingPerEur
    rates.push(Object.freeze({ currency, today: Number(today.toPrecision(12)), breakeven: Number(((today * hi) / 1000).toPrecision(12)) }))
  }
  return Object.freeze({
    ok: true as const,
    funding_currency: funding,
    multiplier: hi / 1000,
    margin: (1000 - hi) / 1000,
    below_range: hi === BREAKEVEN_LOWEST,
    rates: Object.freeze(rates),
    binding,
    rate_independent: Object.freeze(independent.map((r) => Object.freeze(r))),
    walks,
  })
}
