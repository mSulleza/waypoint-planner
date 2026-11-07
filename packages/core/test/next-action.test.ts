import { describe, expect, it } from 'vitest'
import { abroad, cardHousehold, mortgage, usCardsCar } from '../fixtures'
import type { StatementInput } from '../fixtures/relative'
import { debtFigures } from '../src/engine/debt-figures'
import { NOTHING_TO_DO } from '../src/next-action'
import { termsFromPreset } from '../src/presets'
import type { CardTerms } from '../src/schema/terms'
import { buildSnapshot } from '../src/snapshot'
import { advise, sampleAt } from './advice-helpers'
import { account, cashHousehold } from './walk-helpers'

const line = (lines: readonly { id: string; amount_minor: number }[], id: string) => {
  const found = lines.find((l) => l.id === id)
  if (!found) throw new Error(`No line '${id}'`)
  return found.amount_minor
}

describe('next action', () => {
  it('sends the walk to_send top-up of today, with what the next one this month sends, never sizing either', async () => {
    const a = await advise(sampleAt(abroad, '2026-10-16'))
    const sent = 0 - line(a.walk.lines, 'top-up:main>pesos:2026-10-16#out')
    const later = 0 - line(a.walk.lines, 'top-up:main>pesos:2026-10-28#out')
    expect([sent, later]).toEqual([43750, 10487])
    expect([a.next.kind, a.say(a.next.title), a.say(a.next.context), a.next.prefill, a.next.route]).toEqual([
      'send',
      'Send €437.50 → Pesos',
      'and €104.87 more on 2026-10-28',
      { from_account_id: 'main', to_account_id: 'pesos', sent: { minor: sent, currency: 'EUR' }, received: null },
      { tab: 'today', sheet: 'add', account_id: 'main' },
    ])
  })

  it('names the earliest top-up or card payment still to come this month when nothing is due now, dated by its day', async () => {
    // Before the day of the first top-up, that top-up leads, with the next one on its route as its later line.
    const early = await advise(sampleAt(abroad, '2026-10-07'))
    const first = 0 - line(early.walk.lines, 'top-up:main>pesos:2026-10-16#out')
    expect([early.walk.lines.filter((l) => l.flags.includes('to_send')).length, early.next.kind, early.next.act_by, early.say(early.next.title), early.say(early.next.context)]).toEqual([4, 'send', '2026-10-16', `Send €${(first / 100).toFixed(2)} → Pesos`, 'and €172.37 more on 2026-10-28'])
    // A card paid on its due day leads from the start of the month, as the statement is already in.
    const card = await advise(sampleAt(usCardsCar, '2026-10-10'))
    expect([card.next.kind, card.say(card.next.title), card.say(card.next.context), card.next.act_by]).toEqual(['pay', 'Pay $80.00 → Travel card', 'The plan pays $80.00 of the $2,042.50 due. It is due 2026-10-16.', '2026-10-16'])
    // Nothing left this month: nothing to do now, with no reassurance while an account is short.
    const done = await advise(sampleAt(mortgage, '2026-10-10'))
    expect([done.next.kind, done.next.act_by]).toEqual(['none', null])
  })

  it('asks for the statement of a card paid the day after its cut until it is entered, then pays left to pay', async () => {
    const base = termsFromPreset('PH-daily-unpaid', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'preceding' })
    const terms: CardTerms = { ...base, pay: { ...base.pay, on: { days_after_cut: 1 } } }
    const october: StatementInput = { id: 'oct', account_id: 'card', cut_date: '2026-10-20', due_date: '2026-11-16', total_due_minor: 300000, minimum_due_minor: 9000 }
    const build = (entered: boolean) => {
      const { doc, rates } = cardHousehold({
        asOf: '2026-10-21',
        terms,
        opening_balance_minor: -500000,
        opening_date: '2026-08-21',
        statements: [{ id: 'sep', account_id: 'card', cut_date: '2026-09-20', due_date: '2026-10-16', total_due_minor: 500000, minimum_due_minor: 15000 }, ...(entered ? [october] : [])],
        transactions: [
          { id: 'paid-out', account_id: 'cash', posted_on: '2026-10-02', amount_minor: -500000, kind: 'transfer', transfer_id: 'paid' },
          { id: 'paid-in', account_id: 'card', posted_on: '2026-10-02', amount_minor: 500000, kind: 'transfer', transfer_id: 'paid' },
          { id: 'shoes', account_id: 'card', posted_on: '2026-10-05', amount_minor: -300000, kind: 'expense', category_id: 'cat-shops' },
        ],
      })
      return buildSnapshot(doc, '2026-10-21', rates)
    }
    const missing = await advise(build(false))
    expect([missing.next.kind, missing.say(missing.next.title), missing.next.review_id, missing.next.subject, missing.next.route]).toEqual([
      'enter_statement',
      'Enter the Card statement',
      'statement_to_enter:card:2026-10-20',
      { review_id: 'statement_to_enter:card:2026-10-20' },
      { tab: 'today', sheet: 'statement', account_id: 'card' },
    ])
    expect(missing.review.map((r) => r.id)).toEqual(['statement_to_enter:card:2026-10-20'])

    const entered = await advise(build(true))
    const left = debtFigures(entered.snapshot, entered.walk).cards[0]?.payment?.left_to_pay_minor
    expect([left, line(entered.walk.lines, 'payment:card:2026-10-20#in')]).toEqual([9000, 9000])
    expect([entered.next.kind, entered.say(entered.next.title), entered.say(entered.next.context), entered.next.prefill]).toEqual([
      'pay',
      'Pay ₱90.00 → Card',
      'The plan pays ₱90.00 of the ₱3,000.00 due. It is due 2026-11-16.',
      { from_account_id: 'cash', to_account_id: 'card', sent: { minor: 9000, currency: 'PHP' }, received: { minor: 9000, currency: 'PHP' } },
    ])
  })

  it('pays an overdue card before one whose pay day is today', async () => {
    const today = await advise(sampleAt(usCardsCar, '2026-10-16'))
    expect(today.say(today.next.title)).toBe('Pay $80.00 → Travel card')
    const both = await advise(sampleAt(usCardsCar, '2026-10-18'))
    const cards = debtFigures(both.snapshot, both.walk).cards.map((c) => [c.account_id, c.pay_on, c.payment?.left_to_pay_minor])
    expect(cards).toEqual([
      ['store-card', '2026-10-18', 12211],
      ['travel-card', '2026-10-18', 8000],
    ])
    expect([both.say(both.next.title), both.say(both.next.context), both.next.act_by]).toEqual(['Pay $80.00 → Travel card', 'The plan pays $80.00 of the $2,042.50 due. It was due 2026-10-16.', '2026-10-16'])
  })

  it('falls back to any other statement to enter, then the first review item', async () => {
    const statement = await advise(sampleAt(abroad, '2026-10-23'))
    expect([statement.next.kind, statement.say(statement.next.title), statement.next.review_id, statement.next.route]).toEqual([
      'enter_statement',
      'Enter the Rewards card statement',
      'statement_to_enter:rewards-card:2026-10-20',
      { tab: 'today', sheet: 'statement', account_id: 'rewards-card' },
    ])
    const bill = await advise(sampleAt(mortgage, '2026-10-16'))
    expect([bill.next.kind, bill.say(bill.next.title), bill.say(bill.next.context), bill.next.subject, bill.next.route]).toEqual([
      'review',
      'Pay or skip an overdue bill',
      'Energy: £110.00 from Current account was due on 2026-10-15.',
      { review_id: 'overdue_outflow:energy:2026-10-01' },
      { tab: 'months', month: '2026-10', account_id: 'current', segment: 'todo' },
    ])
  })

  it('reassures about this month only when its projection keeps every account at or above a target it has', async () => {
    const household = (bill: number) =>
      cashHousehold('2026-10-07', (doc) => {
        account(doc, 'bank').floor_windows = [{ from_month: '2026-10', to_month: null, amount_minor: 100000 }]
        account(doc, 'savings').floor_windows = [{ from_month: '2026-10', to_month: null, amount_minor: 50000 }]
        account(doc, 'pesos').floor_windows = [{ from_month: '2026-10', to_month: null, amount_minor: 0 }]
        if (bill > 0) doc.plan_items.push({ id: 'repair', kind: 'bill', name: 'Repair', from_account_id: 'bank', amount_minor: bill, every: 'once', starts_on: '2026-10-20' })
      })
    const steady = await advise(household(0))
    expect([steady.say(steady.next.title), steady.say(steady.next.context)]).toEqual([NOTHING_TO_DO, 'Every account stays at or above its floor this month.'])
    const short = await advise(household(450000))
    expect([short.next.kind, short.next.context]).toEqual(['none', []])
  })
})
