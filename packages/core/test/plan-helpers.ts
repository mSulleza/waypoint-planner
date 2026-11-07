import { abroad, type SampleDoc } from '../fixtures'
import type { PlanItemInput } from '../fixtures/relative'
import type { EngineEvent, ExpandedPlan, Occurrence } from '../src/engine/types'
import { termsFromPreset } from '../src/presets'
import type { Rate } from '../src/rates'
import { buildSnapshot, type Snapshot } from '../src/snapshot'

type Rows = Partial<Pick<SampleDoc, 'plan_items' | 'transactions' | 'statements' | 'categories'>>

const rates = (asOf: string): Rate[] => [
  { quote: 'EUR', rate: 1, day: asOf },
  { quote: 'PHP', rate: 70, day: asOf },
]

// Bank and Savings (EUR cash), Pesos (PHP cash), a card cut on the 20th and a loan, all opened on 1 Jan 2026.
export function bare(asOf: string, rows: Rows = {}, trackFrom = '2026-01-01'): Snapshot {
  const doc: SampleDoc = {
    version: 1,
    household: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-IE', track_from: trackFrom },
    accounts: [
      { id: 'bank', name: 'Bank', kind: 'cash', currency: 'EUR', opening_balance_minor: 500000, opening_date: '2026-01-01' },
      { id: 'savings', name: 'Savings', kind: 'cash', currency: 'EUR', opening_balance_minor: 100000, opening_date: '2026-01-01' },
      { id: 'pesos', name: 'Pesos', kind: 'cash', currency: 'PHP', opening_balance_minor: 1000000, opening_date: '2026-01-01' },
      {
        id: 'card',
        name: 'Card',
        kind: 'credit_card',
        currency: 'EUR',
        opening_balance_minor: 0,
        opening_date: '2026-01-01',
        funded_from_account_id: 'bank',
        terms: termsFromPreset('US-generic', { cut_day: 20, due: { day_of_month: 10 }, due_roll: 'none' }),
      },
      { id: 'loan', name: 'Loan', kind: 'loan', currency: 'EUR', opening_balance_minor: -1000000, opening_date: '2026-01-01', funded_from_account_id: 'bank', terms: { annual_rate: 0.05, payment_minor: 30000, payment_day: 5 } },
    ],
    categories: [
      { id: 'food', name: 'Food' },
      { id: 'fun', name: 'Fun' },
    ],
    plan_items: [],
    statements: [],
    transactions: [],
    ...rows,
  }
  return buildSnapshot(doc, asOf, rates(asOf))
}

export const item = (fields: Omit<PlanItemInput, 'name'>): PlanItemInput => ({ name: 'Item', ...fields })

// The abroad sample on asOf, edited in place before it is built.
export function abroadAt(asOf: string, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates: sampleRates } = abroad(asOf)
  edit?.(doc)
  return buildSnapshot(doc, asOf, sampleRates)
}

export function occurrence(plan: ExpandedPlan, id: string): Occurrence {
  const found = plan.byId.get(id)
  if (!found) throw new Error(`No occurrence '${id}' among ${plan.occurrences.length}`)
  return found
}

export const eventsFor = (plan: ExpandedPlan, occurrenceId: string): EngineEvent[] => plan.events.filter((e) => e.occurrence_ids.includes(occurrenceId))

// [date, account, amount] of every event an occurrence produced.
export const counted = (plan: ExpandedPlan, occurrenceId: string) => eventsFor(plan, occurrenceId).map((e) => [e.date, e.account_id, e.amount_minor])
