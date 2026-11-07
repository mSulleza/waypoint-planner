import { describe, expect, it } from 'vitest'
import type { TransactionInput } from '../fixtures/relative'
import { expandPlan } from '../src/engine/events'
import { suggest, suggestFor } from '../src/engine/suggest'
import { abroadAt, bare, counted, item, occurrence } from './plan-helpers'


const moveReceivable = (day: string) => (doc: { plan_items: { id: string; starts_on: string }[] }) => {
  const receivable = doc.plan_items.find((p) => p.id === 'receivable')
  if (receivable) receivable.starts_on = day
}

describe('suggestions', () => {
  it('never suggests a drawdown, an adjustment or an incoming leg, while income and refunds are suggested', () => {
    const near = (rows: TransactionInput[]) =>
      expandPlan(
        abroadAt('2026-10-14', (doc) => {
          doc.transactions.push(...rows)
        }),
      )
    const draw = 'cash-loan-draw:2026-10-01'
    const never = near([
      { id: 'loan-credit', account_id: 'rewards-card', posted_on: '2026-10-14', amount_minor: 2000000, kind: 'drawdown' },
      { id: 'fix', account_id: 'rewards-card', posted_on: '2026-10-14', amount_minor: 2000000, kind: 'adjustment' },
      { id: 'pay-out', account_id: 'pesos', posted_on: '2026-10-13', amount_minor: -2000000, kind: 'transfer', transfer_id: 'pay' },
      { id: 'pay-in', account_id: 'rewards-card', posted_on: '2026-10-14', amount_minor: 2000000, kind: 'transfer', transfer_id: 'pay' },
    ])
    expect(occurrence(never, draw).date).toBe('2026-10-18')
    expect(never.suggestions).toEqual([])
    expect(counted(never, draw)).toEqual([['2026-10-18', 'rewards-card', 2000000]])

    for (const kind of ['income', 'refund'] as const) {
      const plan = near([{ id: 'paid-in', account_id: 'rewards-card', posted_on: '2026-10-14', amount_minor: 2000000, kind }])
      expect(plan.suggestions.map((s) => [s.row_id, s.occurrence_id, s.days_apart, s.amount_gap_minor])).toEqual([['paid-in', draw, 4, 0]])
      expect(counted(plan, draw)).toEqual([])
    }
  })

  it('never lets an unlinked transfer leg of the same amount hold out an expected receivable', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        moveReceivable('2026-10-09')(doc)
        doc.transactions.push(
          { id: 'top-up-out', account_id: 'main', posted_on: '2026-10-07', amount_minor: -2858, kind: 'transfer', transfer_id: 'top-up' },
          { id: 'top-up-in', account_id: 'pesos', posted_on: '2026-10-07', amount_minor: 200000, kind: 'transfer', transfer_id: 'top-up' },
        )
      }),
    )
    expect(occurrence(plan, 'receivable:2026-10-01').open_minor).toBe(200000)
    expect(plan.suggestions).toEqual([])
    expect(counted(plan, 'receivable:2026-10-01')).toEqual([['2026-10-09', 'pesos', 200000]])
  })

  it('suggests a slice within 5 percent of the open remainder and not one further off', () => {
    const slice = (amount: number) =>
      expandPlan(
        abroadAt('2026-10-07', (doc) => {
          moveReceivable('2026-10-09')(doc)
          doc.transactions.push({ id: 'slice-3', account_id: 'pesos', posted_on: '2026-10-07', amount_minor: amount, kind: 'income' })
        }),
      ).suggestions.map((s) => [s.occurrence_id, s.amount_gap_minor])
    expect(slice(195000)).toEqual([['receivable:2026-10-01', -5000]])
    expect(slice(190000)).toEqual([['receivable:2026-10-01', -10000]])
    expect(slice(210000)).toEqual([['receivable:2026-10-01', 10000]])
    expect(slice(189999)).toEqual([])
    expect(slice(210001)).toEqual([])
  })

  it('suggests only the nearer of two open occurrences for one unlinked row, so a receipt is credited once', () => {
    const plan = expandPlan(
      bare('2026-10-07', {
        plan_items: [
          item({ id: 'refund-a', kind: 'income', to_account_id: 'bank', amount_minor: 100000, every: 'once', starts_on: '2026-10-09' }),
          item({ id: 'refund-b', kind: 'income', to_account_id: 'bank', amount_minor: 100000, every: 'once', starts_on: '2026-10-12' }),
        ],
        transactions: [{ id: 'refund-in', account_id: 'bank', posted_on: '2026-10-07', amount_minor: 100000, kind: 'income' }],
      }),
    )
    expect(plan.suggestions.map((s) => [s.row_id, s.occurrence_id, s.days_apart])).toEqual([['refund-in', 'refund-a:2026-10-01', 2]])
    expect([counted(plan, 'refund-a:2026-10-01'), counted(plan, 'refund-b:2026-10-01')]).toEqual([[], [['2026-10-12', 'bank', 100000]]])
  })

  it('breaks a date tie by the nearer amount', () => {
    const plan = expandPlan(
      bare('2026-10-07', {
        plan_items: [
          item({ id: 'phone', kind: 'bill', from_account_id: 'bank', amount_minor: 2000, every: 'once', starts_on: '2026-10-09' }),
          item({ id: 'internet', kind: 'bill', from_account_id: 'bank', amount_minor: 2080, every: 'once', starts_on: '2026-10-09' }),
        ],
        transactions: [{ id: 'paid', account_id: 'bank', posted_on: '2026-10-07', amount_minor: -2070, kind: 'expense' }],
      }),
    )
    expect(plan.suggestions.map((s) => [s.occurrence_id, s.amount_gap_minor])).toEqual([['internet:2026-10-01', -10]])
  })

  it('suggests only on the same account within 7 days and 5 percent, and never settles the occurrence', () => {
    const phone = item({ id: 'phone', kind: 'bill', from_account_id: 'bank', amount_minor: 10000, every: 'once', starts_on: '2026-10-10' })
    const found = (row: Omit<TransactionInput, 'id' | 'kind'>) => {
      const plan = expandPlan(bare('2026-10-11', { plan_items: [phone], transactions: [{ id: 'paid', kind: 'expense', ...row }] }))
      return [plan.suggestions.map((s) => s.occurrence_id), occurrence(plan, 'phone:2026-10-01').state, occurrence(plan, 'phone:2026-10-01').linked_minor]
    }
    expect(found({ account_id: 'bank', posted_on: '2026-10-03', amount_minor: -10000 })).toEqual([['phone:2026-10-01'], 'overdue', 0])
    expect(found({ account_id: 'bank', posted_on: '2026-10-02', amount_minor: -10000 })).toEqual([[], 'overdue', 0])
    expect(found({ account_id: 'savings', posted_on: '2026-10-10', amount_minor: -10000 })).toEqual([[], 'overdue', 0])
    expect(found({ account_id: 'bank', posted_on: '2026-10-10', amount_minor: -10600 })).toEqual([[], 'overdue', 0])
  })

  it('holds out both legs of a cash-to-cash transfer item for an outgoing leg to its own account, and only for that', () => {
    const moved = (to: string) =>
      expandPlan(
        abroadAt('2026-10-25', (doc) => {
          doc.transactions.push(
            { id: 'move-out', account_id: 'main', posted_on: '2026-10-24', amount_minor: -60000, kind: 'transfer', transfer_id: 'move' },
            { id: 'move-in', account_id: to, posted_on: '2026-10-24', amount_minor: to === 'pesos' ? 4200000 : 60000, kind: 'transfer', transfer_id: 'move' },
          )
        }),
      )
    const ownAccount = moved('tax')
    expect(ownAccount.suggestions.map((s) => [s.row_id, s.occurrence_id])).toEqual([['move-out', 'tax-set-aside:2026-10-01']])
    expect(ownAccount.events.filter((e) => e.id.startsWith('tax-set-aside:2026-10') || (e.date === '2026-10-28' && (e.account_id === 'tax' || e.to_account_id === 'tax')))).toEqual([])
    const elsewhere = moved('pesos')
    expect(elsewhere.suggestions).toEqual([])
    expect(elsewhere.events.filter((e) => e.id === 'tax-set-aside:2026-10-01').map((e) => [e.date, e.account_id, e.to_account_id, e.amount_minor])).toEqual([['2026-10-28', 'main', 'tax', -60000]])
  })

  it('reads an early unlinked income row as the salary arriving, holding it out so it is not counted twice', () => {
    const plan = expandPlan(
      abroadAt('2026-10-25', (doc) => {
        doc.transactions.push({ id: 'salary-early', account_id: 'main', posted_on: '2026-10-23', amount_minor: 400000, kind: 'income' })
      }),
    )
    expect(plan.suggestions.map((s) => [s.row_id, s.occurrence_id, s.days_apart])).toEqual([['salary-early', 'salary:2026-10-01', 5]])
    expect(occurrence(plan, 'salary:2026-10-01').state).toBe('due')
    expect(counted(plan, 'salary:2026-10-01')).toEqual([])
    expect(counted(plan, 'salary:2026-11-01')).toEqual([['2026-11-28', 'main', 400000]])
  })

  it('gives the same suggestions whether called alone or through the expanded plan', () => {
    const snapshot = abroadAt('2026-10-25', (doc) => {
      doc.transactions.push({ id: 'salary-early', account_id: 'main', posted_on: '2026-10-23', amount_minor: 400000, kind: 'income' })
    })
    const plan = expandPlan(snapshot)
    expect(suggest(snapshot, plan.occurrences)).toEqual(plan.suggestions)
  })

  it('pairs a row not saved yet by the same rule as a saved one', () => {
    const occurrences = expandPlan(abroadAt('2026-10-25')).occurrences
    const draft = { id: 'draft', account_id: 'main', posted_on: '2026-10-23', amount_minor: 400000, kind: 'income' as const, plan_item_id: null }
    expect(suggestFor(occurrences, draft)).toEqual({ id: 'draft>salary:2026-10-01', row_id: 'draft', occurrence_id: 'salary:2026-10-01', account_id: 'main', days_apart: 5, amount_gap_minor: 0 })
    expect(suggestFor(occurrences, { ...draft, amount_minor: 379999 })).toBeNull()
    expect(suggestFor(occurrences, { ...draft, kind: 'drawdown' })).toBeNull()
    expect(suggestFor(occurrences, { ...draft, plan_item_id: 'salary' })).toBeNull()
    const move = { id: 'out', account_id: 'main', posted_on: '2026-10-24', amount_minor: -60000, kind: 'transfer' as const, plan_item_id: null }
    expect(suggestFor(occurrences, move, 'tax')?.occurrence_id).toBe('tax-set-aside:2026-10-01')
    expect(suggestFor(occurrences, move, 'pesos')).toBeNull()
  })
})
