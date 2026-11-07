import { addDays, roll } from '../../src/dates'
import { termsFromPreset } from '../../src/presets'
import { relativeTo, row, transfer, type Sample } from '../relative'
import { cardHousehold } from './card-household'

// Made-up statement shapes at a made-up scale, dated from asOf; real statements calibrate the presets privately, never here.

// Interest daily on the unpaid statement balance: two entered statements, the last checked and partly paid, with an installment running.
export function revolvingDaily(asOf: string): Sample {
  const { first, on } = relativeTo(asOf)
  const k = asOf >= on(0, 20) ? 0 : -1
  const [priorCut, lastCut] = [on(k - 1, 20), on(k, 20)]
  return cardHousehold({
    asOf,
    terms: termsFromPreset('PH-daily-unpaid', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'preceding' }),
    opening_balance_minor: -2400000,
    opening_date: addDays(priorCut, 1),
    statements: [
      { id: 'prior', account_id: 'card', cut_date: priorCut, due_date: roll(on(k, 16), 'preceding'), total_due_minor: 2400000, minimum_due_minor: 72000 },
      {
        id: 'last',
        account_id: 'card',
        cut_date: lastCut,
        due_date: roll(on(k + 1, 16), 'preceding'),
        previous_balance_minor: 2400000,
        payments_and_credits_minor: 1000000,
        charges_minor: 1400000,
        installments_minor: 150000,
        interest_minor: 50000,
        fees_minor: 0,
        total_due_minor: 3000000,
        minimum_due_minor: 90000,
        available_credit_minor: 2000000,
      },
    ],
    transactions: [
      row('groceries', 'card', addDays(priorCut, 3), -600000, 'expense', 'Groceries', { category_id: 'cat-shops' }),
      ...transfer('paid-prior', 'Card payment', ['cash', addDays(priorCut, 10), 1000000], ['card', addDays(priorCut, 10), 1000000]),
      row('repairs', 'card', addDays(priorCut, 15), -800000, 'expense', 'Repairs'),
    ],
    plan_items: [{ id: 'gadget', kind: 'installment', name: 'Gadget', from_account_id: 'card', amount_minor: 150000, starts_on: first(k - 2), ends_on: first(k + 3) }],
  })
}

// Interest on the average daily balance: a balance conversion credits more than the statement owes, and its installments start at the next cut beside an older one.
export function conversionClears(asOf: string): Sample {
  const { first, on } = relativeTo(asOf)
  const k = asOf >= on(0, 25) ? 0 : -1
  const lastCut = on(k, 25)
  return cardHousehold({
    asOf,
    terms: termsFromPreset('PH-round-up', { cut_day: 25, due: { days_after_cut: 21 }, due_roll: 'preceding' }),
    opening_balance_minor: -5000000,
    opening_date: lastCut,
    statements: [{ id: 'last', account_id: 'card', cut_date: lastCut, due_date: roll(addDays(lastCut, 21), 'preceding'), total_due_minor: 5000000, minimum_due_minor: 175000 }],
    transactions: [row('conversion-credit', 'card', addDays(lastCut, 2), 6000000, 'drawdown', 'Balance conversion'), row('shoes', 'card', addDays(lastCut, 5), -300000, 'expense', 'Shoes', { category_id: 'cat-shops' })],
    plan_items: [
      { id: 'conversion', kind: 'installment', name: 'Balance conversion', from_account_id: 'card', amount_minor: 520000, starts_on: first(k + 1), ends_on: first(k + 12) },
      { id: 'phone', kind: 'installment', name: 'Phone', from_account_id: 'card', amount_minor: 100000, starts_on: first(k - 4), ends_on: first(k + 4) },
    ],
  })
}

// Interest on the average daily balance at a yearly rate: the statement before the last cut is entered and partly paid, the last cut has none.
export function missedCut(asOf: string): Sample {
  const { on } = relativeTo(asOf)
  const k = asOf >= on(0, 5) ? 0 : -1
  const enteredCut = on(k - 1, 5)
  return cardHousehold({
    asOf,
    currency: 'USD',
    terms: termsFromPreset('US-generic', { cut_day: 5, due: { day_of_month: 28 }, due_roll: 'none' }),
    opening_balance_minor: -800000,
    opening_date: enteredCut,
    statements: [
      {
        id: 'entered',
        account_id: 'card',
        cut_date: enteredCut,
        due_date: on(k - 1, 28),
        previous_balance_minor: 700000,
        payments_and_credits_minor: 200000,
        charges_minor: 290000,
        installments_minor: 0,
        interest_minor: 10000,
        fees_minor: 0,
        total_due_minor: 800000,
        minimum_due_minor: 18000,
      },
    ],
    transactions: [
      ...transfer('paid-part', 'Card payment', ['cash', on(k - 1, 20), 300000], ['card', on(k - 1, 20), 300000]),
      row('flights', 'card', on(k - 1, 25), -120000, 'expense', 'Flights', { category_id: 'cat-shops' }),
    ],
  })
}
