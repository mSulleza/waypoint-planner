import { describe, expect, it } from 'vitest'
import { markSize, SAMPLES } from '../fixtures'
import type { PlanItemInput, SampleDoc, TransactionInput } from '../fixtures/relative'
import { categoryBudgets } from '../src/engine/allowances'
import { expandPlan } from '../src/engine/events'
import { buildSnapshot } from '../src/snapshot'
import { abroadAt, bare, occurrence } from './plan-helpers'

const extraGroceries: PlanItemInput = { id: 'groceries-extra', kind: 'allowance', name: 'Groceries, second shop', from_account_id: 'tax', category_id: 'cat-groceries', amount_minor: 20000, starts_on: '2026-10-01' }

function october(edit?: (doc: SampleDoc) => void) {
  const plan = expandPlan(abroadAt('2026-10-07', edit))
  const budget = plan.budgets.find((b) => b.month === '2026-10' && b.category_id === 'cat-groceries')
  const events = plan.events.filter((e) => e.kind === 'allowance' && e.date <= '2026-10-31').map((e) => [e.account_id, e.date, e.until, e.amount_minor])
  return { budget: budget && [budget.budget_minor, budget.spent_minor, budget.left_minor], events, plan }
}

const addRows = (...rows: TransactionInput[]) => (doc: SampleDoc) => {
  doc.transactions.push(...rows)
}

describe('allowances net per category', () => {
  it('nets two allowances in one category and a negative credit once', () => {
    const { budget, events } = october((doc) => {
      doc.plan_items.push(extraGroceries)
    })
    expect(budget).toEqual([55000, 15000, 40000])
    expect(events).toEqual([
      ['main', '2026-10-07', '2026-10-31', -26666],
      ['tax', '2026-10-07', '2026-10-31', -13334],
    ])
  })

  it('drops a skipped allowance with its share of the category credit', () => {
    const skipped = (ids: string[]) =>
      october((doc) => {
        doc.plan_items.push(extraGroceries)
        for (const p of doc.plan_items) if (ids.includes(p.id)) p.skip_periods = ['2026-10-01']
      })
    const one = skipped(['groceries-extra'])
    expect(one.budget).toEqual([36667, 15000, 21667])
    expect(one.events).toEqual([['main', '2026-10-07', '2026-10-31', -21667]])
    const all = skipped(['groceries-extra', 'groceries'])
    expect([all.budget, all.events]).toEqual([[0, 15000, 0], []])
  })

  it('leaves rows linked to a bill out of the category net', () => {
    const rentPaidEarly: TransactionInput = { id: 'rent-early', account_id: 'main', posted_on: '2026-10-06', amount_minor: -90000, kind: 'expense', category_id: 'cat-groceries', plan_item_id: 'rent', period: '2026-11-01' }
    expect(october(addRows(rentPaidEarly)).budget).toEqual([35000, 15000, 20000])
    expect(october(addRows({ ...rentPaidEarly, plan_item_id: null, period: null })).budget).toEqual([35000, 105000, 0])
  })

  it('nets tagged spend once, refunds restoring at most the budget, while untagged rows and adjustments net nothing', () => {
    expect(october(addRows({ id: 'returned', account_id: 'main', posted_on: '2026-10-07', amount_minor: 30000, kind: 'refund', category_id: 'cat-groceries' })).budget).toEqual([35000, -15000, 35000])
    expect(
      october(
        addRows(
          { id: 'untagged', account_id: 'main', posted_on: '2026-10-07', amount_minor: -5000, kind: 'expense' },
          { id: 'fix', account_id: 'main', posted_on: '2026-10-07', amount_minor: -5000, kind: 'adjustment' },
        ),
      ).budget,
    ).toEqual([35000, 15000, 20000])
    const onCard = october(addRows({ id: 'card-shop', account_id: 'rewards-card', posted_on: '2026-10-07', amount_minor: -700000, kind: 'expense', category_id: 'cat-groceries' }))
    expect(onCard.budget).toEqual([35000, 25000, 10000])
    expect(onCard.events).toEqual([['main', '2026-10-07', '2026-10-31', -10000]])
  })

  it('folds a negative allowance into its category with no state of its own, and it lapses with its month', () => {
    const plan = expandPlan(
      bare(
        '2026-10-07',
        {
          plan_items: [
            { id: 'food', kind: 'allowance', name: 'Food', from_account_id: 'bank', category_id: 'food', amount_minor: 30000, starts_on: '2026-09-01' },
            { id: 'food-voucher', kind: 'allowance', name: 'Food voucher', from_account_id: 'bank', category_id: 'food', amount_minor: -5000, every: 'once', starts_on: '2026-09-01' },
          ],
        },
        '2026-09-01',
      ),
    )
    const voucher = occurrence(plan, 'food-voucher:2026-09-01')
    expect([voucher.state, voucher.open_minor, occurrence(plan, 'food:2026-09-01').state]).toEqual([null, 0, 'lapsed'])
    expect(plan.events.filter((e) => e.occurrence_ids.includes(voucher.id))).toEqual([])
    expect(plan.budgets.filter((b) => b.month === '2026-10').map((b) => [b.budget_minor, b.left_minor, b.occurrence_ids])).toEqual([[30000, 30000, ['food:2026-10-01']]])
  })

  it('spreads exactly the category budgets left over the rest of each month, every month to the horizon', () => {
    for (const asOf of ['2026-10-07', '2027-03-15']) {
      for (const build of [...SAMPLES.map((s) => s.build), markSize]) {
        const { doc, rates } = build(asOf)
        const plan = expandPlan(buildSnapshot(doc, asOf, rates))
        const months = new Set(plan.budgets.map((b) => b.month))
        expect(months.size).toBe(doc.plan_items.some((p) => p.kind === 'allowance') ? 61 : 0)
        for (const month of months) {
          const fromBudgets = new Map<string, number>()
          for (const b of plan.budgets.filter((x) => x.month === month)) for (const s of b.shares) fromBudgets.set(s.account_id, (fromBudgets.get(s.account_id) ?? 0) + s.amount_minor)
          const fromEvents = new Map<string, number>()
          for (const e of plan.events.filter((x) => x.kind === 'allowance' && x.date.startsWith(month))) fromEvents.set(e.account_id, (fromEvents.get(e.account_id) ?? 0) - e.amount_minor)
          expect([month, Object.fromEntries(fromEvents)]).toEqual([month, Object.fromEntries([...fromBudgets].filter(([, v]) => v > 0))])
        }
      }
    }
  })

  it('keeps one-off bills out of the category budgets and counts a one-off allowance in its own month only', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.plan_items.push({ id: 'party', kind: 'bill', name: 'Party', from_account_id: 'main', amount_minor: 25000, every: 'once', starts_on: '2026-10-20' })
      }),
    )
    const groceries = plan.budgets.filter((b) => b.category_id === 'cat-groceries').slice(0, 3)
    expect(groceries.map((b) => [b.month, b.budget_minor, b.occurrence_ids])).toEqual([
      ['2026-10', 35000, ['groceries-credit:2026-10-01', 'groceries:2026-10-01']],
      ['2026-11', 40000, ['groceries:2026-11-01']],
      ['2026-12', 40000, ['groceries:2026-12-01']],
    ])
    expect(plan.budgets.flatMap((b) => b.occurrence_ids).filter((id) => id.startsWith('party'))).toEqual([])
  })

  it('keeps the allowance of the month track_from falls in, netted against that whole month', () => {
    const plan = expandPlan(
      bare(
        '2026-10-20',
        {
          plan_items: [{ id: 'food', kind: 'allowance', name: 'Food', from_account_id: 'bank', category_id: 'food', amount_minor: 30000, starts_on: '2026-09-01' }],
          transactions: [{ id: 'shop', account_id: 'bank', posted_on: '2026-10-04', amount_minor: -12000, kind: 'expense', category_id: 'food' }],
        },
        '2026-10-15',
      ),
    )
    expect(plan.occurrences.map((o) => o.id).slice(0, 2)).toEqual(['food:2026-10-01', 'food:2026-11-01'])
    expect(plan.events.filter((e) => e.kind === 'allowance').slice(0, 1).map((e) => [e.date, e.until, e.amount_minor])).toEqual([['2026-10-20', '2026-10-31', -18000]])
  })

  it('nets across currencies at the snapshot rates and leaves a currency with no rate unnetted', () => {
    const snapshot = bare('2026-10-07', {
      plan_items: [
        { id: 'fun-eur', kind: 'allowance', name: 'Fun', from_account_id: 'bank', category_id: 'fun', amount_minor: 10000, starts_on: '2026-10-01' },
        { id: 'fun-php', kind: 'allowance', name: 'Fun in pesos', from_account_id: 'pesos', category_id: 'fun', amount_minor: 700000, starts_on: '2026-10-01' },
      ],
      transactions: [{ id: 'cinema', account_id: 'pesos', posted_on: '2026-10-03', amount_minor: -350000, kind: 'expense', category_id: 'fun' }],
    })
    const [fun] = categoryBudgets(snapshot, '2026-10', expandPlan(snapshot).occurrences)
    expect([fun?.currency, fun?.budget_minor, fun?.spent_minor, fun?.left_minor, fun?.shares, fun?.missing_rates]).toEqual([
      'EUR',
      20000,
      5000,
      15000,
      [
        { account_id: 'bank', amount_minor: 7500 },
        { account_id: 'pesos', amount_minor: 525000 },
      ],
      [],
    ])
    const noRate = buildSnapshot(JSON.parse(JSON.stringify(snapshot.doc)), '2026-10-07', [{ quote: 'EUR', rate: 1, day: '2026-10-07' }])
    const [unnetted] = categoryBudgets(noRate, '2026-10', expandPlan(noRate).occurrences)
    expect([unnetted?.left_minor, unnetted?.shares, unnetted?.missing_rates]).toEqual([
      10000,
      [
        { account_id: 'bank', amount_minor: 10000 },
        { account_id: 'pesos', amount_minor: 700000 },
      ],
      ['PHP'],
    ])
  })
})
