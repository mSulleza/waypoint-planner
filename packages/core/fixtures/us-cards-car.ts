import { addDays, roll } from '../src/dates'
import { termsFromPreset } from '../src/presets'
import type { CardTerms } from '../src/schema/terms'
import { link, relativeTo, row, transfer, type Sample } from './relative'

function usCard(cut_day: number, due_day: number, rate: number, floor_minor: number): CardTerms {
  const terms = termsFromPreset('US-generic', { cut_day, due: { day_of_month: due_day }, due_roll: 'none' })
  return { ...terms, interest: { ...terms.interest, rate }, minimum: { ...terms.minimum, floor_minor } }
}

// Two cards paying minimums while carrying balances, 300.00 extra a month in payoff order, then a 60-month car loan.
export function usCardsCar(asOf: string): Sample {
  const { first, on, month, done } = relativeTo(asOf)
  const payday = addDays(asOf, -21)
  const nextPayday = addDays(payday, 14)

  return {
    doc: {
      version: 1,
      household: { base_currency: 'USD', timezone: 'America/Chicago', locale: 'en-US', payoff_order: 'avalanche', track_from: first(-1) },
      accounts: [
        {
          id: 'checking',
          name: 'Checking',
          kind: 'cash',
          currency: 'USD',
          opening_balance_minor: 211558,
          opening_date: first(-1),
          funded_from_account_id: 'savings',
          floor_windows: [{ from_month: month(0), to_month: null, amount_minor: 50000 }],
          sort_order: 0,
        },
        { id: 'savings', name: 'Savings', kind: 'cash', currency: 'USD', opening_balance_minor: 400000, opening_date: first(-1), sort_order: 1 },
        {
          id: 'travel-card',
          name: 'Travel card',
          kind: 'credit_card',
          currency: 'USD',
          opening_balance_minor: -208000,
          opening_date: first(-1),
          funded_from_account_id: 'checking',
          terms: usCard(20, 16, 0.2499, 8000),
          sort_order: 2,
        },
        {
          id: 'store-card',
          name: 'Store card',
          kind: 'credit_card',
          currency: 'USD',
          opening_balance_minor: -460000,
          opening_date: first(-1),
          funded_from_account_id: 'checking',
          terms: usCard(24, 18, 0.1999, 3500),
          sort_order: 3,
        },
        {
          id: 'car-loan',
          name: 'Car loan',
          kind: 'loan',
          currency: 'USD',
          opening_balance_minor: -1800000,
          opening_date: first(-1),
          funded_from_account_id: 'checking',
          terms: { annual_rate: 0.069, payment_minor: 35558, payment_day: 20 },
          sort_order: 4,
        },
      ],
      categories: [{ id: 'cat-groceries', name: 'Groceries' }],
      plan_items: [
        { id: 'paycheck', kind: 'income', name: 'Paycheck', to_account_id: 'checking', amount_minor: 210000, every: '2weeks', starts_on: payday, roll: 'preceding' },
        { id: 'rent', kind: 'bill', name: 'Rent', from_account_id: 'checking', amount_minor: 150000, starts_on: first(-1) },
        { id: 'utilities', kind: 'bill', name: 'Utilities', from_account_id: 'checking', amount_minor: 18000, starts_on: on(-1, 12), confidence: 'estimated' },
        { id: 'groceries', kind: 'allowance', name: 'Groceries', from_account_id: 'checking', category_id: 'cat-groceries', amount_minor: 50000, starts_on: first(-1) },
        { id: 'extra', kind: 'transfer', name: 'Extra for debts', from_account_id: 'checking', amount_minor: 30000, starts_on: first(0) },
      ],
      statements: [
        {
          id: 'travel-last',
          account_id: 'travel-card',
          cut_date: on(-1, 20),
          due_date: on(0, 16),
          previous_balance_minor: 208000,
          payments_and_credits_minor: 8000,
          charges_minor: 0,
          installments_minor: 0,
          interest_minor: 4250,
          fees_minor: 0,
          total_due_minor: 204250,
          minimum_due_minor: 8000,
          available_credit_minor: 295750,
        },
        {
          id: 'store-last',
          account_id: 'store-card',
          cut_date: on(-1, 24),
          due_date: on(0, 18),
          previous_balance_minor: 460000,
          payments_and_credits_minor: 12000,
          charges_minor: 3500,
          installments_minor: 0,
          interest_minor: 7620,
          fees_minor: 0,
          total_due_minor: 459120,
          minimum_due_minor: 12211,
          available_credit_minor: 340880,
        },
      ],
      transactions: [
        row('rent-last', 'checking', first(-1), -150000, 'expense', 'Rent', link('rent', first(-1))),
        row('groceries-1', 'checking', on(-1, 4), -11000, 'expense', 'Grocery store', { category_id: 'cat-groceries' }),
        row('groceries-2', 'checking', on(-1, 11), -13000, 'expense', 'Grocery store', { category_id: 'cat-groceries' }),
        row('utilities-last', 'checking', on(-1, 12), -18000, 'expense', 'Utilities', link('utilities', first(-1))),
        ...transfer('travel-paid', 'Travel card minimum', ['checking', on(-1, 14), 8000], ['travel-card', on(-1, 15), 8000]),
        ...transfer('store-paid', 'Store card minimum', ['checking', on(-1, 16), 12000], ['store-card', on(-1, 17), 12000]),
        row('groceries-3', 'checking', on(-1, 19), -12000, 'expense', 'Grocery store', { category_id: 'cat-groceries' }),
        ...transfer('car-paid', 'Car payment', ['checking', on(-1, 20), 35558], ['car-loan', on(-1, 20), 35558]),
        row('groceries-4', 'checking', on(-1, 26), -10000, 'expense', 'Farmers market', { category_id: 'cat-groceries' }),
        row('paycheck-1', 'checking', roll(payday, 'preceding'), 210000, 'income', 'Paycheck', link('paycheck', payday)),
        row('paycheck-2', 'checking', roll(nextPayday, 'preceding'), 210000, 'income', 'Paycheck', link('paycheck', nextPayday)),
        row('rent-now', 'checking', first(0), -150000, 'expense', 'Rent', link('rent', first(0))),
        row('groceries-5', 'checking', done(3), -12000, 'expense', 'Grocery store', { category_id: 'cat-groceries' }),
        row('gas', 'store-card', on(-1, 9), -3500, 'expense', 'Gas'),
      ],
    },
    rates: [
      { quote: 'EUR', rate: 1, day: asOf },
      { quote: 'USD', rate: 1.17, day: asOf },
    ],
  }
}
