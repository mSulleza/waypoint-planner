import type { CardTerms } from '../../src/schema/terms'
import type { PlanItemInput, Sample, StatementInput, TransactionInput } from '../relative'

export interface CardSetup {
  asOf: string
  terms: CardTerms
  opening_balance_minor: number
  opening_date: string
  // PHP unless set; the cash account pays in the same currency, so a payment lands exactly what it sends.
  currency?: string
  statements?: StatementInput[]
  transactions?: TransactionInput[]
  plan_items?: PlanItemInput[]
}

// One cash account, 'cash', paying one card, 'card', with a single spending category, 'cat-shops'.
export function cardHousehold(setup: CardSetup): Sample {
  const currency = setup.currency ?? 'PHP'
  const { asOf } = setup
  return {
    doc: {
      version: 1,
      household: { base_currency: currency, timezone: 'Asia/Manila', locale: 'en-PH', track_from: '2026-01-01' },
      accounts: [
        { id: 'cash', name: 'Cash', kind: 'cash', currency, opening_balance_minor: 100000000, opening_date: '2026-01-01', sort_order: 0 },
        {
          id: 'card',
          name: 'Card',
          kind: 'credit_card',
          currency,
          opening_balance_minor: setup.opening_balance_minor,
          opening_date: setup.opening_date,
          funded_from_account_id: 'cash',
          terms: setup.terms,
          sort_order: 1,
        },
      ],
      categories: [{ id: 'cat-shops', name: 'Shops' }],
      plan_items: setup.plan_items ?? [],
      statements: setup.statements ?? [],
      transactions: setup.transactions ?? [],
    },
    rates: [
      { quote: 'EUR', rate: 1, day: asOf },
      { quote: 'GBP', rate: 0.86, day: asOf },
      { quote: 'PHP', rate: 70, day: asOf },
      { quote: 'USD', rate: 1.17, day: asOf },
    ],
  }
}
