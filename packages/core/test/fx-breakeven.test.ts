import { describe, expect, it } from 'vitest'
import { abroad, mortgage, usCardsCar, type Sample, type SampleDoc } from '../fixtures'
import { relativeTo } from '../fixtures/relative'
import { CARDS } from '../src/engine/cards'
import { fxBreakeven, type FxBreakeven } from '../src/engine/fx-breakeven'
import { LOANS } from '../src/engine/loans'
import { buildSnapshot, type Snapshot } from '../src/snapshot'
import { account, balanceOn, cashHousehold, walked } from './walk-helpers'

const AS_OF = '2026-10-07'

function build(sample: (asOf: string) => Sample, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = sample(AS_OF)
  edit?.(doc)
  return buildSnapshot(doc, AS_OF, rates)
}

async function found(snapshot: Snapshot): Promise<FxBreakeven> {
  const result = await fxBreakeven(snapshot)
  if (result === null || !result.ok) throw new Error('No breakeven')
  return result
}

// Full walks at m = k / 1000, apart from the search: the days below zero at m = 1.5 per account, then whether any other day ends below zero.
function bruteForce(snapshot: Snapshot) {
  const at = (k: number) => walked(snapshot, { mode: 'metrics', cards: CARDS, loans: LOANS, fx_shift_pct: (k - 1000) / 1000 })
  const top = at(1500)
  const cash = snapshot.doc.accounts.filter((a) => a.kind === 'cash').map((a) => a.id)
  const always = new Map(cash.map((id) => [id, new Set([...(top.balances.get(id) ?? [])].flatMap((b, i) => (b < 0 ? [i] : [])))]))
  const firstNew = (k: number): [string, string] | null => {
    const w = at(k)
    for (let i = 0; i < w.days.length; i++) {
      for (const id of cash) if ((w.balances.get(id)?.[i] ?? 0) < 0 && !always.get(id)?.has(i)) return [id, w.days[i] ?? '']
    }
    return null
  }
  return { firstNew, always }
}

describe('FX breakeven', () => {
  it('finds the abroad breakeven within 0.1 point of a brute-force scan at steps of 0.005, in at most 14 walks', async () => {
    const snapshot = build(abroad)
    const result = await found(snapshot)
    const { firstNew } = bruteForce(snapshot)
    let scan = 1500
    for (let k = 500; k <= 1500; k += 5) {
      if (firstNew(k) === null) {
        scan = k
        break
      }
    }
    const k = Math.round(result.multiplier * 1000)
    expect([scan, k, Math.abs(scan - k) <= 1, result.walks <= 14]).toEqual([690, 689, true, true])
    // The search's answer passes and one thousandth below it fails, on the account and day it names as binding.
    expect([firstNew(k), firstNew(k - 1)]).toEqual([null, ['pesos', '2026-10-22']])
    expect(result).toEqual({
      ok: true,
      funding_currency: 'EUR',
      multiplier: 0.689,
      margin: 0.311,
      below_range: false,
      rates: [{ currency: 'PHP', today: 70, breakeven: 48.23 }],
      binding: { account_id: 'pesos', date: '2026-10-22' },
      rate_independent: [],
      walks: 12,
    })
  })

  it('puts a Tax account negative at every rate in rate_independent and still finds the breakeven at today rate', async () => {
    const { on } = relativeTo(AS_OF)
    const bill = on(1, 20)
    const snapshot = build(abroad, (doc) => {
      doc.plan_items.push({ id: 'tax-bill', kind: 'bill', name: 'Tax bill', from_account_id: 'tax', amount_minor: 300000, every: 'once', starts_on: bill })
    })
    // The bill takes Tax below zero until the next set-aside on the 28th, whatever the peso is worth.
    const today = walked(snapshot, { mode: 'metrics', cards: CARDS, loans: LOANS })
    expect([balanceOn(today, 'tax', bill), balanceOn(today, 'tax', on(1, 28))]).toEqual([-60000, 0])
    const result = await found(snapshot)
    const base = await found(build(abroad))
    expect([result.rate_independent, result.multiplier, result.multiplier === base.multiplier, result.binding]).toEqual([
      [{ account_id: 'tax', date: bill, days: 8 }],
      0.689,
      true,
      { account_id: 'pesos', date: '2026-10-22' },
    ])
  })

  it('returns null for the one-currency US and mortgage households', async () => {
    expect([await fxBreakeven(build(usCardsCar)), await fxBreakeven(build(mortgage))]).toEqual([null, null])
  })

  it('stops after two walks when the funding currency at half its value still covers every day', async () => {
    const snapshot = cashHousehold(AS_OF, (doc) => {
      Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'bank', floor_windows: [{ from_month: '2026-10', to_month: null, amount_minor: 500000 }] })
      doc.plan_items.push({ id: 'market', kind: 'bill', name: 'Market', from_account_id: 'pesos', amount_minor: 100000, starts_on: '2026-10-20' })
    })
    const result = await found(snapshot)
    expect([result.multiplier, result.margin, result.below_range, result.binding, result.walks]).toEqual([0.5, 0.5, true, null, 2])
  })

  it('yields to the screen between walks, once before every walk after the first', async () => {
    let pauses = 0
    const result = await fxBreakeven(build(abroad), {
      pause: async () => {
        pauses++
      },
    })
    expect([result !== null && result.ok ? result.walks : null, pauses]).toEqual([12, 11])
  })
})
