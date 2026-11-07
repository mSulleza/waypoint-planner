import { describe, expect, it } from 'vitest'
import { abroad, mortgage, usCardsCar, type Sample, type SampleDoc } from '../fixtures'
import { CARDS, cardsOf } from '../src/engine/cards'
import { LOANS, loansOf } from '../src/engine/loans'
import { walkMetrics, type CashMetrics, type WalkMetrics } from '../src/engine/metrics'
import type { Walk } from '../src/engine/types'
import { convert } from '../src/money'
import { toRatesPerEur } from '../src/rates'
import { floorAndTarget } from '../src/schema/rows'
import { buildSnapshot, snapshotIndex, type Snapshot } from '../src/snapshot'
import { account, cashHousehold, walked } from './walk-helpers'

const AS_OF = '2026-10-07'

function build(sample: (asOf: string) => Sample, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = sample(AS_OF)
  edit?.(doc)
  return buildSnapshot(doc, AS_OF, rates)
}

function metricsOf(snapshot: Snapshot): { w: Walk; m: WalkMetrics } {
  const w = walked(snapshot, { mode: 'metrics', cards: CARDS, loans: LOANS })
  return { w, m: walkMetrics(snapshot, w) }
}

const cashOf = (m: WalkMetrics, id: string): CashMetrics => {
  const found = m.cash.find((c) => c.account_id === id)
  if (!found) throw new Error(`No metrics for '${id}'`)
  return found
}

// Lowest day, and days under floor and target, read straight from the balances and the floor windows, apart from the month figures.
function fromDays(snapshot: Snapshot, w: Walk, id: string) {
  const a = snapshotIndex(snapshot).accounts.get(id)
  const balances = w.balances.get(id)
  if (a?.kind !== 'cash' || !balances) throw new Error(`'${id}' is not a cash account`)
  let [lowest, on, underFloor, underTarget] = [Infinity, '', 0, 0]
  w.days.forEach((day, i) => {
    const b = balances[i] ?? 0
    const { floor, target } = floorAndTarget(a.floor_windows, day.slice(0, 7))
    if (b < lowest) [lowest, on] = [b, day]
    if (b < floor) underFloor++
    if (b < target) underTarget++
  })
  return [lowest, on, underFloor, underTarget]
}

describe('walk metrics', () => {
  it('reads the lowest balance and its day, days under floor and target, and unfixable months from every walked day', () => {
    const snapshot = build(abroad)
    const { w, m } = metricsOf(snapshot)
    for (const id of ['main', 'pesos', 'tax']) {
      const c = cashOf(m, id)
      expect([c.lowest_minor, c.lowest_on, c.days_under_floor, c.days_under_target]).toEqual(fromDays(snapshot, w, id))
    }
    // Main dips below its 6,000.00 floor before the 28th's salary, with nothing left to top it up from.
    expect([cashOf(m, 'main').lowest_minor, cashOf(m, 'main').lowest_on, cashOf(m, 'main').days_under_floor, cashOf(m, 'main').unfixable_gap_months]).toEqual([591200, '2026-10-27', 11, ['2026-10']])
    expect([cashOf(m, 'pesos').lowest_on, m.unfixable_gap_months, m.first_below_zero, [m.as_of, m.horizon_end]]).toEqual(['2026-10-22', ['2026-10'], null, [AS_OF, '2031-10-31']])
  })

  it('reports the month the plan breaks and the lowest balance below zero, never a floored zero', () => {
    const snapshot = cashHousehold(AS_OF, (doc) => {
      doc.plan_items.push({ id: 'rent', kind: 'bill', name: 'Rent', from_account_id: 'bank', amount_minor: 300000, starts_on: '2026-11-01' })
    })
    const { m } = metricsOf(snapshot)
    // 5,000.00 pays one 3,000.00 rent and then 59 more go out with no income: 5,000.00 − 60 × 3,000.00.
    expect([m.first_below_zero, cashOf(m, 'bank').lowest_minor, cashOf(m, 'bank').lowest_on, cashOf(m, 'bank').first_below_zero_on]).toEqual([
      { account_id: 'bank', date: '2026-12-01', month: '2026-12' },
      500000 - 60 * 300000,
      '2031-10-01',
      '2026-12-01',
    ])
  })

  it('gives net worth at the horizon as cash at the walk rates minus card owed, installments billed after it and loan balances, as of the entered statements', () => {
    // A phone on the shopping card bills from the 55th month to the 64th, so four of its months come after the horizon.
    const snapshot = build(abroad, (doc) => {
      doc.plan_items.push({ id: 'phone', kind: 'installment', name: 'Phone', from_account_id: 'shopping-card', amount_minor: 100000, starts_on: '2031-05-01', ends_on: '2032-02-01' })
    })
    const { w, m } = metricsOf(snapshot)
    const nw = m.net_worth_at_horizon
    // Both last statements fall due after the horizon end: October's streaming bill on the rewards card, and October's phone EMI on the shopping card.
    expect(nw.debts.map((d) => [d.account_id, d.owed_minor, d.unbilled_installments_minor])).toEqual([
      ['rewards-card', 50000, 0],
      ['shopping-card', 100000, 400000],
    ])
    const end = w.days.length - 1
    const at = (id: string) => w.balances.get(id)?.[end] ?? 0
    const php = at('pesos') - 50000 - (100000 + 400000)
    expect(nw.on).toBe('2031-10-31')
    expect(nw.total).toEqual({ minor: at('main') + at('tax') + (convert(php, 'PHP', 'EUR', toRatesPerEur(snapshot.rates)) ?? NaN), currency: 'EUR', approx: true, day: AS_OF })
    expect(nw.as_of_statements).toEqual([
      { account_id: 'rewards-card', statement_id: 'rewards-last', cut_date: '2026-09-20', source: 'entered' },
      { account_id: 'shopping-card', statement_id: 'shopping-last', cut_date: '2026-09-25', source: 'entered' },
    ])

    // The mortgage owes what its own schedule says after the horizon's last payment day, apart from the walk's balance array.
    const home = build(mortgage)
    const homeMetrics = metricsOf(home)
    const lastPayment = loansOf(homeMetrics.w)?.get('mortgage')?.payments.filter((p) => p.on <= '2031-10-31').at(-1)
    const homeEnd = homeMetrics.w.days.length - 1
    const cash = (homeMetrics.w.balances.get('current')?.[homeEnd] ?? 0) + (homeMetrics.w.balances.get('savings')?.[homeEnd] ?? 0)
    expect([homeMetrics.m.net_worth_at_horizon.debts[0]?.owed_minor, homeMetrics.m.net_worth_at_horizon.total]).toEqual([
      lastPayment?.owed_after_minor,
      { minor: cash - (lastPayment?.owed_after_minor ?? NaN), currency: 'GBP', approx: false },
    ])
  })

  it('gives interest per debt to the horizon, and a loan interest after it to the payoff', () => {
    const snapshot = build(usCardsCar)
    const { w, m } = metricsOf(snapshot)
    const full = walked(snapshot, { cards: CARDS, loans: LOANS })
    // No cut falls between the entered statements and as_of, so every interest line the full walk posts on a card is charged from as_of on.
    const lines = (id: string) => full.lines.filter((l) => l.account_id === id && l.kind === 'interest').reduce((sum, l) => sum - l.amount_minor, 0)
    const car = loansOf(w)?.get('car-loan')
    expect(m.interest).toEqual([
      { account_id: 'car-loan', currency: 'USD', interest_to_horizon_minor: car?.interest_minor, interest_after_horizon_minor: 0 },
      { account_id: 'store-card', currency: 'USD', interest_to_horizon_minor: lines('store-card'), interest_after_horizon_minor: 0 },
      { account_id: 'travel-card', currency: 'USD', interest_to_horizon_minor: lines('travel-card'), interest_after_horizon_minor: 0 },
    ])
    expect(m.interest.map((d) => d.interest_to_horizon_minor)).toEqual([245953, 95034, 17197])
    const home = metricsOf(build(mortgage)).m.interest[0]
    expect([home?.interest_to_horizon_minor, home?.interest_after_horizon_minor]).toEqual([3539328, 4633229])
  })

  it('clears revolving at the final clear, ignoring an early zero carry that new carry follows', () => {
    const repair = (doc: SampleDoc) => doc.plan_items.push({ id: 'repair', kind: 'bill', name: 'Repair', from_account_id: 'travel-card', amount_minor: 500000, every: 'once', starts_on: '2029-03-10' })
    expect(metricsOf(build(usCardsCar)).m.revolving_cleared).toEqual({ month: '2028-05', last_owed_month: '2028-04', after_horizon: false })
    const snapshot = build(usCardsCar, repair)
    const { w, m } = metricsOf(snapshot)
    const carried = (month: string) => [...(cardsOf(w)?.values() ?? [])].some((r) => r.statements.some((s) => s.cut_date.startsWith(month) && (s.carry_minor ?? 0) > 0))
    expect([carried('2028-04'), carried('2028-05'), carried('2029-03'), carried('2029-04')]).toEqual([true, false, false, true])
    expect(m.revolving_cleared).toEqual({ month: '2030-05', last_owed_month: '2030-04', after_horizon: false })
  })

  it('takes debt-free past the horizon from the loan payoff and the last installment month', () => {
    const home = metricsOf(build(mortgage))
    expect([home.m.debt_free, loansOf(home.w)?.get('mortgage')?.payoff]).toEqual([
      { month: '2045-04', last_owed_month: '2045-03', after_horizon: true },
      { on: '2045-04-01', month: '2045-04', after_horizon: true },
    ])
    const phone = metricsOf(
      build(abroad, (doc) => {
        doc.plan_items.push({ id: 'phone', kind: 'installment', name: 'Phone', from_account_id: 'shopping-card', amount_minor: 100000, starts_on: '2031-05-01', ends_on: '2032-02-01' })
      }),
    )
    expect([metricsOf(build(abroad)).m.debt_free, phone.m.debt_free]).toEqual([
      { month: '2027-11', last_owed_month: '2027-10', after_horizon: false },
      { month: '2032-03', last_owed_month: '2032-02', after_horizon: true },
    ])
  })

  it('reads health from every walked day, so an account a top-up holds at its floor ends the horizon the same under higher costs while its source and net worth fall', () => {
    const household = (spend: number) =>
      cashHousehold(AS_OF, (doc) => {
        Object.assign(account(doc, 'bank'), { opening_balance_minor: 2000000 })
        Object.assign(account(doc, 'savings'), { funded_from_account_id: 'bank', floor_windows: [{ from_month: '2026-10', to_month: null, amount_minor: 50000 }] })
        doc.plan_items.push({ id: 'salary', kind: 'income', name: 'Salary', to_account_id: 'bank', amount_minor: 200000, starts_on: '2026-10-25' })
        doc.plan_items.push({ id: 'pharmacy', kind: 'bill', name: 'Pharmacy', from_account_id: 'savings', amount_minor: spend, starts_on: '2026-10-15' })
      })
    const low = metricsOf(household(60000))
    const high = metricsOf(household(90000))
    const closing = (r: typeof low, id: string) => r.m.net_worth_at_horizon.cash.find((c) => c.account_id === id)?.minor
    expect([closing(low, 'savings'), closing(high, 'savings')]).toEqual([50000, 50000])
    const bankLow = (r: typeof low) => cashOf(r.m, 'bank').lowest_minor
    expect([bankLow(high) < bankLow(low), (high.m.net_worth_at_horizon.total?.minor ?? 0) < (low.m.net_worth_at_horizon.total?.minor ?? 0)]).toEqual([true, true])
    // Each of the 61 bills is 300.00 dearer and the bank pays it through a top-up; savings ends every month at its floor either way.
    expect((low.m.net_worth_at_horizon.total?.minor ?? 0) - (high.m.net_worth_at_horizon.total?.minor ?? 0)).toBe(61 * 30000)
  })

  it('refuses a walk that did not run the card or loan module', () => {
    const snapshot = build(usCardsCar)
    expect(() => walkMetrics(snapshot, walked(snapshot, { loans: LOANS }))).toThrow('Debt figures need a walk that ran the card module')
    expect(() => walkMetrics(snapshot, walked(snapshot, { cards: CARDS }))).toThrow('Debt figures need a walk that ran the loan module')
  })
})
