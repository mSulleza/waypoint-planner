import { describe, expect, it } from 'vitest'
import { termsFromPreset } from '../src/presets'
import { checkInput } from '../src/schema/common'
import { importDoc, type ImportDocInput } from '../src/schema/import-doc'

const household = { base_currency: 'EUR', timezone: 'Europe/Lisbon', locale: 'en-IE', track_from: '2026-08-01' }

const doc: ImportDocInput = {
  version: 1,
  household,
  accounts: [
    { id: 'main', name: 'Main', kind: 'cash', currency: 'EUR', opening_balance_minor: 500000, opening_date: '2026-09-01', floor_windows: [{ from_month: '2026-09', to_month: null, amount_minor: 300000 }], fx_fee_pct: 0.007 },
    { id: 'pesos', name: 'Pesos', kind: 'cash', currency: 'PHP', opening_date: '2026-09-01', funded_from_account_id: 'main' },
    {
      id: 'card',
      name: 'Card',
      kind: 'credit_card',
      currency: 'PHP',
      opening_balance_minor: -4000000,
      opening_date: '2026-09-01',
      funded_from_account_id: 'pesos',
      terms: termsFromPreset('PH-daily-unpaid', { cut_day: 12, due: { days_after_cut: 21 }, due_roll: 'preceding' }),
    },
  ],
  categories: [{ id: 'groceries', name: 'Groceries' }],
  plan_items: [
    { id: 'salary', kind: 'income', name: 'Salary', to_account_id: 'main', amount_minor: 450000, starts_on: '2026-09-28' },
    { id: 'food', kind: 'allowance', name: 'Groceries', from_account_id: 'main', category_id: 'groceries', amount_minor: 40000, starts_on: '2026-09-01' },
    { id: 'pay-card', kind: 'transfer', name: 'Card payment', to_account_id: 'card', amount_minor: 500000, starts_on: '2026-10-13' },
  ],
  statements: [{ id: 'sep', account_id: 'card', cut_date: '2026-09-12', due_date: '2026-10-03', total_due_minor: 4000000, minimum_due_minor: 120000 }],
  transactions: [
    { id: 't1', account_id: 'main', posted_on: '2026-09-28', amount_minor: 450000, kind: 'income', plan_item_id: 'salary', period: '2026-09-01' },
    { id: 't2', account_id: 'pesos', posted_on: '2026-10-13', amount_minor: -500000, kind: 'transfer', transfer_id: 'x1', plan_item_id: 'pay-card', period: '2026-10-01' },
    { id: 't3', account_id: 'card', posted_on: '2026-10-14', amount_minor: 500000, kind: 'transfer', transfer_id: 'x1' },
  ],
}

describe('importDoc', () => {
  it('parses a household with every table and fills the column defaults', () => {
    const parsed = importDoc.parse(doc)
    expect([parsed.accounts.length, parsed.categories.length, parsed.plan_items.length, parsed.statements.length, parsed.transactions.length]).toEqual([3, 1, 3, 1, 3])
    expect(parsed.household.payoff_order).toBe('avalanche')
    expect(parsed.plan_items[0]?.every).toBe('month')
    expect(parsed.transactions[2]?.description).toBe('')
  })

  it('treats a missing table as no rows', () => {
    expect(importDoc.parse({ version: 1, household })).toEqual({ version: 1, household: { ...household, payoff_order: 'avalanche' }, accounts: [], categories: [], plan_items: [], statements: [], transactions: [] })
  })

  it('refuses rates, since they come with each snapshot, and any version but 1', () => {
    expect(checkInput(importDoc, { ...doc, version: 2, rates: [{ quote: 'PHP', rate: 70.2, day: '2026-10-07' }] })).toEqual({
      ok: false,
      errors: ['version: must be 1', "(root): Unknown key 'rates'; allowed keys: version, household, accounts, categories, plan_items, statements, transactions, meals"],
    })
  })

  it('collects row errors from every table with their positions', () => {
    const broken = {
      ...doc,
      accounts: [...(doc.accounts ?? []), { id: 'loan', name: 'Loan', kind: 'loan', currency: 'PHP', opening_date: '2026-09-01', funded_from_account_id: 'pesos', terms: { annual_rate: 0.12, payment_minor: 100000, payment_day: 40 } }],
      transactions: [...(doc.transactions ?? []), { id: 't4', account_id: 'main', posted_on: '2026-10-05', amount_minor: 2000, kind: 'expense' }],
    }
    expect(checkInput(importDoc, broken)).toEqual({
      ok: false,
      errors: ['accounts[3].terms.payment_day: must be a day of the month, 1 to 31', 'transactions[3].amount_minor: an expense is money out, so it must be negative'],
    })
  })

  it('takes a quarterly bill and refuses a quarterly budget by its position', () => {
    const fee = { id: 'fee', kind: 'bill', name: 'Accountant', from_account_id: 'pesos', amount_minor: 450000, every: 'quarter', starts_on: '2026-10-15' } as const
    expect(importDoc.parse({ ...doc, plan_items: [...(doc.plan_items ?? []), fee] }).plan_items[3]).toMatchObject({ id: 'fee', every: 'quarter', starts_on: '2026-10-15' })
    const quarterlyFood = { ...doc, plan_items: [...(doc.plan_items ?? []).slice(0, 1), { ...doc.plan_items![1]!, every: 'quarter' as const }] }
    expect(checkInput(importDoc, quarterlyFood)).toEqual({ ok: false, errors: ['plan_items[1].every: an allowance is a monthly budget, so it never repeats every 3 months'] })
  })

  it('flags a document-local id used twice in one table', () => {
    const twice = { ...doc, categories: [{ id: 'groceries', name: 'Groceries' }, { id: 'groceries', name: 'Food' }] }
    expect(checkInput(importDoc, twice)).toEqual({ ok: false, errors: ["categories[1].id: duplicate id 'groceries'"] })
  })
})
