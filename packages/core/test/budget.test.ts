import { describe, expect, it } from 'vitest'
import type { SampleDoc } from '../fixtures'
import type { PlanItemInput, TransactionInput } from '../fixtures/relative'
import { budgetRows, budgetWord, todayBudgets, type BudgetRow } from '../src/budget'
import { addDays } from '../src/dates'
import { expandPlan } from '../src/engine/events'
import { THRESHOLDS } from '../src/thresholds'
import { advise } from './advice-helpers'
import { cashHousehold } from './walk-helpers'

const allowance = (id: string, category_id: string, amount_minor: number, from_account_id = 'bank'): PlanItemInput => ({ id, kind: 'allowance', name: id, from_account_id, category_id, amount_minor, starts_on: '2026-10-01' })

const spend = (id: string, day: string, amount_minor: number, category_id = 'food', account_id = 'bank'): TransactionInput => ({ id, account_id, posted_on: day, amount_minor: -amount_minor, kind: 'expense', category_id })

function rowsOn(asOf: string, edit: (doc: SampleDoc) => void): readonly BudgetRow[] {
  return budgetRows(cashHousehold(asOf, edit))
}

// A 310.00 budget in October, spent at 15.00 a day from the 1st through as_of.
const atFifteenADay = (asOf: string) =>
  rowsOn(asOf, (doc) => {
    doc.plan_items.push(allowance('food-budget', 'food', 31000))
    for (let day = '2026-10-01'; day <= asOf; day = addDays(day, 1)) doc.transactions.push(spend(`shop-${day}`, day, 1500))
  })[0]

describe('budget pace', () => {
  it('reads Spending fast on day 8 for a 310 budget in a 31-day month spent at 15 a day, and On pace on day 7', () => {
    const day8 = atFifteenADay('2026-10-08')
    expect(day8).toMatchObject({ budget_minor: 31000, spent_minor: 12000, left_minor: 19000, days_elapsed: 8, days_left: 24, days_in_month: 31, per_day_minor: 791, rate_so_far_minor: 1500, planned_rate_minor: 1000, word: 'Spending fast' })
    // In the first week only spent > budget × (day + 7) ÷ days flags: 105.00 is under 140.00.
    expect(atFifteenADay('2026-10-07')?.word).toBe('On pace')
    // From day 8 the pace rule is exact at its boundary: 11.00 a day is 1.1 × 310.00 ÷ 31 and does not flag; 11.01 does.
    expect([budgetWord(8800, 31000, 8, 31), budgetWord(8808, 31000, 8, 31)]).toEqual(['On pace', 'Spending fast'])
  })

  it('reads On pace on day 2 after one 80 shop', () => {
    const [row] = rowsOn('2026-10-02', (doc) => {
      doc.plan_items.push(allowance('food-budget', 'food', 31000))
      doc.transactions.push(spend('weekly-shop', '2026-10-02', 8000))
    })
    expect([row?.spent_minor, row?.word]).toEqual([8000, 'On pace'])
  })

  it('honours the sign of tagged rows, converts other currencies at today rate and never clamps left at zero', () => {
    const snapshot = cashHousehold('2026-10-10', (doc) => {
      doc.plan_items.push(allowance('food-budget', 'food', 10000))
      doc.transactions.push(spend('market', '2026-10-03', 6000), { id: 'returned', account_id: 'bank', posted_on: '2026-10-04', amount_minor: 1000, kind: 'refund', category_id: 'food' }, spend('abroad', '2026-10-05', 700000, 'food', 'pesos'))
    })
    const [row] = budgetRows(snapshot)
    const engine = expandPlan(snapshot).budgets.find((b) => b.month === '2026-10')
    // 60.00 − 10.00 refunded + ₱7,000.00 at ₱70 to the euro: 150.00 spent of 100.00.
    expect([row?.spent_minor, row?.left_minor, row?.per_day_minor, row?.word, engine?.left_minor]).toEqual([15000, -5000, 0, 'Spending fast', 0])
  })

  it('cannot read the pace without a rate for a row currency', () => {
    const snapshot = cashHousehold('2026-10-10', (doc) => {
      doc.accounts.push({ id: 'dollars', name: 'Dollars', kind: 'cash', currency: 'USD', opening_balance_minor: 50000, opening_date: '2026-01-01', sort_order: 3 })
      doc.plan_items.push(allowance('food-budget', 'food', 10000), allowance('food-trip', 'food', 5000, 'dollars'))
    })
    const [row] = budgetRows(snapshot)
    expect([row?.currency, row?.missing_rates, row?.word, row?.budget_base_minor]).toEqual(['EUR', ['USD'], null, 10000])
  })

  it('shows at most three rows on Today, Spending fast first, then the largest budgets, and none for a category done for the month', async () => {
    const snapshot = cashHousehold('2026-10-10', (doc) => {
      doc.categories.push({ id: 'fun', name: 'Fun' }, { id: 'home', name: 'Home' }, { id: 'kids', name: 'Kids' }, { id: 'pets', name: 'Pets' })
      doc.plan_items.push(
        allowance('food-budget', 'food', 40000),
        allowance('fun-budget', 'fun', 5000),
        allowance('home-budget', 'home', 30000),
        allowance('kids-budget', 'kids', 20000),
        { ...allowance('pets-budget', 'pets', 90000), skip_periods: ['2026-10-01'] },
        // ₱7,000.00 is the largest budget at 100.00.
        allowance('kids-trip', 'kids', 700000, 'pesos'),
      )
      doc.transactions.push(spend('cinema', '2026-10-09', 4000, 'fun'), spend('vet', '2026-10-09', 3000, 'pets'))
    })
    const rows = budgetRows(snapshot)
    expect(rows.map((r) => [r.category_id, r.currency, r.budget_base_minor, r.word])).toEqual([
      ['food', 'EUR', 40000, 'On pace'],
      ['fun', 'EUR', 5000, 'Spending fast'],
      ['home', 'EUR', 30000, 'On pace'],
      ['kids', 'EUR', 30000, 'On pace'],
    ])
    expect(todayBudgets(rows).map((r) => r.category_id)).toEqual(['fun', 'food', 'home'])
    const a = await advise(snapshot)
    expect(a.alerts.filter((x) => x.kind === 'spending_fast').map((x) => [x.id, x.subject, a.say(x.body)])).toEqual([['spending_fast:fun:2026-10', { account_id: 'bank', month: '2026-10' }, 'Fun: €40.00 spent of €50.00, €4.00 a day against €1.61 planned.']])
    expect(THRESHOLDS.spending_fast.pace).toBe(1.1)
  })
})
