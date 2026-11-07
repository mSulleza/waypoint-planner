import { describe, expect, it } from 'vitest'
import { termsFromPreset } from '../src/presets'
import { checkInput } from '../src/schema/common'
import { accountRow, categoryRow, floorAndTarget, householdRow, planItemRow, statementGap, statementRow, transactionRow } from '../src/schema/rows'
import type { z } from 'zod'

const errorsOf = (schema: z.ZodType, input: unknown) => {
  const result = checkInput(schema, input)
  return result.ok ? [] : result.errors
}

const without = (row: object, key: string) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== key))

const cash = { id: 'main', name: 'Main', kind: 'cash', currency: 'EUR', opening_date: '2026-09-01' }
const card = {
  id: 'card',
  name: 'Card',
  kind: 'credit_card',
  currency: 'USD',
  opening_balance_minor: -120000,
  opening_date: '2026-09-01',
  funded_from_account_id: 'main',
  terms: termsFromPreset('US-generic', { cut_day: 5, due: { days_after_cut: 25 }, due_roll: 'none' }),
}
const loan = { ...card, id: 'car', name: 'Car loan', kind: 'loan', terms: { annual_rate: 0.069, payment_minor: 38000, payment_day: 12 } }

describe('householdRow', () => {
  it('fills payoff_order with avalanche and refuses an unknown time zone and a malformed locale', () => {
    expect(householdRow.parse({ base_currency: 'EUR', timezone: 'Europe/Lisbon', locale: 'en-IE', track_from: '2026-08-01' })).toEqual({
      base_currency: 'EUR',
      timezone: 'Europe/Lisbon',
      locale: 'en-IE',
      payoff_order: 'avalanche',
      track_from: '2026-08-01',
    })
    expect(errorsOf(householdRow, { base_currency: 'eur', timezone: 'Mars/Base', locale: 'en_PH', payoff_order: 'snowball', track_from: '2026-02-30' })).toEqual([
      'base_currency: must be a three-letter ISO 4217 code such as EUR',
      'timezone: must be an IANA time zone such as Europe/Madrid',
      'locale: must be a BCP 47 tag such as en-PH',
      expect.stringMatching(/^payoff_order: /),
      'track_from: must be a real YYYY-MM-DD date',
    ])
  })
})

describe('accountRow', () => {
  it('fills a cash account’s defaults and keeps a null fee apart from a zero fee', () => {
    expect(accountRow.parse(cash)).toEqual({
      ...cash,
      opening_balance_minor: 0,
      csv_mapping: null,
      sort_order: 0,
      archived_at: null,
      terms: null,
      funded_from_account_id: null,
      floor_windows: [],
      fx_fee_pct: null,
    })
    expect(accountRow.parse({ ...cash, fx_fee_pct: 0 }).fx_fee_pct).toBe(0)
    expect(accountRow.parse({ ...cash, fx_fee_pct: 0.007 }).fx_fee_pct).toBe(0.007)
    expect(errorsOf(accountRow, { ...cash, fx_fee_pct: 0.7 })).toEqual(['fx_fee_pct: must be a fraction below 0.2, such as 0.007; percent and fraction never mix'])
  })

  it('needs funded_from_account_id on a debt, and no account funds itself', () => {
    expect(accountRow.parse(card).kind).toBe('credit_card')
    expect(accountRow.parse(loan).kind).toBe('loan')
    expect(errorsOf(accountRow, without(card, 'funded_from_account_id'))).toEqual(['funded_from_account_id: a debt needs the cash account that pays it'])
    expect(errorsOf(accountRow, { ...cash, funded_from_account_id: 'main' })).toEqual(['funded_from_account_id: an account cannot fund itself'])
    expect(accountRow.parse({ ...cash, funded_from_account_id: 'savings' }).funded_from_account_id).toBe('savings')
  })

  it('keeps terms on debts and floor windows and fx_fee_pct on cash accounts', () => {
    expect(errorsOf(accountRow, { ...cash, terms: card.terms })).toEqual(['terms: terms are for credit cards and loans only'])
    expect(errorsOf(accountRow, { ...card, terms: null })[0]).toMatch(/^terms: /)
    expect(errorsOf(accountRow, { ...card, terms: loan.terms })).toContainEqual(expect.stringMatching(/^terms: Unknown keys 'annual_rate', 'payment_minor', 'payment_day'; allowed keys: cut_day, /))
    expect(errorsOf(accountRow, { ...card, floor_windows: [{ from_month: '2026-10', to_month: null, amount_minor: 1000 }], fx_fee_pct: 0.01 })).toEqual([
      'floor_windows: floor windows are for cash accounts only',
      'fx_fee_pct: fx_fee_pct is for cash accounts only',
    ])
    expect(errorsOf(accountRow, { ...cash, kind: 'wallet' })[0]).toMatch(/^kind: /)
  })

  it('checks each floor window: months, an open end and no end before its start', () => {
    const windows = [
      { from_month: '2026-10', to_month: null, amount_minor: 600000 },
      { from_month: '2026-11', to_month: '2028-12', amount_minor: 300000 },
    ]
    const parsed = accountRow.parse({ ...cash, floor_windows: windows })
    expect(parsed.kind === 'cash' ? parsed.floor_windows : null).toEqual(windows)
    expect(errorsOf(accountRow, { ...cash, floor_windows: [{ from_month: '2026-11', to_month: '2026-10', amount_minor: -1 }, { from_month: '2026-13', amount_minor: 5 }] })).toEqual([
      'floor_windows[0].amount_minor: must not be negative',
      'floor_windows[0].to_month: must not be before from_month',
      'floor_windows[1].from_month: must be a YYYY-MM month',
      expect.stringMatching(/^floor_windows\[1\]\.to_month: /),
    ])
  })
})

describe('floorAndTarget', () => {
  it('takes the smallest covering window as the floor and the largest as the target, both 0 with none', () => {
    const windows = [
      { from_month: '2026-10', to_month: null, amount_minor: 600000 },
      { from_month: '2026-11', to_month: '2028-12', amount_minor: 300000 },
    ]
    expect(floorAndTarget(windows, '2026-09')).toEqual({ floor: 0, target: 0 })
    expect(floorAndTarget(windows, '2026-10')).toEqual({ floor: 600000, target: 600000 })
    expect(floorAndTarget(windows, '2026-11-15')).toEqual({ floor: 300000, target: 600000 })
    expect(floorAndTarget(windows, '2028-12')).toEqual({ floor: 300000, target: 600000 })
    expect(floorAndTarget(windows, '2029-01')).toEqual({ floor: 600000, target: 600000 })
    expect(floorAndTarget([], '2026-10')).toEqual({ floor: 0, target: 0 })
  })
})

describe('categoryRow', () => {
  it('needs a name of 1 to 40 characters', () => {
    expect(categoryRow.parse({ id: 'groceries', name: 'Groceries' })).toEqual({ id: 'groceries', name: 'Groceries', archived_at: null })
    expect(errorsOf(categoryRow, { id: 'x', name: '' })).toEqual(['name: must not be empty'])
    expect(errorsOf(categoryRow, { id: 'x', name: 'x'.repeat(41) })).toEqual(['name: must be at most 40 characters'])
  })
})

const tx = { id: 't1', account_id: 'main', posted_on: '2026-10-03', amount_minor: -4250, kind: 'expense' }

describe('transactionRow', () => {
  it('fills the defaults of an unlinked expense', () => {
    expect(transactionRow.parse(tx)).toEqual({
      ...tx,
      category_id: null,
      description: '',
      transfer_id: null,
      plan_item_id: null,
      period: null,
      external_id: null,
      batch_id: null,
    })
  })

  it('signs income, refunds and drawdowns in and expenses out, and refuses zero or a fraction', () => {
    for (const kind of ['income', 'refund', 'drawdown']) {
      expect(errorsOf(transactionRow, { ...tx, kind, amount_minor: 1000 })).toEqual([])
      expect(errorsOf(transactionRow, { ...tx, kind, amount_minor: -1000 })).toEqual([`amount_minor: ${kind} is money in, so it must be positive`])
    }
    expect(errorsOf(transactionRow, { ...tx, amount_minor: 1000 })).toEqual(['amount_minor: an expense is money out, so it must be negative'])
    expect(errorsOf(transactionRow, { ...tx, kind: 'adjustment', amount_minor: 1000 })).toEqual([])
    expect(errorsOf(transactionRow, { ...tx, kind: 'adjustment', amount_minor: -1000 })).toEqual([])
    expect(errorsOf(transactionRow, { ...tx, amount_minor: 0 })).toEqual(['amount_minor: must not be 0'])
    expect(errorsOf(transactionRow, { ...tx, amount_minor: -42.5 })).toEqual(['amount_minor: must be a whole number of minor units'])
  })

  it('takes a category only on an expense or a refund', () => {
    expect(errorsOf(transactionRow, { ...tx, category_id: 'groceries' })).toEqual([])
    expect(errorsOf(transactionRow, { ...tx, kind: 'refund', amount_minor: 500, category_id: 'groceries' })).toEqual([])
    expect(errorsOf(transactionRow, { ...tx, kind: 'income', amount_minor: 500, category_id: 'groceries' })).toEqual(['category_id: only an expense or a refund takes a category'])
  })

  it('has a transfer_id exactly when it is a transfer', () => {
    expect(errorsOf(transactionRow, { ...tx, kind: 'transfer' })).toEqual(['transfer_id: a transfer needs the transfer_id its two legs share'])
    expect(errorsOf(transactionRow, { ...tx, transfer_id: 'x1' })).toEqual(['transfer_id: only a transfer has a transfer_id'])
    expect(errorsOf(transactionRow, { ...tx, kind: 'transfer', transfer_id: 'x1' })).toEqual([])
  })

  it('links with plan_item_id and period both or neither, and a transfer only by its negative leg', () => {
    expect(errorsOf(transactionRow, { ...tx, plan_item_id: 'rent' })).toEqual(['period: plan_item_id and period come together: both or neither'])
    expect(errorsOf(transactionRow, { ...tx, period: '2026-10-01' })).toEqual(['plan_item_id: plan_item_id and period come together: both or neither'])
    expect(errorsOf(transactionRow, { ...tx, plan_item_id: 'rent', period: '2026-10-01' })).toEqual([])
    const leg = { ...tx, kind: 'transfer', transfer_id: 'x1', plan_item_id: 'save', period: '2026-10-01' }
    expect(errorsOf(transactionRow, leg)).toEqual([])
    expect(errorsOf(transactionRow, { ...leg, amount_minor: 4250 })).toEqual(['plan_item_id: a transfer links by its outgoing (negative) leg'])
  })
})

const item = { id: 'rent', kind: 'bill', name: 'Rent', from_account_id: 'main', amount_minor: 90000, starts_on: '2026-10-01' }
const installment = { id: 'tv', kind: 'installment', name: 'TV', from_account_id: 'card', amount_minor: 2500, starts_on: '2026-06-01', ends_on: '2027-05-01' }

describe('planItemRow', () => {
  it('fills the defaults of a monthly bill', () => {
    expect(planItemRow.parse(item)).toEqual({
      ...item,
      to_account_id: null,
      category_id: null,
      every: 'month',
      ends_on: null,
      roll: 'none',
      confidence: 'committed',
      stops_with_income: false,
      skip_periods: [],
    })
  })

  it('lets only a bill or an allowance stop with income', () => {
    expect(errorsOf(planItemRow, { ...item, stops_with_income: true })).toEqual([])
    expect(errorsOf(planItemRow, { ...item, kind: 'allowance', category_id: 'groceries', stops_with_income: true })).toEqual([])
    const refused = ['stops_with_income: only a bill or an allowance takes it: income and transfers always stop with income, an installment never does']
    expect(errorsOf(planItemRow, { ...item, kind: 'income', from_account_id: null, to_account_id: 'main', stops_with_income: true })).toEqual(refused)
    expect(errorsOf(planItemRow, { ...item, kind: 'transfer', to_account_id: 'savings', stops_with_income: true })).toEqual(refused)
    expect(errorsOf(planItemRow, { ...installment, stops_with_income: true })).toEqual(refused)
  })

  it('refuses a bill with a category and an allowance without one', () => {
    expect(errorsOf(planItemRow, { ...item, category_id: 'housing' })).toEqual(['category_id: only an allowance takes a category'])
    expect(errorsOf(planItemRow, { ...item, kind: 'allowance' })).toEqual(['category_id: an allowance needs the category it budgets'])
    expect(errorsOf(planItemRow, { ...item, kind: 'allowance', category_id: 'groceries' })).toEqual([])
  })

  it('lets only an allowance be negative, and nothing be zero', () => {
    expect(errorsOf(planItemRow, { ...item, kind: 'allowance', category_id: 'groceries', amount_minor: -5000 })).toEqual([])
    expect(errorsOf(planItemRow, { ...item, kind: 'allowance', category_id: 'groceries', amount_minor: 0 })).toEqual(['amount_minor: must not be 0'])
    expect(errorsOf(planItemRow, { ...item, amount_minor: -5000 })).toEqual(['amount_minor: must be more than 0; only an allowance may be negative'])
    expect(errorsOf(planItemRow, { ...item, amount_minor: 0 })).toEqual(['amount_minor: must be more than 0; only an allowance may be negative'])
  })

  it('refuses an installment whose ends_on is not a first of month', () => {
    expect(planItemRow.parse(installment).ends_on).toBe('2027-05-01')
    expect(errorsOf(planItemRow, { ...installment, ends_on: '2027-05-20' })).toEqual(['ends_on: an installment ends on its last billed month, as the first of the month'])
  })

  it('bills an installment monthly from a first-of-month start to a stated end', () => {
    expect(errorsOf(planItemRow, { ...without(installment, 'ends_on'), every: 'week', starts_on: '2026-06-15' })).toEqual([
      'every: an installment bills every month',
      'starts_on: an installment starts on its first billed month, as the first of the month',
      'ends_on: an installment needs its last billed month',
    ])
    expect(errorsOf(planItemRow, { ...installment, ends_on: '2026-05-01' })).toEqual(['ends_on: must not be before starts_on'])
  })

  it('repeats only income, a bill or a transfer every 3 months', () => {
    expect(planItemRow.parse({ ...item, every: 'quarter' }).every).toBe('quarter')
    expect(errorsOf(planItemRow, { ...item, kind: 'income', from_account_id: null, to_account_id: 'main', every: 'quarter' })).toEqual([])
    expect(errorsOf(planItemRow, { ...item, kind: 'transfer', to_account_id: 'savings', every: 'quarter' })).toEqual([])
    expect(errorsOf(planItemRow, { ...item, kind: 'allowance', category_id: 'groceries', every: 'quarter' })).toEqual(['every: an allowance is a monthly budget, so it never repeats every 3 months'])
    expect(errorsOf(planItemRow, { ...installment, every: 'quarter' })).toEqual(['every: an installment bills every month'])
    expect(errorsOf(planItemRow, { ...item, every: 'quarterly' })).toEqual(['every: Invalid option: expected one of "once"|"week"|"2weeks"|"month"|"quarter"|"year"'])
  })

  it('refuses a transfer with no from and no to account', () => {
    expect(errorsOf(planItemRow, { ...item, kind: 'transfer', from_account_id: null })).toEqual(['from_account_id: a transfer needs a from account, a to account or both'])
    expect(errorsOf(planItemRow, { ...item, kind: 'transfer', from_account_id: null, to_account_id: 'card' })).toEqual([])
    expect(errorsOf(planItemRow, { ...item, kind: 'transfer' })).toEqual([])
  })

  it('routes income in from no account, and bills, allowances and installments out to none', () => {
    expect(errorsOf(planItemRow, { ...item, kind: 'income' })).toEqual(['from_account_id: income has no from account', 'to_account_id: income needs the account it lands in'])
    expect(errorsOf(planItemRow, { ...item, kind: 'income', from_account_id: null, to_account_id: 'main' })).toEqual([])
    expect(errorsOf(planItemRow, { ...item, to_account_id: 'savings' })).toEqual(['to_account_id: a bill has no to account'])
    expect(errorsOf(planItemRow, { ...installment, from_account_id: null })).toEqual(['from_account_id: an installment needs the account it leaves'])
    expect(errorsOf(planItemRow, { ...item, kind: 'transfer', to_account_id: 'main' })).toEqual(['to_account_id: must differ from from_account_id'])
  })
})

const checked = {
  id: 's1',
  account_id: 'card',
  cut_date: '2026-09-05',
  due_date: '2026-09-30',
  previous_balance_minor: 100000,
  payments_and_credits_minor: 60000,
  charges_minor: 5000,
  installments_minor: 2500,
  interest_minor: 1200,
  fees_minor: 0,
  total_due_minor: 48700,
  minimum_due_minor: 1705,
}

describe('statementRow', () => {
  it('accepts a checked statement that balances and a total-only one', () => {
    expect(statementRow.parse(checked)).toEqual({ ...checked, available_credit_minor: null })
    expect(statementGap(statementRow.parse(checked))).toBe(0)
    const totalOnly = statementRow.parse({ id: 's2', account_id: 'card', cut_date: '2026-09-05', due_date: '2026-09-30', total_due_minor: 48700, minimum_due_minor: 1705 })
    expect(totalOnly.previous_balance_minor).toBeNull()
    expect(statementGap(totalOnly)).toBeNull()
  })

  it('names the difference when the parts do not balance', () => {
    expect(errorsOf(statementRow, { ...checked, total_due_minor: 48750 })).toEqual([
      'total_due_minor: previous − payments and credits + charges + installments + interest + fees = 48700, but total_due_minor is 48750: off by 50',
    ])
    expect(statementGap(statementRow.parse({ ...checked, interest_minor: 1250, total_due_minor: 48750 }))).toBe(0)
  })

  it('takes the six parts together or not at all', () => {
    expect(errorsOf(statementRow, { ...checked, interest_minor: null, fees_minor: undefined })).toEqual([
      'interest_minor: the six parts come together or not at all; missing interest_minor, fees_minor',
    ])
  })

  it('keeps the minimum between 0 and the total, and the due date on or after the cut', () => {
    expect(errorsOf(statementRow, { ...checked, minimum_due_minor: 48701 })).toEqual(['minimum_due_minor: must not exceed the total due'])
    const credit = { id: 's3', account_id: 'card', cut_date: '2026-09-05', due_date: '2026-09-04', total_due_minor: -2000, minimum_due_minor: 1 }
    expect(errorsOf(statementRow, credit)).toEqual(['due_date: must not be before cut_date', 'minimum_due_minor: must not exceed the total due'])
    expect(errorsOf(statementRow, { ...credit, due_date: '2026-09-30', minimum_due_minor: 0, available_credit_minor: -15000 })).toEqual([])
  })
})
