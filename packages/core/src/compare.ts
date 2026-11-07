import type { CardPayer } from './engine/cards'
import type { LoanModule } from './engine/debts'
import { fxBreakeven, yieldToScreen } from './engine/fx-breakeven'
import { fundingCurrency } from './engine/fx'
import { walkMetrics, type WalkMetrics } from './engine/metrics'
import { walk } from './engine/walk'
import { applyPatch, combinePatches, type PatchedWorld } from './levers'
import { approxTotal, type Total } from './money'
import type { Patch } from './schema/patch'
import { snapshotIndex, type Snapshot } from './snapshot'

// The levers Compare offers, each lever's patch and words, and the link that carries them.
export * from './compare-levers'

export type RowRole = 'baseline' | 'lever' | 'together'

export interface LowestBalance {
  account_id: string
  currency: string
  // The lowest end-of-day balance from today to the horizon end, and its first day.
  lowest_minor: number
  lowest_on: string
  delta_minor: number
}

export interface DebtInterestRow {
  account_id: string
  currency: string
  // Charged from today to the horizon end, plus a loan's interest after it to its payoff.
  interest_minor: number
  delta_minor: number
}

// Which figures differ from the baseline, so a phone card lists only those.
export interface Moved {
  net_worth: boolean
  lowest: boolean
  days_under_floor: boolean
  months_under_target: boolean
  fx_margin: boolean
  debt_free_month: boolean
  interest: boolean
}

// One option measured on the same snapshot as the baseline (spec §6.8); every delta is this row minus the baseline.
export interface CompareRow {
  ok: true
  label: string
  role: RowRole
  patch: Patch
  // Cash minus total debt at the horizon end in the base currency, at the walk's rates; null when a rate is missing.
  net_worth: Total | null
  delta_net_worth: Total | null
  // Cash accounts by sort order.
  lowest_by_account: readonly LowestBalance[]
  // Summed over cash accounts: days ending below the floor, and months with a day below the target.
  days_under_floor: number
  delta_days_under_floor: number
  months_under_target: number
  delta_months_under_target: number
  // How far the funding currency can weaken from this world's rate before a day ends below zero; null in one currency.
  fx_margin: number | null
  delta_fx_margin: number | null
  debt_free_month: string | null
  debt_free_after_horizon: boolean
  // Months earlier (negative) or later than the baseline; null while either month is not known.
  delta_debt_free_months: number | null
  interest: readonly DebtInterestRow[]
  // Every debt's interest in the base currency at today's rates, so only a change in interest moves it; null when a rate is missing.
  interest_total: Total | null
  delta_interest_total: Total | null
  moved: Moved
  // Walks this row took, the FX breakeven's included.
  walks: number
}

export interface CompareFailure {
  ok: false
  label: string
  role: RowRole
  errors: readonly string[]
}

export type CompareResult = CompareRow | CompareFailure

export interface CompareLever {
  label: string
  // Any form parsePatch reads; Compare checks it as applyPatch does.
  patch: unknown
}

export interface CompareOptions {
  payer?: CardPayer
  loans?: LoanModule
  // Hands the thread back to the screen before every walk; one setTimeout(0) by default.
  pause?: () => Promise<void>
}

export const BASELINE_LABEL = 'Baseline'
export const TOGETHER_LABEL = 'All together'

interface Measured {
  world: PatchedWorld
  metrics: WalkMetrics
  months_under_target: number
  fx_margin: number | null
  walks: number
}

const monthIndex = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1

// The breakeven multiplier is against today's rate; a world already shifted by s starts at 1 + s, so its margin is measured from there.
const marginFrom = (margin: number, multiplier: number, shift: number) => (shift === 0 ? margin : Math.round((1 - multiplier / (1 + shift)) * 1000) / 1000)

async function measure(snapshot: Snapshot, patch: unknown, options: CompareOptions, pause: () => Promise<void>): Promise<Measured | string[]> {
  await pause()
  const applied = applyPatch(snapshot, patch, { ...(options.payer ? { payer: options.payer } : {}), ...(options.loans ? { loans: options.loans } : {}) })
  if (!applied.ok) return applied.errors
  const world = applied.value
  const walked = walk(world.snapshot, { ...world.options, mode: 'metrics' })
  if (!walked.ok) return walked.errors.map((e) => e.message)
  const metrics = walkMetrics(world.snapshot, walked)
  let months = 0
  for (const figures of walked.figures.values()) for (const f of figures) if (f.days_under_target > 0) months++
  let [fx_margin, walks] = [null as number | null, 1]
  if (fundingCurrency(world.snapshot) !== null) {
    await pause()
    const found = await fxBreakeven(world.snapshot, { cards: world.options.cards, loans: world.options.loans, pause })
    if (found !== null && !found.ok) return found.errors.map((e) => e.message)
    if (found !== null) [fx_margin, walks] = [marginFrom(found.margin, found.multiplier, world.options.fx_shift_pct), 1 + found.walks]
  }
  return { world, metrics, months_under_target: months, fx_margin, walks }
}

function minus(a: Total | null, b: Total | null): Total | null {
  if (a === null || b === null) return null
  const minor = a.minor - b.minor
  const days = [a, b].flatMap((t) => (t.approx ? [t.day] : [])).sort()
  const day = days[0]
  return day === undefined ? { minor, currency: a.currency, approx: false } : { minor, currency: a.currency, approx: true, day }
}

const sameTotal = (a: Total | null, b: Total | null) => (a === null || b === null ? a === b : a.minor === b.minor)

function rowOf(snapshot: Snapshot, label: string, role: RowRole, m: Measured, base: CompareRow | null): CompareRow {
  const { metrics } = m
  const index = snapshotIndex(snapshot)
  const order = (id: string) => index.accounts.get(id)?.sort_order ?? 0
  const cash = [...metrics.cash].sort((a, b) => order(a.account_id) - order(b.account_id) || (a.account_id < b.account_id ? -1 : 1))
  const lowest_by_account = cash.map((c) => {
    const before = base?.lowest_by_account.find((l) => l.account_id === c.account_id)
    return Object.freeze({ account_id: c.account_id, currency: c.currency, lowest_minor: c.lowest_minor, lowest_on: c.lowest_on, delta_minor: before ? c.lowest_minor - before.lowest_minor : 0 })
  })
  const interest = metrics.interest.map((d) => {
    const minor = d.interest_to_horizon_minor + d.interest_after_horizon_minor
    const before = base?.interest.find((i) => i.account_id === d.account_id)
    return Object.freeze({ account_id: d.account_id, currency: d.currency, interest_minor: minor, delta_minor: before ? minor - before.interest_minor : 0 })
  })
  const net_worth = metrics.net_worth_at_horizon.total
  const interest_total = approxTotal(
    interest.map((i) => ({ minor: i.interest_minor, currency: i.currency })),
    snapshot.doc.household.base_currency,
    snapshot.rates,
  )
  const days_under_floor = cash.reduce((sum, c) => sum + c.days_under_floor, 0)
  const { month, after_horizon } = metrics.debt_free
  const ref = base ?? { net_worth, interest_total, days_under_floor, months_under_target: m.months_under_target, fx_margin: m.fx_margin, debt_free_month: month, debt_free_after_horizon: after_horizon }
  const delta_fx_margin = m.fx_margin === null || ref.fx_margin === null ? null : Math.round((m.fx_margin - ref.fx_margin) * 1000) / 1000
  return Object.freeze({
    ok: true as const,
    label,
    role,
    patch: m.world.patch,
    net_worth,
    delta_net_worth: minus(net_worth, ref.net_worth),
    lowest_by_account: Object.freeze(lowest_by_account),
    days_under_floor,
    delta_days_under_floor: days_under_floor - ref.days_under_floor,
    months_under_target: m.months_under_target,
    delta_months_under_target: m.months_under_target - ref.months_under_target,
    fx_margin: m.fx_margin,
    delta_fx_margin,
    debt_free_month: month,
    debt_free_after_horizon: after_horizon,
    delta_debt_free_months: month === null || ref.debt_free_month === null ? null : monthIndex(month) - monthIndex(ref.debt_free_month),
    interest: Object.freeze(interest),
    interest_total,
    delta_interest_total: minus(interest_total, ref.interest_total),
    moved: Object.freeze({
      net_worth: !sameTotal(net_worth, ref.net_worth),
      lowest: lowest_by_account.some((l) => l.delta_minor !== 0),
      days_under_floor: days_under_floor !== ref.days_under_floor,
      months_under_target: m.months_under_target !== ref.months_under_target,
      fx_margin: m.fx_margin !== ref.fx_margin,
      debt_free_month: month !== ref.debt_free_month || after_horizon !== ref.debt_free_after_horizon,
      interest: interest.some((i) => i.delta_minor !== 0),
    }),
    walks: m.walks,
  })
}

const failure = (label: string, role: RowRole, errors: readonly string[]): CompareFailure => Object.freeze({ ok: false as const, label, role, errors: Object.freeze([...errors]) })

// Walks the baseline, each lever and all of them together on one snapshot, yielding to the screen before every walk and handing over each row as it finishes (spec §6.8): a package is measured as one patch, never as the sum of its parts.
export async function* compare(snapshot: Snapshot, levers: readonly CompareLever[], options: CompareOptions = {}): AsyncGenerator<CompareResult, void, undefined> {
  const pause = options.pause ?? yieldToScreen
  const run = async (label: string, role: RowRole, patch: unknown, base: CompareRow | null): Promise<CompareResult> => {
    const measured = await measure(snapshot, patch, options, pause)
    return Array.isArray(measured) ? failure(label, role, measured) : rowOf(snapshot, label, role, measured, base)
  }
  const base = await run(BASELINE_LABEL, 'baseline', {}, null)
  yield base
  if (!base.ok) return
  for (const lever of levers) yield await run(lever.label, 'lever', lever.patch, base)
  if (levers.length < 2) return
  const together = combinePatches(levers.map((l) => l.patch))
  yield together.ok ? await run(TOGETHER_LABEL, 'together', together.value, base) : failure(TOGETHER_LABEL, 'together', together.errors)
}

export type SortMetric = 'net_worth' | 'lowest' | 'days_under_floor' | 'months_under_target' | 'fx_margin' | 'debt_free_month' | 'interest'

// Best first; null when the row has no figure for the metric.
function score(row: CompareRow, metric: SortMetric, accountId: string | undefined): number | null {
  switch (metric) {
    case 'net_worth':
      return row.net_worth?.minor ?? null
    case 'lowest': {
      const found = accountId === undefined ? row.lowest_by_account[0] : row.lowest_by_account.find((l) => l.account_id === accountId)
      return found?.lowest_minor ?? null
    }
    case 'days_under_floor':
      return -row.days_under_floor
    case 'months_under_target':
      return -row.months_under_target
    case 'fx_margin':
      return row.fx_margin
    case 'debt_free_month':
      return row.debt_free_month === null ? null : -monthIndex(row.debt_free_month)
    case 'interest':
      return row.interest_total === null ? null : -row.interest_total.minor
  }
}

// Compare's phone cards: the baseline first, then the options best first by the picked metric (change in net worth by default), ties in their order, rows without the figure and failures last. `accountId` picks the account for 'lowest', the first by sort order otherwise.
export function sortRows(rows: readonly CompareResult[], metric: SortMetric = 'net_worth', accountId?: string): CompareResult[] {
  const baseline = rows.filter((r) => r.role === 'baseline')
  const options = rows.filter((r) => r.role !== 'baseline')
  const ranked = options.map((row, i) => ({ row, i, value: row.ok ? score(row, metric, accountId) : null, failed: !row.ok }))
  ranked.sort((a, b) => Number(a.failed) - Number(b.failed) || (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) || (b.value ?? 0) - (a.value ?? 0) || a.i - b.i)
  return [...baseline, ...ranked.map((r) => r.row)]
}
