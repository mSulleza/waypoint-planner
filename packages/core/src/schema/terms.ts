import { z } from 'zod'
import { fraction, minorUnits, rollRule, strictKeys } from './common'

const dayOfMonth = z.int().min(1, 'must be a day of the month, 1 to 31').max(31, 'must be a day of the month, 1 to 31')
const afterCut = z.int().min(1, 'must be at least 1 day after the cut').max(60, 'must be at most 60 days after the cut')

export const cardInterest = strictKeys({
  method: z.enum(['daily_on_unpaid', 'average_daily_balance']),
  rate: fraction,
  period: z.enum(['month', 'year']),
  day_count: z.literal([30, 360, 365], 'must be 30, 360 or 365'),
  // Days after a payment's or credit's card-leg date before it lowers the interest base; 0 lowers it that day.
  payment_effective_lag_days: z.int('must be a whole number of days').min(0, 'must be 0 to 7 days').max(7, 'must be 0 to 7 days').default(0),
})

// The minimum is always a share of the statement total, so there is no basis field.
export const cardMinimum = strictKeys({
  pct: z.number().min(0, 'must not be negative').max(1, 'must be a fraction of the statement total, at most 1'),
  add_installments: z.boolean(),
  add_interest: z.boolean(),
  add_fees: z.boolean(),
  floor_minor: minorUnits.min(0, 'must not be negative'),
  rounding: z.enum(['ceil', 'half_up']),
})

export const cardPay = strictKeys({
  mode: z.enum(['in_full', 'minimum', 'installments_plus']),
  on: z.union([z.literal('due_date'), strictKeys({ days_after_cut: afterCut })], { error: "must be 'due_date' or {days_after_cut}" }),
})

// Grace always applies; there is no late fee, limit or minimum basis (spec §2 and §6.4).
export const cardTerms = strictKeys({
  cut_day: dayOfMonth,
  due: z.union([strictKeys({ days_after_cut: afterCut }), strictKeys({ day_of_month: dayOfMonth })], { error: 'must be {days_after_cut} or {day_of_month}' }),
  due_roll: rollRule,
  interest: cardInterest,
  minimum: cardMinimum,
  pay: cardPay,
  preset: z.string().min(1, 'must name the preset the terms were copied from'),
})

// Annuity only: no term, no rate steps and no fixed payment list.
export const loanTerms = strictKeys({
  annual_rate: fraction,
  payment_minor: minorUnits.min(1, 'must be more than 0'),
  payment_day: dayOfMonth,
})

export type CardTerms = z.output<typeof cardTerms>
export type CardRules = Pick<CardTerms, 'interest' | 'minimum' | 'pay'>
export type LoanTerms = z.output<typeof loanTerms>
