import { describe, expect, it } from 'vitest'
import { termsFromPreset } from '../src/presets'
import type { ImportDocInput } from '../src/schema/import-doc'
import { buildSnapshot, ledgerDays, ledgerMonth, ledgerSum, ledgerTotals, occurrenceId, snapshotIndex, SnapshotError } from '../src/snapshot'

const rates = [
  { quote: 'PHP', rate: 70, day: '2026-10-06' },
  { quote: 'EUR', rate: 1, day: '2026-10-06' },
]

const doc: ImportDocInput = {
  version: 1,
  household: { base_currency: 'EUR', timezone: 'Europe/Lisbon', locale: 'en-IE', track_from: '2026-09-01' },
  accounts: [
    { id: 'wallet', name: 'Wallet', kind: 'cash', currency: 'EUR', opening_balance_minor: 10000, opening_date: '2026-09-01' },
    {
      id: 'card',
      name: 'Card',
      kind: 'credit_card',
      currency: 'EUR',
      opening_balance_minor: -50000,
      opening_date: '2026-09-01',
      funded_from_account_id: 'bank',
      terms: termsFromPreset('US-generic', { cut_day: 5, due: { days_after_cut: 21 }, due_roll: 'none' }),
    },
    { id: 'bank', name: 'Bank', kind: 'cash', currency: 'EUR', opening_balance_minor: 500000, opening_date: '2026-09-01' },
  ],
  categories: [{ id: 'food', name: 'Food' }],
  plan_items: [
    { id: 'rent', kind: 'bill', name: 'Rent', from_account_id: 'bank', amount_minor: 90000, starts_on: '2026-09-01' },
    { id: 'pay', kind: 'income', name: 'Pay', to_account_id: 'bank', amount_minor: 300000, starts_on: '2026-09-28' },
    { id: 'card-extra', kind: 'transfer', name: 'Card extra', to_account_id: 'card', amount_minor: 5000, starts_on: '2026-10-01' },
  ],
  statements: [
    { id: 's1', account_id: 'card', cut_date: '2026-10-05', due_date: '2026-10-26', total_due_minor: 52000, minimum_due_minor: 3500 },
    { id: 's2', account_id: 'card', cut_date: '2026-09-05', due_date: '2026-09-26', total_due_minor: 50000, minimum_due_minor: 3500 },
  ],
  transactions: [
    { id: 't5', account_id: 'bank', posted_on: '2026-10-03', amount_minor: -90000, kind: 'expense', plan_item_id: 'rent', period: '2026-10-01' },
    { id: 't1', account_id: 'bank', posted_on: '2026-09-01', amount_minor: -90000, kind: 'expense', plan_item_id: 'rent', period: '2026-09-01' },
    { id: 't3', account_id: 'bank', posted_on: '2026-09-28', amount_minor: 300000, kind: 'income', plan_item_id: 'pay', period: '2026-09-01' },
    { id: 't2', account_id: 'bank', posted_on: '2026-09-28', amount_minor: -2000, kind: 'expense', category_id: 'food' },
    { id: 't4b', account_id: 'wallet', posted_on: '2026-10-02', amount_minor: 20000, kind: 'transfer', transfer_id: 'x1' },
    { id: 't4a', account_id: 'bank', posted_on: '2026-10-01', amount_minor: -20000, kind: 'transfer', transfer_id: 'x1' },
    { id: 't7', account_id: 'card', posted_on: '2026-10-11', amount_minor: 5000, kind: 'transfer', transfer_id: 'x2' },
    { id: 't6', account_id: 'bank', posted_on: '2026-10-10', amount_minor: -5000, kind: 'transfer', transfer_id: 'x2', plan_item_id: 'card-extra', period: '2026-10-01' },
  ],
}

const ids = (rows: readonly { id: string }[] | undefined) => rows?.map((r) => r.id)

function issuesOf(input: unknown, asOf = '2026-10-07', withRates = rates): string[] {
  try {
    buildSnapshot(input, asOf, withRates)
  } catch (error) {
    if (error instanceof SnapshotError) return error.issues
    throw error
  }
  return []
}

describe('buildSnapshot', () => {
  it('keeps version, as_of, rates and the document, with every table sorted by id and rates by currency', () => {
    const snapshot = buildSnapshot(doc, '2026-10-07', rates)
    expect(Object.keys(snapshot)).toEqual(['version', 'as_of', 'rates', 'doc'])
    expect([snapshot.version, snapshot.as_of, snapshot.rates.map((r) => r.quote)]).toEqual([1, '2026-10-07', ['EUR', 'PHP']])
    expect(ids(snapshot.doc.accounts)).toEqual(['bank', 'card', 'wallet'])
    expect(ids(snapshot.doc.plan_items)).toEqual(['card-extra', 'pay', 'rent'])
    expect(ids(snapshot.doc.statements)).toEqual(['s1', 's2'])
    expect(ids(snapshot.doc.transactions)).toEqual(['t1', 't2', 't3', 't4a', 't4b', 't5', 't6', 't7'])
  })

  it('indexes rows by account in ledger order, links by occurrence, transfer legs and statements by cut date', () => {
    const index = snapshotIndex(buildSnapshot(doc, '2026-10-07', rates))
    expect(ids(index.rowsByAccount.get('bank'))).toEqual(['t1', 't2', 't3', 't4a', 't5', 't6'])
    expect(ids(index.linksByOccurrence.get(occurrenceId('rent', '2026-10-01')))).toEqual(['t5'])
    expect(ids(index.linksByOccurrence.get('card-extra:2026-10-01'))).toEqual(['t6'])
    expect(index.linksByOccurrence.get(occurrenceId('rent', '2026-11-01'))).toBeUndefined()
    expect(ids(index.transfers.get('x1'))).toEqual(['t4a', 't4b'])
    expect(ids(index.statementsByAccount.get('card'))).toEqual(['s2', 's1'])
    expect(index.accounts.get('card')?.kind).toBe('credit_card')
  })

  it('freezes the snapshot, and a copy it did not make has no index', () => {
    const snapshot = buildSnapshot(doc, '2026-10-07', rates)
    expect([Object.isFrozen(snapshot), Object.isFrozen(snapshot.doc.transactions), Object.isFrozen(snapshot.doc.transactions[0])]).toEqual([true, true, true])
    expect(() => snapshotIndex({ ...snapshot })).toThrow('This snapshot was not made by buildSnapshot; build it from the export and rates')
    expect(() => ledgerSum(JSON.parse(JSON.stringify(snapshot)), 'bank', '2026-10-07')).toThrow('not made by buildSnapshot')
  })

  it('gives equal snapshots for equal input in any row order', () => {
    const reversed = { ...doc, accounts: [...(doc.accounts ?? [])].reverse(), transactions: [...(doc.transactions ?? [])].reverse() }
    expect(buildSnapshot(reversed, '2026-10-07', [...rates].reverse())).toEqual(buildSnapshot(doc, '2026-10-07', rates))
  })

  it('reports a bad as_of, a EUR rate other than 1, a doubled rate and a bad row with their paths', () => {
    const doubled = [...rates, { quote: 'PHP', rate: 71, day: '2026-10-06' }]
    expect(issuesOf(doc, '2026-02-30', [{ quote: 'EUR', rate: 1.1, day: '2026-10-06' }])).toEqual(['as_of: must be a real YYYY-MM-DD date', 'rates[0].rate: EUR per EUR must be 1'])
    expect(issuesOf(doc, '2026-10-07', doubled)).toEqual(["rates[2].quote: duplicate rate for 'PHP'"])
    const badRow = { ...doc, transactions: [...(doc.transactions ?? []), { id: 't8', account_id: 'bank', posted_on: '2026-10-04', amount_minor: 100, kind: 'expense' }] }
    expect(issuesOf(badRow)).toEqual(['doc.transactions[8].amount_minor: an expense is money out, so it must be negative'])
  })

  it('refuses what the database refuses across tables and lists every issue', () => {
    const broken: ImportDocInput = {
      ...doc,
      accounts: [...(doc.accounts ?? []), { id: 'loan', name: 'Loan', kind: 'loan', currency: 'EUR', opening_date: '2026-09-01', funded_from_account_id: 'nowhere', terms: { annual_rate: 0.05, payment_minor: 10000, payment_day: 3 } }],
      categories: [...(doc.categories ?? []), { id: 'food-2', name: 'FOOD' }],
      plan_items: [...(doc.plan_items ?? []), { id: 'tv', kind: 'installment', name: 'TV', from_account_id: 'bank', amount_minor: 1000, starts_on: '2026-10-01', ends_on: '2027-03-01' }],
      statements: [...(doc.statements ?? []), { id: 's3', account_id: 'card', cut_date: '2026-10-05', due_date: '2026-10-26', total_due_minor: 1, minimum_due_minor: 0 }],
      transactions: [
        ...(doc.transactions ?? []),
        { id: 'u1', account_id: 'ghost', posted_on: '2026-10-04', amount_minor: -100, kind: 'expense' },
        { id: 'u2', account_id: 'wallet', posted_on: '2026-10-04', amount_minor: -90000, kind: 'expense', plan_item_id: 'rent', period: '2026-11-01' },
        { id: 'u3', account_id: 'bank', posted_on: '2026-10-04', amount_minor: -100, kind: 'transfer', transfer_id: 'lonely' },
        { id: 'u4', account_id: 'bank', posted_on: '2026-10-04', amount_minor: -100, kind: 'expense', external_id: 'ref-1' },
        { id: 'u5', account_id: 'bank', posted_on: '2026-10-05', amount_minor: -200, kind: 'expense', external_id: 'ref-1' },
        { id: 'u6', account_id: 'bank', posted_on: '2026-10-01', amount_minor: -3000, kind: 'transfer', transfer_id: 'late' },
        { id: 'u7', account_id: 'wallet', posted_on: '2026-10-07', amount_minor: 2900, kind: 'transfer', transfer_id: 'late' },
      ],
    }
    expect(issuesOf(broken)).toEqual([
      "categories['food-2']: name: 'FOOD' is already used by category 'food'",
      "accounts['loan']: funded_from_account_id: no account 'nowhere'",
      "plan_items['tv']: an installment sits on a card, to no account",
      "statements['s3']: cut_date: account 'card' already has a statement cut on 2026-10-05",
      "transactions['u1']: account_id: no account 'ghost'",
      "transactions['u2']: the expense must leave the bill's account 'bank'",
      "transactions['u5']: external_id: 'ref-1' is already recorded on account 'bank'",
      "transactions['u7']: posted_on: the incoming leg of transfer 'late' must post 0 to 5 days after the outgoing leg (2026-10-01)",
      "transactions['u7']: amount_minor: transfer 'late' moves 3000 out and 2900 in within EUR; a fee is its own row",
      "transactions['u3']: transfer_id: 'lonely' has 1 leg; a transfer has exactly 2",
    ])
  })

  it('accepts a cross-currency transfer whose legs differ and an incoming leg on the fifth day', () => {
    const fx: ImportDocInput = {
      ...doc,
      accounts: [...(doc.accounts ?? []), { id: 'pesos', name: 'Pesos', kind: 'cash', currency: 'PHP', opening_date: '2026-09-01' }],
      transactions: [
        { id: 'a', account_id: 'bank', posted_on: '2026-10-01', amount_minor: -10000, kind: 'transfer', transfer_id: 'fx' },
        { id: 'b', account_id: 'pesos', posted_on: '2026-10-06', amount_minor: 695100, kind: 'transfer', transfer_id: 'fx' },
      ],
    }
    expect(issuesOf(fx)).toEqual([])
  })
})

describe('ledgerSum and ledgerMonth', () => {
  const snapshot = buildSnapshot(doc, '2026-10-07', rates)

  it('sums opening plus every row on or before the day', () => {
    expect(ledgerSum(snapshot, 'bank', '2026-08-31')).toBe(500000)
    expect(ledgerSum(snapshot, 'bank', '2026-09-30')).toBe(708000)
    expect(ledgerSum(snapshot, 'bank', '2026-10-07')).toBe(598000)
    expect(ledgerSum(snapshot, 'wallet', '2026-10-07')).toBe(30000)
    expect(ledgerSum(snapshot, 'card', '2026-10-31')).toBe(-45000)
  })

  it('lists a month by posted_on then id, each row with the balance after it', () => {
    expect(ledgerMonth(snapshot, 'bank', '2026-09').map((r) => [r.id, r.running_balance_minor])).toEqual([
      ['t1', 410000],
      ['t2', 408000],
      ['t3', 708000],
    ])
    const october = ledgerMonth(snapshot, 'bank', '2026-10')
    expect(october.map((r) => [r.id, r.running_balance_minor])).toEqual([
      ['t4a', 688000],
      ['t5', 598000],
      ['t6', 593000],
    ])
    expect(october.at(-1)?.running_balance_minor).toBe(ledgerSum(snapshot, 'bank', '2026-10-31'))
    expect(october[1]).toMatchObject({ plan_item_id: 'rent', period: '2026-10-01', amount_minor: -90000 })
    expect(ledgerMonth(snapshot, 'bank', '2026-11')).toEqual([])
  })

  it('throws on an account the snapshot lacks and on a malformed day or month', () => {
    expect(() => ledgerSum(snapshot, 'ghost', '2026-10-07')).toThrow("No account 'ghost' in the snapshot")
    expect(() => ledgerSum(snapshot, 'bank', '2026-10-32')).toThrow(RangeError)
    expect(() => ledgerMonth(snapshot, 'bank', '2026-13')).toThrow(RangeError)
  })
})

describe('ledgerTotals and ledgerDays', () => {
  const snapshot = buildSnapshot(doc, '2026-10-07', rates)

  it('sums a month from its rows: opening before the first day, money in, money out and the closing after the last day', () => {
    expect(ledgerTotals(snapshot, 'bank', '2026-09')).toEqual({ opening_minor: 500000, closing_minor: 708000, in_minor: 300000, out_minor: 92000 })
    expect(ledgerTotals(snapshot, 'bank', '2026-10')).toEqual({ opening_minor: 708000, closing_minor: 593000, in_minor: 0, out_minor: 115000 })
    expect(ledgerTotals(snapshot, 'wallet', '2026-10')).toEqual({ opening_minor: 10000, closing_minor: 30000, in_minor: 20000, out_minor: 0 })
    expect(ledgerTotals(snapshot, 'bank', '2026-08')).toEqual({ opening_minor: 500000, closing_minor: 500000, in_minor: 0, out_minor: 0 })
  })

  it('closes each month where ledgerSum puts its last day and the next month opens', () => {
    for (const [month, last] of [['2026-09', '2026-09-30'], ['2026-10', '2026-10-31']] as const) {
      expect(ledgerTotals(snapshot, 'bank', month).closing_minor).toBe(ledgerSum(snapshot, 'bank', last))
    }
    expect(ledgerTotals(snapshot, 'bank', '2026-10').opening_minor).toBe(ledgerTotals(snapshot, 'bank', '2026-09').closing_minor)
  })

  it('gives each day the balance after its rows, index 0 on the first day', () => {
    expect([...ledgerDays(snapshot, 'bank', '2026-09-27', '2026-10-03')]).toEqual([410000, 708000, 708000, 708000, 688000, 688000, 598000])
    expect([...ledgerDays(snapshot, 'bank', '2026-10-31', '2026-10-31')]).toEqual([593000])
    expect(() => ledgerDays(snapshot, 'bank', '2026-10-02', '2026-10-01')).toThrow(RangeError)
    expect(() => ledgerDays(snapshot, 'ghost', '2026-10-01', '2026-10-02')).toThrow("No account 'ghost' in the snapshot")
  })
})
