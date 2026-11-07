import { describe, expect, it } from 'vitest'
import { abroadDoc } from '../../data/test-helpers'
import { confirmed, householdWords } from './delete.model'

describe('confirmed', () => {
  it('takes DELETE as typed in capitals, with spaces around it forgiven', () => {
    expect(['DELETE', ' DELETE ', 'DELETE\n'].map(confirmed)).toEqual([true, true, true])
    expect(['delete', 'Delete', 'DELET', 'DELETE!', 'DELETE ME', ''].map(confirmed)).toEqual([false, false, false, false, false, false])
  })
})

describe('householdWords', () => {
  it('counts every table that goes with the household', () => {
    const doc = abroadDoc()
    expect(householdWords(doc)).toBe(`${doc.accounts.length} accounts, ${doc.plan_items.length} plan items, ${doc.transactions.length} transactions, ${doc.statements.length} statements and ${doc.categories.length} categories`)
    expect(householdWords(doc)).toBe('5 accounts, 14 plan items, 33 transactions, 2 statements and 3 categories')
  })

  it('says one of a kind in the singular, and none as 0', () => {
    const doc = abroadDoc()
    const small = { ...doc, accounts: doc.accounts.slice(0, 1), plan_items: [], transactions: doc.transactions.slice(0, 1), statements: [], categories: doc.categories.slice(0, 1) }
    expect(householdWords(small)).toBe('1 account, 0 plan items, 1 transaction, 0 statements and 1 category')
  })
})
