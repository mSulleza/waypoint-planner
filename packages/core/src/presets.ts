import type { CardRules, CardTerms } from './schema/terms'

export const CARD_BEHAVIOURS = ['Pays in full each month', 'Revolving, interest on the average daily balance', 'Revolving, interest daily on the unpaid statement balance'] as const

export type CardBehaviour = (typeof CARD_BEHAVIOURS)[number]

export interface CardPreset {
  id: string
  // What a person picks it by, in plain words; never the id.
  title: string
  behaviour: CardBehaviour
  // null: fits a card in any currency.
  currency: string | null
  source: string
  note: string | null
  rules: CardRules
}

const EXAMPLE = 'example terms, not fitted to a bank'
const UNTIL_CALIBRATED = 'Interest rate until calibrated.'

const monthly30 = (method: CardRules['interest']['method'], payment_effective_lag_days = 0): CardRules['interest'] => ({ method, rate: 0.03, period: 'month', day_count: 30, payment_effective_lag_days })

const ofTotal = (pct: number, rounding: CardRules['minimum']['rounding']): CardRules['minimum'] => ({
  pct,
  add_installments: false,
  add_interest: false,
  add_fees: false,
  floor_minor: 0,
  rounding,
})

// Rules only, named by behaviour; a card adds its own cut day and due rule (spec §6.4).
export const CARD_PRESETS: readonly CardPreset[] = [
  {
    id: 'generic-in-full',
    title: 'Any bank',
    behaviour: 'Pays in full each month',
    currency: null,
    source: 'common card terms, not fitted to a bank',
    note: 'Interest applies only when a statement is not paid in full by its due date.',
    rules: {
      interest: { method: 'average_daily_balance', rate: 0.24, period: 'year', day_count: 365, payment_effective_lag_days: 0 },
      minimum: { ...ofTotal(0.01, 'half_up'), add_installments: true, add_interest: true, add_fees: true },
      pay: { mode: 'in_full', on: 'due_date' },
    },
  },
  {
    id: 'PH-min-floor',
    title: 'Philippine card, minimum with a floor',
    behaviour: 'Pays in full each month',
    currency: 'PHP',
    source: EXAMPLE,
    note: `${UNTIL_CALIBRATED} A bank may print 3% of retail purchases plus installments; this takes 3% of the whole total plus installments, so it can read a little high.`,
    rules: {
      interest: monthly30('average_daily_balance'),
      minimum: { ...ofTotal(0.03, 'half_up'), add_installments: true, floor_minor: 60000 },
      pay: { mode: 'in_full', on: 'due_date' },
    },
  },
  {
    id: 'US-generic',
    title: 'Any US bank',
    behaviour: 'Revolving, interest on the average daily balance',
    currency: 'USD',
    source: 'common US card terms, not fitted to a bank',
    note: null,
    rules: {
      interest: { method: 'average_daily_balance', rate: 0.24, period: 'year', day_count: 365, payment_effective_lag_days: 0 },
      minimum: { ...ofTotal(0.01, 'half_up'), add_interest: true, add_fees: true, floor_minor: 3500 },
      pay: { mode: 'minimum', on: 'due_date' },
    },
  },
  {
    id: 'PH-round-up',
    title: 'Philippine card, minimum rounded up',
    behaviour: 'Revolving, interest on the average daily balance',
    currency: 'PHP',
    source: EXAMPLE,
    note: UNTIL_CALIBRATED,
    rules: { interest: monthly30('average_daily_balance'), minimum: ofTotal(0.035, 'ceil'), pay: { mode: 'installments_plus', on: 'due_date' } },
  },
  {
    id: 'PH-round-off',
    title: 'Philippine card, minimum rounded off',
    behaviour: 'Revolving, interest on the average daily balance',
    currency: 'PHP',
    source: EXAMPLE,
    note: UNTIL_CALIBRATED,
    rules: { interest: monthly30('average_daily_balance'), minimum: ofTotal(0.035, 'half_up'), pay: { mode: 'installments_plus', on: 'due_date' } },
  },
  {
    id: 'PH-daily-unpaid',
    title: 'Philippine card, interest on what is unpaid',
    behaviour: 'Revolving, interest daily on the unpaid statement balance',
    currency: 'PHP',
    source: EXAMPLE,
    note: 'A payment lowers interest from the day after the transaction date the statement prints.',
    rules: { interest: monthly30('daily_on_unpaid', 1), minimum: ofTotal(0.03, 'ceil'), pay: { mode: 'installments_plus', on: 'due_date' } },
  },
]

export function cardPreset(id: string): CardPreset | undefined {
  return CARD_PRESETS.find((p) => p.id === id)
}

// A fresh copy, so editing a card's terms never edits the preset.
export function termsFromPreset(id: string, card: Pick<CardTerms, 'cut_day' | 'due' | 'due_roll'>): CardTerms {
  const preset = cardPreset(id)
  if (!preset) throw new RangeError(`No card preset '${id}'`)
  const rules = JSON.parse(JSON.stringify(preset.rules)) as CardRules
  return { cut_day: card.cut_day, due: { ...card.due }, due_roll: card.due_roll, ...rules, preset: id }
}
