import { afterEach, describe, expect, it, vi } from 'vitest'
import { abroad, usCardsCar, type Sample } from '../fixtures'
import { BASELINE_LABEL, compare, sortRows, TOGETHER_LABEL, type CompareLever, type CompareOptions, type CompareResult, type CompareRow } from '../src/compare'
import { amountLever, dayLever, extraPaymentLever, fxShiftLever, loanOfferLever, removeLever } from '../src/compare-levers'
import { walkMetrics, type WalkMetrics } from '../src/engine/metrics'
import { applyPatch, combinePatches, type Lever } from '../src/levers'
import { buildSnapshot, type Snapshot } from '../src/snapshot'
import { walked } from './walk-helpers'

const AS_OF = '2026-10-07'
const NO_PAUSE: CompareOptions = { pause: async () => {} }

afterEach(() => {
  vi.useRealTimers()
})

function build(sample: (asOf: string) => Sample): Snapshot {
  const { doc, rates } = sample(AS_OF)
  return buildSnapshot(doc, AS_OF, rates)
}

async function rowsOf(snapshot: Snapshot, levers: readonly CompareLever[], options: CompareOptions = NO_PAUSE): Promise<CompareResult[]> {
  const out: CompareResult[] = []
  for await (const row of compare(snapshot, levers, options)) out.push(row)
  return out
}

function ok(row: CompareResult | undefined): CompareRow {
  if (!row?.ok) throw new Error(`Row failed: ${row ? row.errors.join('; ') : 'missing'}`)
  return row
}

// The same figures measured apart from compare: one metrics walk of the world the patch describes.
function direct(snapshot: Snapshot, patch: unknown): { start: ReadonlyMap<string, number>; metrics: WalkMetrics } {
  const applied = applyPatch(snapshot, patch)
  if (!applied.ok) throw new Error(applied.errors.join('; '))
  const w = walked(applied.value.snapshot, { ...applied.value.options, mode: 'metrics' })
  return { start: w.start, metrics: walkMetrics(applied.value.snapshot, w) }
}

const abroadLevers = (snapshot: Snapshot): Lever[] => [amountLever(snapshot, 'rent', 95000, '2026-10'), dayLever(snapshot, 'salary', 20, '2026-10'), fxShiftLever(snapshot, -0.1), removeLever(snapshot, 'mobile')]

const usLevers = (snapshot: Snapshot): Lever[] => [
  loanOfferLever(snapshot, { amount_minor: 400000, term_months: 12, monthly_rate: 0.01, draw_month: '2026-11', draw_day: 10, to_account_id: 'store-card', card_id: 'travel-card' }),
  extraPaymentLever(snapshot, { amount_minor: 20000, every: 'month', starts_on: '2026-11-01', from_account_id: 'checking' }),
]

describe('compare', () => {
  it('measures each lever from two walks of the same snapshot, with and without it, and never moves posted cash', async () => {
    const snapshot = build(abroad)
    const levers = abroadLevers(snapshot)
    const rows = await rowsOf(snapshot, levers)
    expect(rows.map((r) => [r.label, r.role, r.ok])).toEqual([
      [BASELINE_LABEL, 'baseline', true],
      ['Rent: €950.00 from Oct 2026', 'lever', true],
      ['Salary: day 20 from Oct 2026', 'lever', true],
      ['EUR 10% weaker', 'lever', true],
      ['Remove Mobile plan', 'lever', true],
      [TOGETHER_LABEL, 'together', true],
    ])
    const base = direct(snapshot, {})
    const baseRow = ok(rows[0])
    expect([Object.values(baseRow.moved).some(Boolean), baseRow.delta_net_worth?.minor, baseRow.delta_days_under_floor, baseRow.fx_margin, baseRow.walks]).toEqual([false, 0, 0, 0.311, 13])
    levers.forEach((lever, i) => {
      const row = ok(rows[i + 1])
      const { start, metrics } = direct(snapshot, lever.patch)
      // The ledger up to today is the same in both worlds: a lever only changes what the plan still expects.
      expect(start).toEqual(base.start)
      expect([row.label, row.delta_net_worth?.minor]).toEqual([lever.label, (metrics.net_worth_at_horizon.total?.minor ?? NaN) - (base.metrics.net_worth_at_horizon.total?.minor ?? NaN)])
      expect(row.lowest_by_account.map((l) => [l.account_id, l.lowest_minor, l.delta_minor])).toEqual(
        ['main', 'tax', 'pesos'].map((id) => {
          const [after, before] = [metrics.cash.find((c) => c.account_id === id)?.lowest_minor ?? NaN, base.metrics.cash.find((c) => c.account_id === id)?.lowest_minor ?? NaN]
          return [id, after, after - before]
        }),
      )
      expect(row.delta_days_under_floor).toBe(metrics.cash.reduce((s, c) => s + c.days_under_floor, 0) - base.metrics.cash.reduce((s, c) => s + c.days_under_floor, 0))
    })
    const figures = rows.map((r) => {
      const row = ok(r)
      return [row.delta_net_worth?.minor, row.delta_days_under_floor, row.fx_margin, row.delta_fx_margin, row.months_under_target, row.debt_free_month]
    })
    expect(figures.slice(0, 5)).toEqual([
      [0, 0, 0.311, 0, 2, '2027-11'],
      [-305000, 0, 0.204, -0.107, 2, '2027-11'],
      [0, -16, 0.37, 0.059, 2, '2027-11'],
      // The shift itself is the world's rate now, so the margin left is measured from 0.9: 1 − 0.689 ÷ 0.9.
      [-73841, 0, 0.234, -0.077, 2, '2027-11'],
      [105308, 0, 0.358, 0.047, 2, '2027-11'],
    ])
    expect(ok(rows[4]).moved).toEqual({ net_worth: true, lowest: true, days_under_floor: false, months_under_target: false, fx_margin: true, debt_free_month: false, interest: false })
  })

  it('measures all together as one patch, not as the sum of its parts', async () => {
    const snapshot = build(usCardsCar)
    const levers = usLevers(snapshot)
    const rows = await rowsOf(snapshot, levers)
    const [, offer, extra, together] = rows.map(ok)
    if (!offer || !extra || !together) throw new Error('Missing rows')
    const combined = combinePatches(levers.map((l) => l.patch))
    expect([together.label, together.role, combined.ok && together.patch]).toEqual([TOGETHER_LABEL, 'together', combined.ok ? combined.value : null])
    const { metrics } = direct(snapshot, combined.ok ? combined.value : {})
    const baseTotal = direct(snapshot, {}).metrics.net_worth_at_horizon.total?.minor ?? NaN
    expect(together.delta_net_worth?.minor).toBe((metrics.net_worth_at_horizon.total?.minor ?? NaN) - baseTotal)
    // The loan offer's installments run while extra for debts pays the cards down, so the package is worth less than its parts added up.
    expect([offer.delta_net_worth?.minor, extra.delta_net_worth?.minor, together.delta_net_worth?.minor]).toEqual([-32827, 82778, 67369])
    expect([offer.delta_debt_free_months, extra.delta_debt_free_months, together.delta_debt_free_months, together.debt_free_month]).toEqual([0, -9, -9, '2029-04'])
    expect(together.interest.map((i) => [i.account_id, i.interest_minor, i.delta_minor])).toEqual([
      ['car-loan', 194465, -51488],
      ['store-card', 16843, -78191],
      ['travel-card', 31511, 14314],
    ])
    expect([offer.interest_total, together.delta_interest_total]).toEqual([
      { minor: 343015, currency: 'USD', approx: false },
      { minor: -115365, currency: 'USD', approx: false },
    ])
    // One currency: no FX margin, and the cash figures carry through.
    expect([together.fx_margin, together.delta_fx_margin, together.days_under_floor, together.months_under_target, together.lowest_by_account.map((l) => l.account_id)]).toEqual([null, null, 0, 0, ['checking', 'savings']])
  })

  it('yields to the screen with setTimeout(0) before every walk and hands over each row as soon as it finishes', async () => {
    // A real macrotask lets the generator run on to its next yield; the fake clock decides when each yield ends.
    const realTimeout = (globalThis as unknown as { setTimeout: (callback: () => void, ms: number) => unknown }).setTimeout
    const settle = () => new Promise<void>((resolve) => realTimeout(resolve, 0))
    vi.useFakeTimers()
    const snapshot = build(abroad)
    const levers = abroadLevers(snapshot).slice(0, 2)
    const rows: CompareResult[] = []
    const run = (async () => {
      for await (const row of compare(snapshot, levers)) rows.push(row)
    })()
    // The generator stops at its first yield before any walk.
    expect([rows.length, vi.getTimerCount()]).toEqual([0, 1])
    const seen: number[] = []
    while (vi.getTimerCount() > 0) {
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersToNextTimer()
      await settle()
      seen.push(rows.length)
    }
    await run
    const walks = rows.map((r) => ok(r).walks)
    expect([rows.map((r) => r.label), walks]).toEqual([[BASELINE_LABEL, levers[0]?.label, levers[1]?.label, TOGETHER_LABEL], [13, 13, 13, 13]])
    // One timer per walk, and each row arrives with the timer that ran its last walk, before the next walk starts.
    const ends = walks.map((_, i) => walks.slice(0, i + 1).reduce((a, b) => a + b, 0))
    expect(seen).toEqual(Array.from({ length: ends.at(-1) ?? 0 }, (_, i) => ends.filter((end) => end <= i + 1).length))
  })

  it('reports a lever that does not apply as a failed row, measures the rest, and fails all together', async () => {
    const snapshot = build(abroad)
    const rows = await rowsOf(snapshot, [{ label: 'Typo', patch: { fx_rate: 0.9 } }, { label: 'Rent', patch: amountLever(snapshot, 'rent', 95000, '2026-11').patch }])
    expect(rows.map((r) => (r.ok ? [r.label, r.ok] : [r.label, r.ok, r.errors]))).toEqual([
      [BASELINE_LABEL, true],
      ['Typo', false, ["(root): Unknown key 'fx_rate'; allowed keys: fx_shift_pct, items, add, accounts, income_gap"]],
      ['Rent', true],
      [TOGETHER_LABEL, false, ["levers[0]: (root): Unknown key 'fx_rate'; allowed keys: fx_shift_pct, items, add, accounts, income_gap"]],
    ])
  })

  it('sorts the phone cards by the picked metric, the baseline first and failed rows last', async () => {
    const snapshot = build(abroad)
    const rows = [...(await rowsOf(snapshot, abroadLevers(snapshot))), { ok: false as const, label: 'Broken', role: 'lever' as const, errors: ['bad'] }]
    const order = (metric?: Parameters<typeof sortRows>[1], accountId?: string) => sortRows(rows, metric, accountId).map((r) => r.label)
    const [base, rent, salary, fx, mobile, together] = rows.map((r) => r.label)
    expect(order()).toEqual([base, mobile, salary, fx, together, rent, 'Broken'])
    expect(order('days_under_floor')).toEqual([base, salary, together, rent, fx, mobile, 'Broken'])
    expect(order('fx_margin')).toEqual([base, salary, mobile, together, fx, rent, 'Broken'])
    expect(order('lowest')).toEqual([base, salary, together, rent, fx, mobile, 'Broken'])
    expect(order('lowest', 'pesos')).toEqual([base, salary, mobile, fx, together, rent, 'Broken'])
    expect(sortRows(rows, 'interest').map((r) => r.label)).toEqual([base, rent, salary, fx, mobile, together, 'Broken'])
    expect(rows.map((r) => r.label)).toEqual([base, rent, salary, fx, mobile, together, 'Broken'])
  })
})
