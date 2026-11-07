import { addDays, firstOfMonth, roll } from '../src/dates'
import { termsFromPreset } from '../src/presets'
import { link, relativeTo, row, transfer, type Sample } from './relative'

// Main sits just above its floor before payday and the card's second part is more than it can spare, so Pesos' top-up splits.
export function abroad(asOf: string): Sample {
  const { first, on, month, done } = relativeTo(asOf)
  const rewardsCut = on(-1, 20)
  const shoppingCut = on(-1, 25)
  const nextRewardsCut = asOf < on(0, 20) ? on(0, 20) : on(1, 20)
  const drawOn = addDays(nextRewardsCut, -2) > asOf ? addDays(nextRewardsCut, -2) : addDays(asOf, 1)
  const receivableOn = addDays(asOf, 10)
  const receivable = link('receivable', firstOfMonth(receivableOn))

  return {
    doc: {
      version: 1,
      household: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-PH', payoff_order: 'avalanche', track_from: first(-1) },
      accounts: [
        {
          id: 'main',
          name: 'Main',
          kind: 'cash',
          currency: 'EUR',
          opening_balance_minor: 646000,
          opening_date: first(-1),
          floor_windows: [
            { from_month: month(0), to_month: null, amount_minor: 600000 },
            { from_month: month(1), to_month: month(25), amount_minor: 300000 },
          ],
          fx_fee_pct: 0.007,
          sort_order: 0,
        },
        { id: 'tax', name: 'Tax', kind: 'cash', currency: 'EUR', opening_balance_minor: 120000, opening_date: first(-1), sort_order: 1 },
        {
          id: 'pesos',
          name: 'Pesos',
          kind: 'cash',
          currency: 'PHP',
          opening_balance_minor: 3225000,
          opening_date: first(-1),
          funded_from_account_id: 'main',
          floor_windows: [{ from_month: month(0), to_month: null, amount_minor: 2000000 }],
          sort_order: 2,
        },
        {
          id: 'rewards-card',
          name: 'Rewards card',
          kind: 'credit_card',
          currency: 'PHP',
          opening_balance_minor: -4200000,
          opening_date: first(-1),
          funded_from_account_id: 'pesos',
          terms: { ...termsFromPreset('PH-daily-unpaid', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'preceding' }), pay: { mode: 'in_full', on: 'due_date' } },
          sort_order: 3,
        },
        {
          id: 'shopping-card',
          name: 'Shopping card',
          kind: 'credit_card',
          currency: 'PHP',
          opening_balance_minor: -9000000,
          opening_date: first(-1),
          funded_from_account_id: 'pesos',
          terms: termsFromPreset('PH-round-up', { cut_day: 25, due: { days_after_cut: 21 }, due_roll: 'preceding' }),
          sort_order: 4,
        },
      ],
      categories: [
        { id: 'cat-dining', name: 'Dining' },
        { id: 'cat-groceries', name: 'Groceries' },
        { id: 'cat-home', name: 'Home' },
      ],
      plan_items: [
        { id: 'salary', kind: 'income', name: 'Salary', to_account_id: 'main', amount_minor: 400000, starts_on: on(-1, 28) },
        { id: 'rent', kind: 'bill', name: 'Rent', from_account_id: 'main', amount_minor: 90000, starts_on: first(-1), roll: 'following' },
        { id: 'tax-set-aside', kind: 'transfer', name: 'Tax set-aside', from_account_id: 'main', to_account_id: 'tax', amount_minor: 60000, starts_on: on(-1, 28) },
        { id: 'groceries', kind: 'allowance', name: 'Groceries', from_account_id: 'main', category_id: 'cat-groceries', amount_minor: 40000, starts_on: first(-1) },
        { id: 'groceries-credit', kind: 'allowance', name: 'Groceries credit', from_account_id: 'main', category_id: 'cat-groceries', amount_minor: -5000, every: 'once', starts_on: first(0) },
        { id: 'mobile', kind: 'bill', name: 'Mobile plan', from_account_id: 'pesos', amount_minor: 120000, starts_on: on(-1, 10) },
        { id: 'insurance', kind: 'bill', name: 'Insurance', from_account_id: 'pesos', amount_minor: 350000, starts_on: on(-1, 22), confidence: 'estimated' },
        { id: 'streaming', kind: 'bill', name: 'Streaming', from_account_id: 'rewards-card', amount_minor: 50000, starts_on: on(-1, 5) },
        { id: 'laptop', kind: 'installment', name: 'Laptop', from_account_id: 'rewards-card', amount_minor: 500000, starts_on: first(-4), ends_on: first(7) },
        { id: 'conversion', kind: 'installment', name: 'Balance conversion', from_account_id: 'shopping-card', amount_minor: 800000, starts_on: first(0), ends_on: first(11) },
        { id: 'cash-loan', kind: 'installment', name: 'Cash loan', from_account_id: 'shopping-card', amount_minor: 180000, starts_on: first(1), ends_on: first(12) },
        { id: 'cash-loan-draw', kind: 'income', name: 'Cash loan paid to the card', to_account_id: 'rewards-card', amount_minor: 2000000, every: 'once', starts_on: drawOn },
        { id: 'receivable', kind: 'income', name: 'Loan to a friend, repaid in slices', to_account_id: 'pesos', amount_minor: 600000, every: 'once', starts_on: receivableOn },
        { id: 'camera-sale', kind: 'income', name: 'Sell the old camera', to_account_id: 'pesos', amount_minor: 1500000, every: 'once', starts_on: on(1, 15), confidence: 'upside' },
      ],
      statements: [
        {
          id: 'rewards-last',
          account_id: 'rewards-card',
          cut_date: rewardsCut,
          due_date: roll(on(0, 16), 'preceding'),
          previous_balance_minor: 3800000,
          payments_and_credits_minor: 3800000,
          charges_minor: 6500000,
          installments_minor: 500000,
          interest_minor: 0,
          fees_minor: 0,
          total_due_minor: 7000000,
          minimum_due_minor: 210000,
          available_credit_minor: 3000000,
        },
        { id: 'shopping-last', account_id: 'shopping-card', cut_date: shoppingCut, due_date: roll(addDays(shoppingCut, 21), 'preceding'), total_due_minor: 8000000, minimum_due_minor: 280000 },
      ],
      transactions: [
        row('rent-last', 'main', first(-1), -90000, 'expense', 'Rent', link('rent', first(-1))),
        row('groceries-1', 'main', on(-1, 3), -12000, 'expense', 'Supermarket', { category_id: 'cat-groceries' }),
        ...transfer('topup-last', 'Top-up', ['main', on(-1, 10), 60000], ['pesos', on(-1, 10), 4170000]),
        row('groceries-2', 'main', on(-1, 14), -13000, 'expense', 'Supermarket', { category_id: 'cat-groceries' }),
        row('groceries-3', 'main', on(-1, 21), -11000, 'expense', 'Market', { category_id: 'cat-groceries' }),
        row('salary-last', 'main', on(-1, 28), 400000, 'income', 'Salary', link('salary', first(-1))),
        ...transfer('tax-last', 'Tax set-aside', ['main', on(-1, 28), 60000], ['tax', on(-1, 28), 60000], link('tax-set-aside', first(-1))),
        row('rent-now', 'main', first(0), -90000, 'expense', 'Rent', link('rent', first(0))),
        ...transfer('topup-now', 'Top-up', ['main', done(2), 50000], ['pesos', done(2), 3475000]),
        row('groceries-4', 'main', done(3), -9000, 'expense', 'Supermarket', { category_id: 'cat-groceries' }),
        row('groceries-5', 'main', done(6), -6000, 'expense', 'Bakery', { category_id: 'cat-groceries' }),

        row('mobile-last', 'pesos', on(-1, 8), -120000, 'expense', 'Mobile plan', link('mobile', first(-1))),
        ...transfer('rewards-paid-before', 'Rewards card payment', ['pesos', on(-1, 10), 3800000], ['rewards-card', on(-1, 11), 3800000]),
        ...transfer('shopping-paid-before', 'Shopping card payment', ['pesos', on(-1, 14), 1500000], ['shopping-card', on(-1, 15), 1500000]),
        row('insurance-last', 'pesos', on(-1, 22), -350000, 'expense', 'Insurance', link('insurance', first(-1))),
        row('receivable-slice-1', 'pesos', on(-1, 25), 100000, 'income', 'Repayment from a friend', receivable),
        ...transfer('rewards-part-1', 'Rewards card payment, part 1', ['pesos', on(-1, 27), 2500000], ['rewards-card', on(-1, 28), 2500000]),
        row('receivable-slice-2', 'pesos', done(6), 300000, 'income', 'Repayment from a friend', receivable),

        row('streaming-last', 'rewards-card', on(-1, 5), -50000, 'expense', 'Streaming'),
        row('appliance', 'rewards-card', on(-1, 6), -3000000, 'expense', 'Washing machine', { category_id: 'cat-home' }),
        row('dining-last', 'rewards-card', on(-1, 9), -1250000, 'expense', 'Dinners', { category_id: 'cat-dining' }),
        row('furniture', 'rewards-card', on(-1, 14), -1800000, 'expense', 'Desk and chair', { category_id: 'cat-home' }),
        row('dining-now', 'rewards-card', done(3), -150000, 'expense', 'Lunch', { category_id: 'cat-dining' }),
        row('streaming-now', 'rewards-card', done(5), -50000, 'expense', 'Streaming', link('streaming', first(0))),

        row('pharmacy-last', 'shopping-card', on(-1, 18), -500000, 'expense', 'Pharmacy'),
        row('conversion-credit', 'shopping-card', on(-1, 27), 9000000, 'drawdown', 'Balance conversion'),
        row('pharmacy-now', 'shopping-card', done(4), -250000, 'expense', 'Pharmacy'),
      ],
    },
    rates: [
      { quote: 'EUR', rate: 1, day: asOf },
      { quote: 'PHP', rate: 70, day: asOf },
    ],
  }
}
