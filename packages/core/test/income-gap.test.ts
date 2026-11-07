import { describe, expect, it } from 'vitest'
import { abroad, mortgage, usCardsCar, type Sample, type SampleDoc } from '../fixtures'
import { markSize } from '../fixtures/mark-size'
import type { PlanItemInput } from '../fixtures/relative'
import { CARDS, cardsOf } from '../src/engine/cards'
import { expandPlan } from '../src/engine/events'
import { gapDays, monthsMoneyLasts, monthsMoneyLastsYielding, withIncomeGap, type IncomeGap, type MoneyLasts } from '../src/engine/income-gap'
import { LOANS } from '../src/engine/loans'
import { extraByMonth } from '../src/engine/payoff'
import type { Walk } from '../src/engine/types'
import { firstBelowZero } from '../src/engine/walk'
import { buildSnapshot, type Snapshot } from '../src/snapshot'
import { account, balanceOn, cashHousehold, walked } from './walk-helpers'

const AS_OF = '2026-10-07'
const GAP: IncomeGap = { from_month: '2026-11', months: 60 }

function build(sample: (asOf: string) => Sample, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = sample(AS_OF)
  edit?.(doc)
  return buildSnapshot(doc, AS_OF, rates)
}

function lasts(snapshot: Snapshot): MoneyLasts | null {
  const result = monthsMoneyLasts(snapshot)
  if (result !== null && !result.ok) throw new Error(result.errors.map((e) => e.message).join('; '))
  return result
}

const payment = (w: Walk, id: string) => w.lines.find((l) => l.id === `${id}#in`)?.amount_minor ?? null

const item = (fields: Omit<PlanItemInput, 'name'>): PlanItemInput => ({ name: 'Item', ...fields })

// Bank (EUR, floor 1,000.00) earns 3,000.00 on the 25th and pays 1,500.00 rent on the 1st; Savings is a jar fed only by a 300.00 transfer item on the 2nd and spending 300.00 on the 3rd.
function jar(funded: boolean, extra: PlanItemInput[] = []): Snapshot {
  return cashHousehold(AS_OF, (doc) => {
    Object.assign(account(doc, 'bank'), { floor_windows: [{ from_month: '2026-10', to_month: null, amount_minor: 100000 }] })
    if (funded) Object.assign(account(doc, 'savings'), { funded_from_account_id: 'bank' })
    doc.plan_items.push(
      item({ id: 'salary', kind: 'income', to_account_id: 'bank', amount_minor: 300000, starts_on: '2026-10-25' }),
      item({ id: 'rent', kind: 'bill', from_account_id: 'bank', amount_minor: 150000, starts_on: '2026-11-01' }),
      item({ id: 'feed', kind: 'transfer', from_account_id: 'bank', to_account_id: 'savings', amount_minor: 30000, starts_on: '2026-11-02' }),
      item({ id: 'insurance', kind: 'bill', from_account_id: 'savings', amount_minor: 30000, starts_on: '2026-11-03' }),
      ...extra,
    )
  })
}

describe('income gap', () => {
  it('skips the tax set-aside transfer and the salary in the gap, stops extra and drops every card to its minimum', () => {
    // A planned draw is an income item too, so the gap stops it.
    const snapshot = build(abroad, (doc) => doc.plan_items.push(item({ id: 'top-up-loan', kind: 'income', to_account_id: 'rewards-card', amount_minor: 1000000, every: 'once', starts_on: '2027-03-05' })))
    const gapped = withIncomeGap(snapshot, GAP)
    const plan = expandPlan(gapped.snapshot)
    const skipped = (id: string) => plan.byId.get(id)?.skipped
    expect([skipped('salary:2026-10-01'), skipped('tax-set-aside:2026-10-01'), skipped('salary:2026-11-01'), skipped('tax-set-aside:2026-11-01'), skipped('tax-set-aside:2031-10-01'), skipped('top-up-loan:2027-03-01')]).toEqual([false, false, true, true, true, true])
    expect(plan.events.filter((e) => e.date >= '2026-11-01' && e.occurrence_ids.some((id) => id.startsWith('tax-set-aside:') || id.startsWith('salary:')))).toEqual([])
    expect(gapDays(GAP)).toEqual({ from: '2026-11-01', to: '2031-10-31' })

    const base = walked(snapshot, { cards: CARDS, loans: LOANS })
    const gap = walked(gapped.snapshot, { cards: gapped.cards, loans: LOANS })
    const minimum = (cardId: string, cut: string) => cardsOf(gap)?.get(cardId)?.statements.find((s) => s.cut_date === cut)?.minimum_due_minor
    // October's in_full payment is before the gap; inside it the in_full rewards card and the installments_plus shopping card pay only their minimums.
    expect([payment(base, 'payment:rewards-card:2026-09-20'), payment(gap, 'payment:rewards-card:2026-09-20')]).toEqual([4500000, 4500000])
    expect([payment(base, 'payment:rewards-card:2027-01-20'), payment(gap, 'payment:rewards-card:2027-01-20'), minimum('rewards-card', '2027-01-20')]).toEqual([350000, 10500, 10500])
    expect([payment(base, 'payment:shopping-card:2026-11-25'), payment(gap, 'payment:shopping-card:2026-11-25'), minimum('shopping-card', '2026-11-25')]).toEqual([980000, 36043, 36043])
    const paid = [...(cardsOf(gap)?.values() ?? [])].flatMap((r) => r.statements.filter((s) => s.pay_on !== null && s.pay_on >= '2026-11-01' && s.pay_on <= '2031-10-31'))
    expect(paid.length > 100 && paid.every((s) => s.paid_minor === s.minimum_due_minor)).toBe(true)

    // The US extra for debts stops with the gap, so no month in it offers any.
    const us = withIncomeGap(build(usCardsCar), GAP).snapshot
    const months = [...(extraByMonth(us).get('checking')?.keys() ?? [])]
    expect([months, expandPlan(us).occurrences.filter((o) => o.flow === 'extra' && o.period >= '2026-11-01').every((o) => o.skipped)]).toEqual([['2026-10'], true])
  })

  it('shortens the months the money lasts when living costs rise', () => {
    const groceries = (amount: number) => (doc: SampleDoc) => {
      const found = doc.plan_items.find((p) => p.id === 'groceries')
      if (found) found.amount_minor = amount
    }
    // Groceries from 400.00 to 600.00 a month.
    const [base, dearer] = [lasts(build(abroad)), lasts(build(abroad, groceries(60000)))]
    expect([base?.month, base?.months, base?.account_id]).toEqual(['2027-05', 6, 'main'])
    expect([dearer?.month, dearer?.months, dearer?.account_id]).toEqual(['2027-04', 5, 'main'])
  })

  it('lasts longer when a bill or budget stops with income, skipping only its occurrences inside the gap', () => {
    const stopping = (...ids: string[]) => (doc: SampleDoc) => {
      for (const p of doc.plan_items) if (ids.includes(p.id)) Object.assign(p, { stops_with_income: true })
    }
    const snapshot = build(abroad, stopping('groceries'))
    const plan = expandPlan(withIncomeGap(snapshot, GAP).snapshot)
    const skipped = (id: string) => plan.byId.get(id)?.skipped
    expect([skipped('groceries:2026-10-01'), skipped('groceries:2026-11-01'), skipped('groceries:2031-10-01'), skipped('rent:2026-11-01')]).toEqual([false, true, true, false])
    // Outside the gap the flag changes nothing.
    expect(expandPlan(snapshot).byId.get('groceries:2026-11-01')?.skipped).toBe(false)
    // Groceries' 400.00 a month, no longer paid, buys three more months.
    const [base, cut] = [lasts(build(abroad)), lasts(snapshot)]
    expect([base?.month, base?.months, cut?.month, cut?.months]).toEqual(['2027-05', 6, '2027-08', 9])
  })

  it('counts until the top-up has nothing left to move, spending every floor once income stops', () => {
    // Savings runs dry on 3 Feb; Bank tops it up through its 1,000.00 floor to nothing on 3 Mar, then April's rent takes Bank below zero.
    expect(lasts(jar(true))).toEqual({ ok: true, account_id: 'bank', date: '2027-04-01', month: '2027-04', months: 5 })
    // The income_gap lever keeps the floor: Bank stops topping up with 1,000.00 above it, so Savings ends a day below zero on 3 Mar.
    const gapped = withIncomeGap(jar(true), { from_month: '2026-11', months: 60 })
    expect(firstBelowZero(gapped.snapshot, { cards: gapped.cards, loans: LOANS })).toEqual({ ok: true, first: { account_id: 'savings', date: '2027-03-03' } })
    const w = walked(gapped.snapshot, { mode: 'metrics', cards: gapped.cards, loans: LOANS })
    const savings = w.balances.get('savings') ?? new Float64Array()
    const before = w.days.findIndex((d) => d === '2027-03-03')
    expect([Math.min(...savings.subarray(0, before)), balanceOn(w, 'savings', '2027-02-03'), balanceOn(w, 'bank', '2027-02-03'), balanceOn(w, 'bank', '2027-03-02')]).toEqual([0, 0, 180000, 30000])
    // Unfunded, the jar ends the count a month sooner on its own spending, while Bank still holds 2,000.00.
    expect(lasts(jar(false))).toEqual({ ok: true, account_id: 'savings', date: '2027-02-03', month: '2027-02', months: 3 })
  })

  it('keeps a hedge income left out of item_ids paying through the gap, and still answers a month when it falls short', () => {
    const run = (side: number, gap: IncomeGap) => {
      const gapped = withIncomeGap(jar(true, [item({ id: 'side', kind: 'income', to_account_id: 'bank', amount_minor: side, starts_on: '2026-11-15' })]), gap)
      const result = firstBelowZero(gapped.snapshot, { cards: gapped.cards, loans: LOANS })
      if (!result.ok) throw new Error('The walk failed')
      return [result.first?.date ?? null, expandPlan(gapped.snapshot).byId.get('side:2026-11-01')?.skipped]
    }
    const all: IncomeGap = { from_month: '2026-11', months: 60 }
    const hedged: IncomeGap = { ...all, item_ids: ['salary'] }
    // 500.00 a month against 1,500.00 rent and the jar's 300.00 buys one month; 1,800.00 a month covers both for the whole gap.
    expect([run(50000, all), run(50000, hedged), run(180000, hedged)]).toEqual([
      ['2027-03-03', true],
      ['2027-04-03', false],
      [null, false],
    ])
  })

  it('ends the count on whichever cash account first ends a day below zero, not one chosen account', () => {
    const result = lasts(jar(true, [item({ id: 'pesos-rent', kind: 'bill', from_account_id: 'pesos', amount_minor: 400000, starts_on: '2026-11-10' })]))
    // Pesos holds 10,000.00 and pays 4,000.00 a month with no funder, so it runs out before the jar does.
    expect(result).toEqual({ ok: true, account_id: 'pesos', date: '2027-01-10', month: '2027-01', months: 2 })
  })

  it('gives the same answer when it hands the thread back twice between its steps', async () => {
    const households = [build(abroad), build(usCardsCar), build(mortgage), build(markSize), jar(true), cashHousehold(AS_OF)]
    for (const snapshot of households) {
      let pauses = 0
      const pause = () => {
        pauses++
        return Promise.resolve()
      }
      expect(await monthsMoneyLastsYielding(snapshot, { pause })).toEqual(monthsMoneyLasts(snapshot))
      expect(pauses).toBe(2)
    }
    // abroad runs out in May 2027 on Main; the large household's Pesos is below zero before the gap starts.
    expect(await monthsMoneyLastsYielding(build(abroad))).toEqual({ ok: true, account_id: 'main', date: '2027-05-11', month: '2027-05', months: 6 })
    expect(await monthsMoneyLastsYielding(build(markSize))).toEqual({ ok: true, account_id: 'pesos', date: '2026-10-16', month: '2026-10', months: 0 })
  })

  it('returns null when no cash account ends a day below zero to the horizon end, and refuses item_ids that are not income', () => {
    expect(lasts(cashHousehold(AS_OF))).toBeNull()
    const snapshot = jar(true)
    expect(() => withIncomeGap(snapshot, { from_month: '2026-11', months: 6, item_ids: ['rent', 'nothing'] })).toThrow(
      "income_gap.item_ids: 'rent' is a plan item of kind bill, not income; income_gap.item_ids: no plan item 'nothing'",
    )
  })
})
