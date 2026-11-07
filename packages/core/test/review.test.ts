import { describe, expect, it } from 'vitest'
import { cardHousehold, revolvingDaily, usCardsCar } from '../fixtures'
import { CARDS, cardsOf } from '../src/engine/cards'
import { LOANS } from '../src/engine/loans'
import { expandPlan } from '../src/engine/events'
import { termsFromPreset } from '../src/presets'
import { reviewList } from '../src/review'
import { buildSnapshot } from '../src/snapshot'
import { advise, sampleAt } from './advice-helpers'
import { cashHousehold, walked } from './walk-helpers'

describe('review list', () => {
  it('lists overdue bills and loan payments and statements to enter with stable ids in act-by order, never a card payment', async () => {
    const a = await advise(sampleAt(usCardsCar, '2026-10-23'))
    expect(a.review.map((r) => [r.id, r.kind, r.account_id, r.month, r.amount, r.act_by])).toEqual([
      ['overdue_outflow:utilities:2026-10-01', 'overdue_outflow', 'checking', '2026-10', { minor: 18000, currency: 'USD' }, '2026-10-12'],
      ['overdue_outflow:payment:car-loan:2026-10-20', 'overdue_outflow', 'car-loan', '2026-10', { minor: 35558, currency: 'USD' }, '2026-10-20'],
      ['statement_to_enter:travel-card:2026-10-20', 'statement_to_enter', 'travel-card', '2026-10', null, '2026-11-16'],
    ])
    expect(a.review.map((r) => a.say(r.body))).toEqual([
      'Utilities: $180.00 from Checking was due on 2026-10-12.',
      'Car loan: $355.58 was due on 2026-10-20.',
      'Travel card cut on 2026-10-20; enter its statement before paying the bill due 2026-11-16.',
    ])
    // The store card's payment is overdue too, but a card payment is the next action, never a review item.
    expect(a.next.kind).toBe('pay')
    expect(a.next.subject).toEqual({ account_id: 'store-card', month: '2026-10' })
  })

  it('shows an open occurrence a row may settle once, as its suggestion, beside late income', async () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      doc.plan_items.push(
        { id: 'salary', kind: 'income', name: 'Salary', to_account_id: 'bank', amount_minor: 300000, starts_on: '2026-10-03' },
        { id: 'rent', kind: 'bill', name: 'Rent', from_account_id: 'bank', amount_minor: 90000, starts_on: '2026-10-05' },
      )
      doc.transactions.push({ id: 'landlord', account_id: 'bank', posted_on: '2026-10-04', amount_minor: -89000, kind: 'expense', description: 'Landlord' })
    })
    expect(expandPlan(snapshot).byId.get('rent:2026-10-01')?.state).toBe('overdue')
    const a = await advise(snapshot)
    expect(a.review.map((r) => [r.id, r.kind, r.row_id, r.act_by])).toEqual([
      ['unconfirmed_inflow:salary:2026-10-01', 'unconfirmed_inflow', null, '2026-10-03'],
      ['suggestion:landlord>rent:2026-10-01', 'suggestion', 'landlord', '2026-10-05'],
    ])
    expect(a.review.map((r) => a.say(r.body))).toEqual([
      'Salary: €3,000.00 into Bank was expected on 2026-10-03 and has no linked transaction, so it now counts on 2026-11-01.',
      'A transaction of €890.00 on 2026-10-04 may settle Rent, €900.00 due 2026-10-05.',
    ])
  })

  it('never lists a past unlinked transfer item into a card whose cycle is paid', async () => {
    const { doc, rates } = cardHousehold({
      asOf: '2026-10-07',
      terms: termsFromPreset('PH-daily-unpaid', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' }),
      opening_balance_minor: -500000,
      opening_date: '2026-08-21',
      statements: [{ id: 'sep', account_id: 'card', cut_date: '2026-09-20', due_date: '2026-10-16', total_due_minor: 500000, minimum_due_minor: 15000 }],
      transactions: [
        { id: 'paid-out', account_id: 'cash', posted_on: '2026-10-02', amount_minor: -500000, kind: 'transfer', transfer_id: 'paid' },
        { id: 'paid-in', account_id: 'card', posted_on: '2026-10-02', amount_minor: 500000, kind: 'transfer', transfer_id: 'paid' },
      ],
      plan_items: [
        { id: 'card-top-up', kind: 'transfer', name: 'Card top-up', to_account_id: 'card', amount_minor: 100000, every: 'once', starts_on: '2026-09-05' },
        { id: 'gym', kind: 'bill', name: 'Gym', from_account_id: 'cash', amount_minor: 20000, every: 'once', starts_on: '2026-10-03' },
      ],
    })
    const a = await advise(buildSnapshot(doc, '2026-10-07', rates))
    const item = expandPlan(a.snapshot).byId.get('card-top-up:2026-09-01')
    const sep = cardsOf(a.walk)?.get('card')?.statements.find((s) => s.id === 'sep')
    // The item counts in September's cycle, which the recorded payment covers.
    expect([item?.date, item?.links.length, item?.state, sep?.payment?.items_minor, sep?.payment?.state]).toEqual(['2026-09-05', 0, null, 100000, 'paid'])
    expect(a.review.map((r) => r.id)).toEqual(['overdue_outflow:gym:2026-10-01'])
    expect(a.alerts.filter((x) => JSON.stringify(x).includes('card-top-up'))).toEqual([])
  })

  it('warns once per printed part that differs on the latest entered statement and retires the warning when a newer statement is entered', async () => {
    const asOf = '2026-10-22'
    const build = (enterOctober: boolean) => {
      const { doc, rates } = revolvingDaily('2026-10-07')
      const last = doc.statements.find((s) => s.id === 'last')
      if (!last) throw new Error('No last statement')
      // Printed installments 2,000.00 against the plan's 1,500.00, the total kept balanced.
      Object.assign(last, { installments_minor: 200000, total_due_minor: 3050000 })
      if (enterOctober) doc.statements.push({ id: 'oct', account_id: 'card', cut_date: '2026-10-20', due_date: '2026-11-16', total_due_minor: 2000000, minimum_due_minor: 60000 })
      return buildSnapshot(doc, asOf, rates)
    }
    const [before, after] = [await advise(build(false)), await advise(build(true))]
    expect(before.review.map((r) => [r.id, r.statement_id, r.amount, r.act_by])).toEqual([
      ['statement_warning:last:installments', 'last', { minor: 50000, currency: 'PHP' }, '2026-10-16'],
      ['statement_to_enter:card:2026-10-20', 'card:2026-10-20', null, '2026-11-16'],
    ])
    expect(before.say(before.review[0]?.body ?? [])).toBe('Card: Installments differ from your plan; printed ₱2,000.00, expected ₱1,500.00.')
    expect(after.review).toEqual([])
  })

  it('asks for only the latest statement of a card whose cuts all passed with none entered', async () => {
    const { doc, rates } = cardHousehold({
      asOf: '2026-10-23',
      terms: termsFromPreset('US-generic', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' }),
      opening_balance_minor: -300000,
      opening_date: '2026-06-21',
    })
    const a = await advise(buildSnapshot(doc, '2026-10-23', rates))
    const provisional = cardsOf(a.walk)?.get('card')?.statements.filter((s) => s.provisional).map((s) => s.cut_date)
    expect(provisional).toEqual(['2026-07-20', '2026-08-20', '2026-09-20', '2026-10-20'])
    expect(a.review.map((r) => [r.id, r.act_by])).toEqual([['statement_to_enter:card:2026-10-20', '2026-11-16']])
  })

  it('lets an overdue bill expire once it falls before the twelve-month lookback', async () => {
    const at = (asOf: string) =>
      cashHousehold(asOf, (doc) => {
        doc.household.track_from = '2025-01-01'
        for (const a of doc.accounts) a.opening_date = '2025-01-01'
        doc.plan_items.push(
          { id: 'club', kind: 'bill', name: 'Club', from_account_id: 'bank', amount_minor: 5000, every: 'once', starts_on: '2025-09-20' },
          { id: 'dues', kind: 'bill', name: 'Dues', from_account_id: 'bank', amount_minor: 7000, every: 'once', starts_on: '2025-11-20' },
        )
      })
    const ids = async (asOf: string) => (await advise(at(asOf))).review.map((r) => r.id)
    expect([await ids('2026-10-07'), await ids('2026-11-30'), await ids('2026-12-01')]).toEqual([['overdue_outflow:dues:2025-11-01'], ['overdue_outflow:dues:2025-11-01'], []])
  })

  it('refuses a walk of another day or one without the card or loan module', async () => {
    const snapshot = sampleAt(usCardsCar, '2026-10-23')
    const other = await advise(sampleAt(usCardsCar, '2026-10-24'))
    expect(() => reviewList(snapshot, other.walk)).toThrow("The walk is for 2026-10-24, not the snapshot's day 2026-10-23")
    expect(() => reviewList(snapshot, walked(snapshot, { loans: LOANS }))).toThrow('The review needs a walk that ran the card module')
    expect(() => reviewList(snapshot, walked(snapshot, { cards: CARDS }))).toThrow('The review needs a walk that ran the loan module')
  })
})
