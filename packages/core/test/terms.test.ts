import { describe, expect, it } from 'vitest'
import { cardPreset } from '../src/presets'
import { checkInput } from '../src/schema/common'
import { cardTerms, loanTerms } from '../src/schema/terms'

const terms = {
  cut_day: 15,
  due: { days_after_cut: 25 },
  due_roll: 'following',
  interest: { method: 'average_daily_balance', rate: 0.03, period: 'month', day_count: 30 },
  minimum: { pct: 0.035, add_installments: false, add_interest: false, add_fees: false, floor_minor: 0, rounding: 'ceil' },
  pay: { mode: 'installments_plus', on: { days_after_cut: 1 } },
  preset: 'PH-round-up',
}

const without = (row: object, key: string) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== key))

const errorsOf = (input: unknown) => {
  const result = checkInput(cardTerms, input)
  return result.ok ? [] : result.errors
}

describe('cardTerms', () => {
  it('accepts a card with a due rule after the cut and one on a day of the month', () => {
    expect(cardTerms.parse(terms)).toEqual({ ...terms, interest: { ...terms.interest, payment_effective_lag_days: 0 } })
    expect(cardTerms.parse({ ...terms, due: { day_of_month: 9 }, pay: { mode: 'in_full', on: 'due_date' } }).due).toEqual({ day_of_month: 9 })
  })

  it('reads a missing payment lag as 0 days and takes a whole number of days from 0 to 7', () => {
    const lagged = (payment_effective_lag_days: unknown) => ({ ...terms, interest: { ...terms.interest, payment_effective_lag_days } })
    expect([0, 1, 7].map((days) => cardTerms.parse(lagged(days)).interest.payment_effective_lag_days)).toEqual([0, 1, 7])
    expect([-1, 8].map((days) => errorsOf(lagged(days)))).toEqual([['interest.payment_effective_lag_days: must be 0 to 7 days'], ['interest.payment_effective_lag_days: must be 0 to 7 days']])
    expect(errorsOf(lagged(0.5))).toEqual(['interest.payment_effective_lag_days: must be a whole number of days'])
  })

  it('refuses pay.on with days_after_cut 0, naming the field', () => {
    expect(errorsOf({ ...terms, pay: { mode: 'minimum', on: { days_after_cut: 0 } } })).toEqual(['pay.on.days_after_cut: must be at least 1 day after the cut'])
  })

  it('reports the due rule the input was aiming at', () => {
    expect(errorsOf({ ...terms, due: { days_after_cut: 0 } })).toEqual(['due.days_after_cut: must be at least 1 day after the cut'])
    expect(errorsOf({ ...terms, due: { day_of_month: 32 } })).toEqual(['due.day_of_month: must be a day of the month, 1 to 31'])
    expect(errorsOf({ ...terms, due: {} })).toEqual(['due: must be {days_after_cut} or {day_of_month}'])
    expect(errorsOf({ ...terms, pay: { mode: 'minimum', on: 'statement_date' } })).toEqual(["pay.on: must be 'due_date' or {days_after_cut}"])
  })

  it('refuses a rate written as a percent, so every rate is a fraction with a period', () => {
    expect(errorsOf({ ...terms, interest: { ...terms.interest, rate: 3 } })).toEqual(['interest.rate: must be a fraction below 1, such as 0.03 for 3%; percent and fraction never mix'])
    expect(errorsOf({ ...terms, interest: { method: 'average_daily_balance', rate: 0.03, day_count: 30 } })).toHaveLength(1)
    expect(errorsOf({ ...terms, interest: { ...terms.interest, period: 'day' } })[0]).toMatch(/^interest\.period: /)
    expect(errorsOf({ ...terms, interest: { ...terms.interest, day_count: 31 } })).toEqual(['interest.day_count: must be 30, 360 or 365'])
    expect(errorsOf({ ...terms, interest: { ...terms.interest, rate: 0 } })).toEqual([])
    expect(checkInput(loanTerms, { annual_rate: 6.5, payment_minor: 45000, payment_day: 1 })).toEqual({
      ok: false,
      errors: ['annual_rate: must be a fraction below 1, such as 0.03 for 3%; percent and fraction never mix'],
    })
    expect(loanTerms.parse({ annual_rate: 0.065, payment_minor: 45000, payment_day: 1 })).toEqual({ annual_rate: 0.065, payment_minor: 45000, payment_day: 1 })
  })

  it('keeps no minimum basis, as the minimum is always a share of the statement total, and stores the rounding per card', () => {
    expect(errorsOf({ ...terms, minimum: { ...terms.minimum, basis: 'carry' } })).toEqual([
      "minimum: Unknown key 'basis'; allowed keys: pct, add_installments, add_interest, add_fees, floor_minor, rounding",
    ])
    expect(errorsOf({ ...terms, minimum: without(terms.minimum, 'rounding') })[0]).toMatch(/^minimum\.rounding: /)
    expect(errorsOf({ ...terms, minimum: { ...terms.minimum, rounding: 'floor' } })[0]).toMatch(/^minimum\.rounding: /)
    expect([cardPreset('PH-round-up')?.rules.minimum.rounding, cardPreset('PH-round-off')?.rules.minimum.rounding]).toEqual(['ceil', 'half_up'])
  })

  it('has no late fee, grace flag or credit limit', () => {
    expect(errorsOf({ ...terms, late_fee_minor: 100000, grace: false, limit_minor: 5000000 })).toEqual([
      "(root): Unknown keys 'late_fee_minor', 'grace', 'limit_minor'; allowed keys: cut_day, due, due_roll, interest, minimum, pay, preset",
    ])
  })

  it('collects every error in the terms at once', () => {
    expect(errorsOf({ ...terms, cut_day: 0, due_roll: 'weekday', minimum: { ...terms.minimum, pct: 3.5, floor_minor: -1 } })).toEqual([
      'cut_day: must be a day of the month, 1 to 31',
      expect.stringMatching(/^due_roll: /),
      'minimum.pct: must be a fraction of the statement total, at most 1',
      'minimum.floor_minor: must not be negative',
    ])
  })
})

describe('loanTerms', () => {
  it('is an annuity only, with no term, rate steps or fixed payments', () => {
    expect(checkInput(loanTerms, { annual_rate: 0.05, payment_minor: 50000, payment_day: 15, term_months: 60 })).toEqual({
      ok: false,
      errors: ["(root): Unknown key 'term_months'; allowed keys: annual_rate, payment_minor, payment_day"],
    })
    expect(checkInput(loanTerms, { annual_rate: 0.05, payment_minor: 0, payment_day: 32 })).toEqual({
      ok: false,
      errors: ['payment_minor: must be more than 0', 'payment_day: must be a day of the month, 1 to 31'],
    })
  })
})
