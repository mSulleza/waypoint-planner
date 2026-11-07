import { describe, expect, it } from 'vitest'
import { markSize, SAMPLES } from '../fixtures'
import { relativeTo } from '../fixtures/relative'
import { addDays, daysBetween, lastDayOfMonth } from '../src/dates'
import { expandPlan } from '../src/engine/events'
import { balanceRange, monthFigures } from '../src/engine/rollup'
import { fxTerms, grossFor, netOf } from '../src/money'
import { toRatesPerEur } from '../src/rates'
import { buildSnapshot } from '../src/snapshot'
import { abroadAt, item } from './plan-helpers'
import { account, balanceOn, cashHousehold, knownBalance, payEnteredStatements, topUpLines, topUpPairs, walked } from './walk-helpers'

const DATES = ['2026-10-07', '2027-03-15'] as const
const ALL = [...SAMPLES.map((s) => s.build), markSize]
const window = (amount_minor: number, from_month = '2026-10', to_month: string | null = null) => ({ from_month, to_month, amount_minor })

describe('top-ups', () => {
  it('tops up abroad Pesos on its first short day up to what Main can spare and sends the rest on the 28th', () => {
    const firstSent: number[] = []
    for (const asOf of DATES) {
      const snapshot = abroadAt(asOf)
      const w = walked(snapshot, { cards: payEnteredStatements })
      const { on } = relativeTo(asOf)
      const [due, payday, monthEnd] = [on(0, 16), on(0, 28), lastDayOfMonth(asOf)]
      const terms = fxTerms('EUR', 'PHP', toRatesPerEur(snapshot.rates), 0.007)
      if (!terms) throw new Error('abroad has no EUR to PHP rate')
      // The rewards card's second part, 4,500,000, leaves Pesos on its due date.
      const pesos = (day: string) => knownBalance(snapshot, 'pesos', day) - (day >= due ? 4500000 : 0)
      const lowestFrom = (from: string) => {
        let lowest = Infinity
        for (let day = from; day <= monthEnd; day = addDays(day, 1)) lowest = Math.min(lowest, pesos(day))
        return lowest
      }
      // Each day the need runs to month end, so the 28th sends what is still missing from then on.
      const need = 2000000 - lowestFrom(due)
      const sent = knownBalance(snapshot, 'main', due) - 600000
      const landed = netOf(sent, terms.rate, terms.feePct)
      const rest = grossFor(2000000 - lowestFrom(payday) - landed, terms.rate, terms.feePct)
      firstSent.push(sent)

      expect([pesos(addDays(due, -1)) >= 2000000, pesos(due) < 2000000, sent < grossFor(need, terms.rate, terms.feePct)]).toEqual([true, true, true])
      expect(topUpPairs(w).filter(([day]) => day <= monthEnd)).toEqual([
        [due, 'main', 'pesos', sent, landed],
        [payday, 'main', 'pesos', rest, netOf(rest, terms.rate, terms.feePct)],
      ])
      expect([balanceOn(w, 'main', due), monthFigures(w, 'pesos', asOf)?.days_under_floor]).toEqual([600000, daysBetween(due, payday)])
      expect(balanceRange(w, 'pesos', payday, monthEnd)?.lowest_minor).toBeGreaterThanOrEqual(2000000)
    }
    // Main's 6,450.00 less ten days of the 8.00 groceries share, above its 6,000.00 floor.
    expect(firstSent[0]).toBe(37000)
  })

  it('flags the current month top-up lines to send with both legs posted', () => {
    const snapshot = abroadAt('2026-10-07')
    const w = walked(snapshot, { cards: payEnteredStatements })
    const lines = topUpLines(w)
    const [october, later] = [lines.filter((l) => l.date <= '2026-10-31'), lines.filter((l) => l.date > '2026-10-31')]
    expect([october.length, later.length > 0]).toEqual([4, true])
    expect(october.every((l) => l.flags.length === 1 && l.flags[0] === 'to_send')).toBe(true)
    expect(later.every((l) => l.flags.length === 0)).toBe(true)
    for (const landed of lines.filter((l) => l.amount_minor > 0)) {
      const sent = lines.find((l) => l.id === landed.pair_id)
      expect([sent?.date, sent?.pair_id, (sent?.amount_minor ?? 0) < 0]).toEqual([landed.date, landed.id, true])
    }
    const [sent] = topUpPairs(w)
    expect([balanceOn(w, 'main', '2026-10-16'), balanceOn(w, 'pesos', '2026-10-16')]).toEqual([knownBalance(snapshot, 'main', '2026-10-16') - (sent?.[3] ?? 0), knownBalance(snapshot, 'pesos', '2026-10-16') - 4500000 + (sent?.[4] ?? 0)])
  })

  it('sends nothing from a source below its floor until its payday while the target short days count', () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      account(doc, 'bank').floor_windows = [window(600000)]
      Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'bank', floor_windows: [window(1500000)] })
      doc.plan_items.push(item({ id: 'pay', kind: 'income', to_account_id: 'bank', amount_minor: 300000, starts_on: '2026-10-25' }))
    })
    const w = walked(snapshot)
    const gross = grossFor(500000, 70, 0.005)
    expect(topUpPairs(w).filter(([day]) => day <= '2026-10-31')).toEqual([['2026-10-25', 'bank', 'pesos', gross, netOf(gross, 70, 0.005)]])
    const [bank, pesos] = [monthFigures(w, 'bank', '2026-10'), monthFigures(w, 'pesos', '2026-10')]
    expect([pesos?.days_under_floor, pesos?.word, bank?.days_under_floor, bank?.word]).toEqual([18, 'Short', 18, 'Short'])
    expect([balanceOn(w, 'bank', '2026-10-24'), balanceOn(w, 'bank', '2026-10-25')]).toEqual([500000, 800000 - gross])
  })

  it('takes a source down to its floor, below its target, and never past it', () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      account(doc, 'bank').floor_windows = [window(300000), window(600000)]
      Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'bank', floor_windows: [window(30000000)] })
    })
    const w = walked(snapshot)
    const landed = netOf(200000, 70, 0.005)
    expect(topUpPairs(w)).toEqual([['2026-10-07', 'bank', 'pesos', 200000, landed]])
    const bank = monthFigures(w, 'bank', '2026-10')
    expect([bank?.lowest_minor, bank?.floor_minor, bank?.target_minor, bank?.days_under_floor, bank?.days_under_target, bank?.word]).toEqual([300000, 300000, 600000, 0, 25, 'Tight'])
    expect(monthFigures(w, 'pesos', '2026-10')?.unfixable_gap_minor).toBe(30000000 - 1000000 - landed)
  })

  it('sizes a top-up by gross-up to the floor and no further', () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'bank', floor_windows: [window(1500000)] })
      doc.plan_items.push(item({ id: 'clinic', kind: 'bill', from_account_id: 'pesos', amount_minor: 200000, starts_on: '2026-10-20', every: 'once' }))
    })
    const w = walked(snapshot)
    // Through month end Pesos needs 1,500,000 − (1,000,000 − 200,000) net.
    const gross = grossFor(700000, 70, 0.005)
    const net = netOf(gross, 70, 0.005)
    expect([net >= 700000, netOf(gross - 1, 70, 0.005) < 700000]).toEqual([true, true])
    expect(topUpPairs(w)).toEqual([['2026-10-07', 'bank', 'pesos', gross, net]])
    expect(balanceRange(w, 'pesos', '2026-10-07', '2026-10-31')).toEqual({ lowest_minor: 1500000 + net - 700000, lowest_on: '2026-10-20', highest_minor: 1000000 + net, highest_on: '2026-10-07' })
    expect(monthFigures(w, 'pesos', '2026-10')?.days_under_floor).toBe(0)
  })

  it('tops up targets before their sources and targets sharing a source in sort order', () => {
    const chain = cashHousehold('2026-10-07', (doc) => {
      Object.assign(account(doc, 'savings'), { funded_from_account_id: 'bank', floor_windows: [window(50000)] })
      Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'savings', floor_windows: [window(1500000)] })
      doc.plan_items.push(
        item({ id: 'gym', kind: 'bill', from_account_id: 'savings', amount_minor: 80000, starts_on: '2026-10-07', every: 'once' }),
        item({ id: 'dentist', kind: 'bill', from_account_id: 'savings', amount_minor: 40000, starts_on: '2026-10-20', every: 'once' }),
      )
    })
    // Pesos is handled first and Savings, below its floor, spares nothing; Savings is then filled for the rest of the month and spares the surplus next day.
    expect(topUpPairs(walked(chain)).filter(([day]) => day <= '2026-10-31')).toEqual([
      ['2026-10-07', 'bank', 'savings', 70000, 70000],
      ['2026-10-08', 'savings', 'pesos', 7143, 500010],
      ['2026-10-20', 'bank', 'savings', 7143, 7143],
    ])

    const shared = (pesosFirst: boolean) =>
      cashHousehold('2026-10-07', (doc) => {
        Object.assign(account(doc, 'savings'), { funded_from_account_id: 'bank', floor_windows: [window(400000)], sort_order: pesosFirst ? 2 : 1 })
        Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'bank', floor_windows: [window(30000000)], sort_order: pesosFirst ? 1 : 2 })
      })
    // Lines list by id; Savings, first in sort order, took its whole need before Pesos took the rest.
    expect(topUpPairs(walked(shared(false)))).toEqual([
      ['2026-10-07', 'bank', 'pesos', 200000, netOf(200000, 70, 0.005)],
      ['2026-10-07', 'bank', 'savings', 300000, 300000],
    ])
    const pesosNeed = grossFor(29000000, 70, 0.005)
    expect(topUpPairs(walked(shared(true)))).toEqual([
      ['2026-10-07', 'bank', 'pesos', pesosNeed, netOf(pesosNeed, 70, 0.005)],
      ['2026-10-07', 'bank', 'savings', 500000 - pesosNeed, 500000 - pesosNeed],
    ])
  })

  it('records a top-up as the engine answer, never a plan item or income', () => {
    const snapshot = abroadAt('2026-10-07')
    const w = walked(snapshot, { cards: payEnteredStatements })
    const plan = expandPlan(snapshot)
    const lines = topUpLines(w)
    expect(lines.length).toBeGreaterThan(4)
    for (const l of lines) expect([l.kind, l.state, l.occurrence_ids, l.row_id]).toEqual(['top_up', null, [], null])
    expect(plan.events.filter((e) => e.id.startsWith('top-up'))).toEqual([])
    for (const f of w.figures.get('pesos') ?? []) {
      const own = w.lines.filter((l) => l.account_id === 'pesos' && l.date.startsWith(f.month))
      const sum = (list: typeof own) => list.reduce((s, l) => s + l.amount_minor, 0)
      expect([f.month, f.in_minor, f.top_up_in_minor]).toEqual([f.month, sum(own.filter((l) => l.source !== 'top_up' && l.amount_minor > 0)), sum(own.filter((l) => l.source === 'top_up'))])
    }
  })

  it('has one top-up per pair and day in whole minor units, never a zero line', () => {
    let pairs = 0
    for (const asOf of DATES) {
      for (const build of ALL) {
        const { doc, rates } = build(asOf)
        const w = walked(buildSnapshot(doc, asOf, rates), { cards: payEnteredStatements })
        const keys = topUpPairs(w).map(([day, from, to]) => `${day} ${from} ${to}`)
        pairs += keys.length
        expect(new Set(keys).size).toBe(keys.length)
        expect(topUpLines(w).every((l) => Number.isSafeInteger(l.amount_minor) && l.amount_minor !== 0)).toBe(true)
        for (const balances of w.balances.values()) expect(balances.every(Number.isInteger)).toBe(true)
      }
    }
    expect(pairs).toBeGreaterThan(50)
  })
})
