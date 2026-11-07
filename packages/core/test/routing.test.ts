import { describe, expect, it } from 'vitest'
import { validateLink, validatePlanItem, type AccountRef } from '../src/schema/routing'
import type { PlanItem, Transaction } from '../src/schema/rows'

const accounts: AccountRef[] = [
  { id: 'checking', kind: 'cash' },
  { id: 'savings', kind: 'cash' },
  { id: 'card', kind: 'credit_card' },
  { id: 'car', kind: 'loan' },
]

type Route = Pick<PlanItem, 'id' | 'kind' | 'from_account_id' | 'to_account_id'>
const route = (kind: PlanItem['kind'], from: string | null, to: string | null): Route => ({ id: `${kind}-${from}-${to}`, kind, from_account_id: from, to_account_id: to })

type Leg = Pick<Transaction, 'id' | 'kind' | 'account_id' | 'amount_minor' | 'transfer_id'>
const row = (kind: Transaction['kind'], account: string, amount: number, transfer: string | null = null, id = `${kind}-${account}-${amount}`): Leg => ({
  id,
  kind,
  account_id: account,
  amount_minor: amount,
  transfer_id: transfer,
})

describe('validatePlanItem', () => {
  it('accepts a transfer into a card with no from account', () => {
    expect(validatePlanItem(route('transfer', null, 'card'), accounts)).toEqual([])
    expect(validatePlanItem(route('transfer', null, 'car'), accounts)).toEqual([])
  })

  it('refuses a transfer from a card and a transfer into a card with a from account', () => {
    expect(validatePlanItem(route('transfer', 'card', 'checking'), accounts)).toEqual([
      "a transfer with both accounts moves cash to cash; one into a debt has no from account and leaves the debt's funded-from account",
    ])
    expect(validatePlanItem(route('transfer', 'card', null), accounts)).toEqual(['extra for debts leaves a cash account'])
    expect(validatePlanItem(route('transfer', 'checking', 'card'), accounts)).toEqual([
      "a transfer with both accounts moves cash to cash; one into a debt has no from account and leaves the debt's funded-from account",
    ])
  })

  it('moves a transfer cash to cash, empty to a debt, or cash to empty', () => {
    expect(validatePlanItem(route('transfer', 'checking', 'savings'), accounts)).toEqual([])
    expect(validatePlanItem(route('transfer', 'checking', null), accounts)).toEqual([])
    expect(validatePlanItem(route('transfer', null, 'savings'), accounts)).toEqual(['a transfer with no from account goes into a debt'])
    expect(validatePlanItem(route('transfer', null, null), accounts)).toEqual(['a transfer needs a from account, a to account or both'])
  })

  it('lands income in cash or on a debt, and takes bills and allowances from cash or a card', () => {
    for (const to of ['checking', 'card', 'car']) expect(validatePlanItem(route('income', null, to), accounts)).toEqual([])
    for (const kind of ['bill', 'allowance'] as const) {
      expect(validatePlanItem(route(kind, 'checking', null), accounts)).toEqual([])
      expect(validatePlanItem(route(kind, 'card', null), accounts)).toEqual([])
    }
    expect(validatePlanItem(route('bill', 'car', null), accounts)).toEqual(['a bill leaves a cash account or a card, to no account'])
    expect(validatePlanItem(route('allowance', 'car', null), accounts)).toEqual(['an allowance leaves a cash account or a card, to no account'])
  })

  it('puts an installment on a card only', () => {
    expect(validatePlanItem(route('installment', 'card', null), accounts)).toEqual([])
    expect(validatePlanItem(route('installment', 'checking', null), accounts)).toEqual(['an installment sits on a card, to no account'])
    expect(validatePlanItem(route('installment', 'car', null), accounts)).toEqual(['an installment sits on a card, to no account'])
  })

  it('names an account id that is not in the list', () => {
    expect(validatePlanItem(route('transfer', 'gone', 'card'), accounts)).toEqual(["from_account_id: no account 'gone'"])
  })
})

describe('validateLink', () => {
  const rent = route('bill', 'checking', null)
  const salary = route('income', null, 'checking')
  const intoCard = route('transfer', null, 'card')
  const toSavings = route('transfer', 'checking', 'savings')

  it('refuses a drawdown linked to a bill', () => {
    expect(validateLink(row('drawdown', 'checking', 500000), null, rent, accounts)).toEqual(['a drawdown links only to an income item, not to a bill'])
  })

  it('accepts an outgoing leg linked to a transfer item into a card, whichever cash account it leaves', () => {
    for (const cash of ['checking', 'savings']) {
      const out = row('transfer', cash, -40000, 'x1')
      expect(validateLink(out, row('transfer', 'card', 40000, 'x1'), intoCard, accounts)).toEqual([])
    }
  })

  it('refuses a payment into a debt that leaves a card, lands elsewhere, or lacks its other leg', () => {
    expect(validateLink(row('transfer', 'card', -40000, 'x1'), row('transfer', 'car', 40000, 'x1'), route('transfer', null, 'car'), accounts)).toEqual([
      'the outgoing leg of a payment into a debt must leave a cash account',
    ])
    expect(validateLink(row('transfer', 'checking', -40000, 'x1'), row('transfer', 'savings', 40000, 'x1'), intoCard, accounts)).toEqual([
      "the other leg must land in the item's account 'card'",
    ])
    expect(validateLink(row('transfer', 'checking', -40000, 'x1'), null, intoCard, accounts)).toEqual(['the transfer needs its other leg'])
    expect(validateLink(row('transfer', 'checking', -40000, 'x1'), row('transfer', 'card', 40000, 'x2'), intoCard, accounts)).toEqual(['the transfer needs its other leg'])
  })

  it('links a cash-to-cash transfer item by the leg leaving its from account', () => {
    const out = row('transfer', 'checking', -10000, 'x1')
    const into = row('transfer', 'savings', 10000, 'x1')
    expect(validateLink(out, into, toSavings, accounts)).toEqual([])
    expect(validateLink(into, out, toSavings, accounts)).toEqual([
      'a transfer links by its outgoing (negative) leg',
      "the outgoing leg must leave the item's account 'checking'",
      "the other leg must land in the item's account 'savings'",
    ])
  })

  it('links an expense to a bill on its account, and income, refunds and drawdowns to an income item where they land', () => {
    expect(validateLink(row('expense', 'checking', -90000), null, rent, accounts)).toEqual([])
    expect(validateLink(row('expense', 'savings', -90000), null, rent, accounts)).toEqual(["the expense must leave the bill's account 'checking'"])
    expect(validateLink(row('expense', 'checking', -90000), null, salary, accounts)).toEqual(['an expense links only to a bill, not to an income item'])
    for (const kind of ['income', 'refund', 'drawdown'] as const) expect(validateLink(row(kind, 'checking', 300000), null, salary, accounts)).toEqual([])
    expect(validateLink(row('income', 'savings', 300000), null, salary, accounts)).toEqual(["the income must land in the item's account 'checking'"])
    expect(validateLink(row('drawdown', 'card', 500000), null, route('income', null, 'card'), accounts)).toEqual([])
    expect(validateLink(row('transfer', 'checking', -90000, 'x1'), row('transfer', 'savings', 90000, 'x1'), rent, accounts)).toEqual([
      'a transfer links only to a transfer item, not to a bill',
    ])
  })

  it('never links an adjustment, an allowance, an installment or extra for debts', () => {
    expect(validateLink(row('adjustment', 'checking', -90000), null, rent, accounts)).toEqual(['an adjustment never links'])
    expect(validateLink(row('expense', 'checking', -9000), null, route('allowance', 'checking', null), accounts)).toEqual(['an allowance settles by spending and takes no links'])
    expect(validateLink(row('expense', 'card', -2500), null, route('installment', 'card', null), accounts)).toEqual(['an installment settles through statements and takes no links'])
    expect(validateLink(row('transfer', 'checking', -30000, 'x1'), row('transfer', 'card', 30000, 'x1'), route('transfer', 'checking', null), accounts)).toEqual([
      'extra for debts is sized by the engine and takes no links',
    ])
  })
})
