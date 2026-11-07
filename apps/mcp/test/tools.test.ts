import { abroad, usCardsCar } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { AgentError } from '../src/errors'
import { getDebt } from '../src/tools/read/debt'
import { getLedger } from '../src/tools/read/ledger'
import { listOpen } from '../src/tools/read/open'
import { getOverview } from '../src/tools/read/overview'
import { listPlan } from '../src/tools/read/plan'
import { amount } from '../src/tools/read/shape'
import { typedOutside, typedText, worldAt } from './worlds'

type Shown = { amount: string }
interface OverviewOut {
  next_action: unknown
  cash: { account_id: string; live: Shown; month_end: Shown; month_word: string; lowest: Shown; lowest_on: string; days_under_floor: number }[]
  fx: unknown
  debts: unknown
  basis: unknown
  link: string | null
}

describe('amounts', () => {
  it('come as a decimal string written from the minor units, beside them', () => {
    expect(amount(645000, 'EUR')).toEqual({ currency: 'EUR', amount: '6450.00', amount_minor: 645000 })
    expect(amount(-1240, 'EUR')).toEqual({ currency: 'EUR', amount: '-12.40', amount_minor: -1240 })
    expect(amount(5, 'PHP')).toEqual({ currency: 'PHP', amount: '0.05', amount_minor: 5 })
    expect(amount(-0, 'EUR')).toEqual({ currency: 'EUR', amount: '0.00', amount_minor: 0 })
    expect(amount(1234, 'JPY')).toEqual({ currency: 'JPY', amount: '1234', amount_minor: 1234 })
    expect(amount(1234, 'BHD')).toEqual({ currency: 'BHD', amount: '1.234', amount_minor: 1234 })
    expect(() => amount(1.5, 'EUR')).toThrow('not a whole number')
  })
})

describe('get_overview', () => {
  it('gives the next action with its prefill, and each cash account’s live, month-end and lowest balance', async () => {
    const world = worldAt(abroad, '2026-10-16')
    const out = (await getOverview.run(world, {})) as OverviewOut
    expect(out.next_action).toEqual({
      kind: 'send',
      act_by: '2026-10-16',
      review_id: null,
      prefill: { from_account_id: 'main', to_account_id: 'pesos', sent: { currency: 'EUR', amount: '437.50', amount_minor: 43750 }, received: null },
      data_text: { title: 'Send €437.50 → Pesos', context: 'and €104.87 more on 2026-10-28' },
    })
    expect(out.cash.map((c) => [c.account_id, c.live.amount, c.month_end.amount, c.month_word, c.lowest.amount, c.lowest_on, c.days_under_floor])).toEqual([
      ['main', '6450.00', '9107.63', 'Short', '5862.50', '2026-10-27', 11],
      ['tax', '1800.00', '2400.00', 'OK', '1800.00', '2026-10-16', 0],
      ['pesos', '30000.00', '20000.13', 'Short', '10710.62', '2026-10-22', 12],
    ])
    expect(out.fx).toEqual({ funding_currency: 'EUR', margin: 0.352, multiplier: 0.648, below_range: false, rates: [{ currency: 'PHP', today: 70, breakeven: 45.36 }], binding: { account_id: 'pesos', date: '2026-10-22' }, below_zero_at_any_rate: [] })
    expect(out.debts).toEqual({
      revolving_cleared: { month: null, last_owed_month: null, after_horizon: false },
      debt_free: expect.objectContaining({ after_horizon: false }),
      total_debt: [expect.objectContaining({ currency: 'PHP' })],
    })
    expect(out.basis).toEqual({ as_of: '2026-10-16', horizon_end: '2031-10-31', household: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-PH' }, rates: { day: '2026-10-16', source: 'live', problem: null } })
    expect(out.link).toBe('http://localhost:8090/')
  })

  it('gives Today’s alert line beside a top-up still to come this month, so the action never hides that an account is Short', async () => {
    const out = (await getOverview.run(worldAt(abroad, '2026-10-10'), {})) as OverviewOut & { alert: { id: string; severity: string; more: number; data_text: { title: string } } | null; next_action: { kind: string; act_by: string } }
    expect([out.next_action.kind, out.next_action.act_by, out.cash.filter((c) => c.month_word === 'Short').map((c) => c.account_id)]).toEqual(['send', '2026-10-16', ['main', 'pesos']])
    expect(out.alert).toMatchObject({ severity: 'critical', data_text: { title: 'Cover a shortfall no top-up can fix' } })
    expect(out.alert?.more).toBeGreaterThan(0)
  })

  it('says to enter a statement once a card’s cut has passed with none entered', async () => {
    const out = (await getOverview.run(worldAt(abroad, '2026-10-23'), {})) as { next_action: unknown }
    expect(out.next_action).toEqual({
      kind: 'enter_statement',
      act_by: '2026-11-16',
      review_id: 'statement_to_enter:rewards-card:2026-10-20',
      prefill: null,
      data_text: { title: 'Enter the Rewards card statement', context: 'Rewards card cut on 2026-10-20; enter its statement before paying the bill due 2026-11-16.' },
    })
  })
})

describe('list_open', () => {
  it('lists this month’s open occurrences and the review items, by the day to act by', async () => {
    const out = (await listOpen.run(worldAt(abroad, '2026-10-23'), {})) as { through_month: string; occurrences: { id: string; state: string; open: { amount: string } }[]; review: { id: string; act_by: string; data_text: { body: string } }[]; link: string }
    expect(out.through_month).toBe('2026-10')
    expect(out.occurrences.map((o) => `${o.id} ${o.state}`)).toEqual([
      'groceries:2026-10-01 due',
      'mobile:2026-10-01 overdue',
      'laptop:2026-10-01 due',
      'insurance:2026-10-01 overdue',
      'conversion:2026-10-01 due',
      'salary:2026-10-01 due',
      'tax-set-aside:2026-10-01 due',
    ])
    expect(out.review.map((r) => [r.id, r.act_by, r.data_text.body])).toEqual([
      ['overdue_outflow:mobile:2026-10-01', '2026-10-10', 'Mobile plan: ₱1,200.00 from Pesos was due on 2026-10-10.'],
      ['overdue_outflow:insurance:2026-10-01', '2026-10-22', 'Insurance: ₱3,500.00 from Pesos was due on 2026-10-22.'],
      ['statement_to_enter:rewards-card:2026-10-20', '2026-11-16', 'Rewards card cut on 2026-10-20; enter its statement before paying the bill due 2026-11-16.'],
    ])
    expect(out.link).toBe('http://localhost:8090/months?month=2026-10&view=todo')
  })

  it('lists late income with the day it now counts, and asks whether it arrived', async () => {
    const world = worldAt(abroad, '2026-10-23', (doc) => {
      doc.plan_items.push({ id: 'deposit-back', kind: 'income', name: 'Deposit back', to_account_id: 'main', amount_minor: 80000, every: 'once', starts_on: '2026-09-21' })
    })
    const out = (await listOpen.run(world, {})) as { occurrences: { id: string; state: string; carried_to: string | null; open: { amount: string } }[]; review: { id: string; act_by: string; data_text: { body: string } }[] }
    expect(out.occurrences.filter((o) => o.carried_to !== null).map((o) => [o.id, o.state, o.carried_to, o.open.amount])).toEqual([['deposit-back:2026-09-01', 'late', '2026-11-01', '800.00']])
    expect(out.review[0]).toEqual({
      id: 'unconfirmed_inflow:deposit-back:2026-09-01',
      kind: 'unconfirmed_inflow',
      title: 'Check whether expected money arrived',
      account_id: 'main',
      month: '2026-09',
      date: '2026-09-21',
      act_by: '2026-09-21',
      occurrence_id: 'deposit-back:2026-09-01',
      row_id: null,
      statement_id: null,
      amount: { currency: 'EUR', amount: '800.00', amount_minor: 80000 },
      data_text: { body: 'Deposit back: €800.00 into Main was expected on 2026-09-21 and has no linked transaction, so it now counts on 2026-11-01.' },
    })
  })

  it('reaches later months when asked', async () => {
    const out = (await listOpen.run(worldAt(abroad, '2026-10-23'), { through_month: '2026-11' })) as { occurrences: { id: string }[] }
    expect(out.occurrences.some((o) => o.id === 'rent:2026-11-01')).toBe(true)
    expect(out.occurrences.every((o) => o.id.slice(o.id.lastIndexOf(':') + 1) <= '2026-11-30')).toBe(true)
  })
})

describe('list_plan', () => {
  it('gives every current item with its amount in the account it is counted in, and leaves out ended ones unless asked', async () => {
    const world = worldAt(usCardsCar, '2026-10-16')
    const out = (await listPlan.run(world, {})) as { items: { id: string; kind: string; amount: { currency: string }; ended: boolean }[]; categories: unknown[] }
    expect(out.items.every((i) => !i.ended)).toBe(true)
    expect(out.items.map((i) => i.kind)).toEqual([...out.items.map((i) => i.kind)].sort((a, b) => ['income', 'bill', 'allowance', 'transfer', 'installment'].indexOf(a) - ['income', 'bill', 'allowance', 'transfer', 'installment'].indexOf(b)))
    const all = (await listPlan.run(world, { include_ended: true })) as { items: unknown[] }
    expect(all.items.length).toBe(world.snapshot.doc.plan_items.length)
    expect(out.categories.length).toBe(world.snapshot.doc.categories.length)
  })
})

describe('get_ledger', () => {
  it('gives the month’s rows with the balance after each, and the month’s totals', async () => {
    const out = (await getLedger.run(worldAt(abroad, '2026-10-16'), { account_id: 'main' })) as {
      month: string
      opening: { amount: string }
      closing: { amount: string }
      rows: { id: string; amount: { amount: string }; balance_after: { amount: string }; other_account_id: string | null; data_text: { description: string; category: string | null } }[]
      link: string
    }
    expect(out.month).toBe('2026-10')
    expect([out.opening.amount, out.closing.amount]).toEqual(['8000.00', '6450.00'])
    expect(out.rows.map((r) => [r.id, r.amount.amount, r.balance_after.amount, r.other_account_id, r.data_text.description, r.data_text.category])).toEqual([
      ['rent-now', '-900.00', '7100.00', null, 'Rent', null],
      ['topup-now-out', '-500.00', '6600.00', 'pesos', 'Top-up', null],
      ['groceries-4', '-90.00', '6510.00', null, 'Supermarket', 'Groceries'],
      ['groceries-5', '-60.00', '6450.00', null, 'Bakery', 'Groceries'],
    ])
    expect(out.link).toBe('http://localhost:8090/money/main?month=2026-10')
  })

  it('names an account the household does not have', () => {
    expect(() => getLedger.run(worldAt(abroad, '2026-10-16'), { account_id: 'nope' })).toThrow(new AgentError("No account 'nope' in this household. get_overview lists every account with its id."))
  })
})

describe('get_debt', () => {
  it('gives a card’s statement and this cycle’s payment figures, left to pay included', async () => {
    const out = (await getDebt.run(worldAt(abroad, '2026-10-16'), { account_id: 'rewards-card' })) as Record<string, unknown> & { current_statement: Record<string, unknown>; this_cycle: { pay_on: string; payment: Record<string, { amount: string } | string> } }
    expect(out.current_statement).toMatchObject({ id: 'rewards-last', source: 'entered', provisional: false, cut_date: '2026-09-20', due_date: '2026-10-16', total: { amount: '70000.00' } })
    expect(out.this_cycle.pay_on).toBe('2026-10-16')
    expect(out.this_cycle.payment).toMatchObject({ state: 'to_pay', paid: { amount: '25000.00' }, left_to_pay: { amount: '45000.00' } })
    expect(out.remaining_due).toEqual({ currency: 'PHP', amount: '45000.00', amount_minor: 4500000 })
    expect(out.latest_entered_statement_id).toBe('rewards-last')
  })

  it('marks a cycle whose cut passed with no statement as provisional', async () => {
    const out = (await getDebt.run(worldAt(abroad, '2026-10-23'), { account_id: 'rewards-card' })) as { current_statement: { id: string; provisional: boolean } }
    expect(out.current_statement).toMatchObject({ id: 'rewards-card:2026-10-20', provisional: true })
  })

  it('gives a loan’s owed balance and the next payment still to make', async () => {
    const out = (await getDebt.run(worldAt(usCardsCar, '2026-10-16'), { account_id: 'car-loan' })) as { account: { kind: string }; payment: { amount: string }; payment_day: number; next_payment: { on: string; due: { amount: string } } | null }
    expect(out.account.kind).toBe('loan')
    expect(out.payment.amount).toBe('355.58')
    expect(out.payment_day).toBe(20)
    expect(out.next_payment).toMatchObject({ on: '2026-10-20', due: { amount: '355.58' } })
  })

  it('sends a cash account to get_ledger', () => {
    expect(() => getDebt.run(worldAt(abroad, '2026-10-16'), { account_id: 'main' })).toThrow("'main' is a cash account")
  })
})

describe('user text', () => {
  it.each(['2026-10-16', '2026-10-23'])('is only ever in a data_text field (%s)', async (asOf) => {
    const world = worldAt(abroad, asOf)
    const typed = typedText(world.snapshot)
    const answers = await Promise.all([
      getOverview.run(world, {}),
      listOpen.run(world, { through_month: '2026-12' }),
      listPlan.run(world, { include_ended: true }),
      ...['main', 'tax', 'pesos'].map((id) => getLedger.run(world, { account_id: id })),
      ...['rewards-card', 'shopping-card'].map((id) => getDebt.run(world, { account_id: id })),
    ])
    expect(answers.flatMap((a) => typedOutside(a, typed))).toEqual([])
  })
})
