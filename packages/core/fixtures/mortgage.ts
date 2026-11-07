import { roll } from '../src/dates'
import { link, relativeTo, row, transfer, type Sample } from './relative'

// A fixed-rate mortgage paid off after the projection, with escrow billed on its payment day and 200.00 extra a month.
export function mortgage(asOf: string): Sample {
  const { first, on, done } = relativeTo(asOf)
  const lastPayday = roll(on(-1, 25), 'preceding')

  return {
    doc: {
      version: 1,
      household: { base_currency: 'GBP', timezone: 'Europe/London', locale: 'en-GB', payoff_order: 'avalanche', track_from: first(-1) },
      accounts: [
        { id: 'current', name: 'Current account', kind: 'cash', currency: 'GBP', opening_balance_minor: 251500, opening_date: first(-1), sort_order: 0 },
        { id: 'savings', name: 'Savings', kind: 'cash', currency: 'GBP', opening_balance_minor: 1200000, opening_date: first(-1), sort_order: 1 },
        {
          id: 'mortgage',
          name: 'Mortgage',
          kind: 'loan',
          currency: 'GBP',
          opening_balance_minor: -18500000,
          opening_date: first(-1),
          funded_from_account_id: 'current',
          terms: { annual_rate: 0.0425, payment_minor: 100000, payment_day: 1 },
          sort_order: 2,
        },
      ],
      categories: [
        { id: 'cat-groceries', name: 'Groceries' },
        { id: 'cat-transport', name: 'Transport' },
      ],
      plan_items: [
        { id: 'salary', kind: 'income', name: 'Salary', to_account_id: 'current', amount_minor: 360000, starts_on: on(-1, 25), roll: 'preceding' },
        { id: 'escrow', kind: 'bill', name: 'Escrow', from_account_id: 'current', amount_minor: 18000, starts_on: first(-1) },
        { id: 'overpayment', kind: 'transfer', name: 'Mortgage overpayment', to_account_id: 'mortgage', amount_minor: 20000, starts_on: first(-1) },
        { id: 'council-tax', kind: 'bill', name: 'Council tax', from_account_id: 'current', amount_minor: 16000, starts_on: on(-1, 5) },
        { id: 'energy', kind: 'bill', name: 'Energy', from_account_id: 'current', amount_minor: 11000, starts_on: on(-1, 15), confidence: 'estimated' },
        { id: 'groceries', kind: 'allowance', name: 'Groceries', from_account_id: 'current', category_id: 'cat-groceries', amount_minor: 35000, starts_on: first(-1) },
        { id: 'transport', kind: 'allowance', name: 'Transport', from_account_id: 'current', category_id: 'cat-transport', amount_minor: 12000, starts_on: first(-1) },
      ],
      statements: [],
      transactions: [
        ...transfer('mortgage-last', 'Mortgage payment', ['current', first(-1), 100000], ['mortgage', first(-1), 100000]),
        row('escrow-last', 'current', first(-1), -18000, 'expense', 'Escrow', link('escrow', first(-1))),
        ...transfer('overpayment-last', 'Mortgage overpayment', ['current', first(-1), 20000], ['mortgage', first(-1), 20000], link('overpayment', first(-1))),
        row('council-tax-last', 'current', on(-1, 5), -16000, 'expense', 'Council tax', link('council-tax', first(-1))),
        row('groceries-1', 'current', on(-1, 6), -8500, 'expense', 'Supermarket', { category_id: 'cat-groceries' }),
        row('transport-1', 'current', on(-1, 8), -3000, 'expense', 'Train', { category_id: 'cat-transport' }),
        row('groceries-2', 'current', on(-1, 13), -9000, 'expense', 'Supermarket', { category_id: 'cat-groceries' }),
        row('energy-last', 'current', on(-1, 15), -11000, 'expense', 'Energy', link('energy', first(-1))),
        row('groceries-3', 'current', on(-1, 20), -8000, 'expense', 'Supermarket', { category_id: 'cat-groceries' }),
        row('transport-2', 'current', on(-1, 22), -4000, 'expense', 'Bus pass', { category_id: 'cat-transport' }),
        row('salary-last', 'current', lastPayday, 360000, 'income', 'Salary', link('salary', first(-1))),
        row('groceries-4', 'current', on(-1, 27), -7500, 'expense', 'Market', { category_id: 'cat-groceries' }),
        ...transfer('mortgage-now', 'Mortgage payment', ['current', first(0), 100000], ['mortgage', first(0), 100000]),
        row('escrow-now', 'current', first(0), -18000, 'expense', 'Escrow', link('escrow', first(0))),
        ...transfer('overpayment-now', 'Mortgage overpayment', ['current', first(0), 20000], ['mortgage', first(0), 20000], link('overpayment', first(0))),
        row('groceries-5', 'current', done(4), -9000, 'expense', 'Supermarket', { category_id: 'cat-groceries' }),
        row('council-tax-now', 'current', done(5), -16000, 'expense', 'Council tax', link('council-tax', first(0))),
        row('transport-3', 'current', done(6), -3500, 'expense', 'Train', { category_id: 'cat-transport' }),
      ],
    },
    rates: [
      { quote: 'EUR', rate: 1, day: asOf },
      { quote: 'GBP', rate: 0.86, day: asOf },
    ],
  }
}
