import { buildSnapshot, daysBetween, ledgerMonth, ledgerSum, postBatchInput, type Snapshot } from '@waypoint/core'
import { abroad, markSize, type Sample } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import type { Rewrite } from '../../data/edits'
import { deleteEdit, editDraft, editTarget, kindLabel, ledgerBounds, ledgerDayTitle, ledgerItems, ledgerMonthOf, lineOf, readEdit, savedMonth, type EditDraft, type EditTarget } from './ledger.model'

const AS_OF = '2026-10-09'
const LOCALE = 'en-PH'
const HOUSEHOLD = '0b7f4d1e-5c1a-4f7e-9a0b-2d3c4e5f6a7b'
const OPTIONS = { locale: LOCALE, household_id: HOUSEHOLD, day: (iso: string) => iso }

function snapshotOf(build: (asOf: string) => Sample = abroad, edit?: (sample: Sample) => void): Snapshot {
  const sample = build(AS_OF)
  edit?.(sample)
  return buildSnapshot(sample.doc, AS_OF, sample.rates)
}

function target(snapshot: Snapshot, rowId: string): EditTarget {
  const t = editTarget(snapshot, rowId)
  if (!t) throw new Error(`no row ${rowId}`)
  return t
}

function rewritten(snapshot: Snapshot, rowId: string, change: Partial<EditDraft>): Rewrite[] {
  const t = target(snapshot, rowId)
  const read = readEdit(t, { ...editDraft(t, LOCALE), ...change }, OPTIONS)
  if (!read.ok) throw new Error(JSON.stringify(read.errors))
  if (read.edit?.kind !== 'rewrite') throw new Error('no rewrite')
  return [...read.edit.rows]
}

describe('the month ledger', () => {
  it('lists the month newest day first, with the balance after each row in ledger order', () => {
    const snapshot = snapshotOf()
    const items = ledgerItems(snapshot, ledgerMonth(snapshot, 'main', '2026-10'))
    expect(items.map((i) => (i.type === 'day' ? i.day : [i.line.title, i.line.amount_minor, i.line.balance_minor]))).toEqual([
      '2026-10-06',
      ['Bakery', -6000, 645000],
      '2026-10-03',
      ['Supermarket', -9000, 651000],
      '2026-10-02',
      ['Top-up', -50000, 660000],
      '2026-10-01',
      ['Rent', -90000, 710000],
    ])
    // The newest row's balance is the account's balance today.
    expect(645000).toBe(ledgerSum(snapshot, 'main', AS_OF))
  })

  it('draws the month as one card, its first day heading opening it and its last row closing it, with each day’s first and last rows marked', () => {
    const snapshot = snapshotOf(abroad, (s) => s.doc.transactions.push({ id: 'coffee', account_id: 'main', posted_on: '2026-10-06', amount_minor: -400, kind: 'expense', description: 'Coffee' }))
    const items = ledgerItems(snapshot, ledgerMonth(snapshot, 'main', '2026-10'))
    expect(items.slice(0, 3).map((i) => (i.type === 'day' ? [i.day, i.top] : [i.line.title, i.first, i.last]))).toEqual([['2026-10-06', true], ['Bakery', true, false], ['Coffee', false, true]])
    expect(items.filter((i) => i.type === 'day' && i.top)).toHaveLength(1)
    expect(items.map((i) => i.type === 'row' && i.bottom)).toEqual(items.map((_, k) => k === items.length - 1))
  })

  it('names the kind, the category, the other leg’s account and the linked item in the detail line', () => {
    const snapshot = snapshotOf()
    const line = (account: string, month: string, title: string) => ledgerItems(snapshot, ledgerMonth(snapshot, account, month)).find((i) => i.type === 'row' && i.line.title === title)
    expect(line('main', '2026-10', 'Bakery')).toMatchObject({ line: { detail: 'Expense · Groceries' } })
    expect(line('main', '2026-10', 'Top-up')).toMatchObject({ line: { detail: 'Transfer to Pesos' } })
    expect(line('pesos', '2026-10', 'Top-up')).toMatchObject({ line: { detail: 'Transfer from Main' } })
    expect(line('main', '2026-10', 'Rent')).toMatchObject({ line: { detail: 'Expense · Linked to Rent' } })
  })

  it('pairs a transfer split by a month end, reading the other leg from full history (invariant 191)', () => {
    const snapshot = snapshotOf(abroad, (s) =>
      s.doc.transactions.push(
        { id: 'late-out', account_id: 'main', posted_on: '2026-09-30', amount_minor: -10000, kind: 'transfer', description: '', transfer_id: 'late' },
        { id: 'late-in', account_id: 'pesos', posted_on: '2026-10-02', amount_minor: 695000, kind: 'transfer', description: '', transfer_id: 'late' },
      ),
    )
    const october = ledgerItems(snapshot, ledgerMonth(snapshot, 'pesos', '2026-10'))
    expect(october.find((i) => i.type === 'row' && i.line.id === 'late-in')).toMatchObject({ line: { title: 'Transfer from Main', detail: '' } })
    expect(target(snapshot, 'late-in').partner?.id).toBe('late-out')
  })

  it('names a kind this build does not know by its own value, so a newer database never blanks a row (invariant 190)', () => {
    expect(['income', 'expense', 'refund', 'transfer', 'drawdown', 'adjustment'].map(kindLabel)).toEqual(['Income', 'Expense', 'Refund', 'Transfer', 'Drawdown', 'Adjustment'])
    expect(kindLabel('reimbursement')).toBe('Reimbursement')
    expect(kindLabel('loan_drawdown')).toBe('Loan drawdown')
    expect(kindLabel('')).toBe('Other')
    const snapshot = snapshotOf()
    const row = { ...snapshot.doc.transactions.find((t) => t.id === 'groceries-5')!, kind: 'reimbursement', description: '', category_id: null, running_balance_minor: 0 }
    expect(lineOf(snapshot, row as never)).toMatchObject({ title: 'Reimbursement', detail: '' })
  })

  it('steps from the opening month to this month, or to the last month a row was entered for', () => {
    const snapshot = snapshotOf()
    const main = snapshot.doc.accounts.find((a) => a.id === 'main')!
    expect(ledgerBounds(snapshot, main)).toEqual({ first: '2026-09', last: '2026-10' })
    expect(ledgerMonthOf(undefined, ledgerBounds(snapshot, main), AS_OF)).toBe('2026-10')
    expect(ledgerMonthOf('2026-09', ledgerBounds(snapshot, main), AS_OF)).toBe('2026-09')
    expect(ledgerMonthOf('2025-01', ledgerBounds(snapshot, main), AS_OF)).toBe('2026-09')
    expect(ledgerMonthOf('2027-13', ledgerBounds(snapshot, main), AS_OF)).toBe('2026-10')
    const ahead = snapshotOf(abroad, (s) => s.doc.transactions.push({ id: 'ahead', account_id: 'main', posted_on: '2026-12-02', amount_minor: -1000, kind: 'expense', description: 'Booked' }))
    expect(ledgerBounds(ahead, ahead.doc.accounts.find((a) => a.id === 'main')!)).toEqual({ first: '2026-09', last: '2026-12' })
  })

  it('heads each day as Today, Yesterday or Tomorrow, else its weekday and date', () => {
    expect([AS_OF, '2026-10-08', '2026-10-10', '2026-10-06', '2025-12-31'].map((d) => ledgerDayTitle(d, AS_OF, 'en-IE'))).toEqual(['Today', 'Yesterday', 'Tomorrow', 'Tuesday, 6 October', 'Wednesday 31 December 2025'])
  })

  it('holds the 92-row month of the large household in one list', () => {
    const snapshot = snapshotOf(markSize)
    const items = ledgerItems(snapshot, ledgerMonth(snapshot, 'main', '2026-10'))
    expect(items.filter((i) => i.type === 'row')).toHaveLength(92)
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
  })
})

describe('ledger edits', () => {
  it('moves both legs of a transfer by the same number of days, so the gap between them stays (one write)', () => {
    const snapshot = snapshotOf()
    // Paid from Pesos on 10 Sep, landed on the card on 11 Sep; the card's leg moves to 14 Sep.
    const rows = rewritten(snapshot, 'rewards-paid-before-in', { day: '2026-09-14' })
    expect(rows.map((r) => [r.id, r.account_id, r.before.posted_on, r.after.posted_on, r.after.amount_minor])).toEqual([
      ['rewards-paid-before-out', 'pesos', '2026-09-10', '2026-09-13', -3800000],
      ['rewards-paid-before-in', 'rewards-card', '2026-09-11', '2026-09-14', 3800000],
    ])
    expect(daysBetween(rows[0]!.after.posted_on, rows[1]!.after.posted_on)).toBe(1)
    expect(rows.every((r) => r.household_id === HOUSEHOLD && r.kind === 'transfer' && r.transfer_id === 'rewards-paid-before')).toBe(true)
  })

  it('sets both legs of a same-currency transfer to the new amount (one write), and never sends the plan link', () => {
    const snapshot = snapshotOf()
    const rows = rewritten(snapshot, 'tax-last-out', { amount: '700.00' })
    expect(rows.map((r) => [r.id, r.before.amount_minor, r.after.posted_on, r.after.amount_minor])).toEqual([
      ['tax-last-out', -60000, '2026-09-28', -70000],
      ['tax-last-in', 60000, '2026-09-28', 70000],
    ])
    // The outgoing leg is linked; the edit leaves that to the table, so a link made or removed elsewhere stands.
    expect(snapshot.doc.transactions.find((t) => t.id === 'tax-last-out')?.plan_item_id).toBe('tax-set-aside')
    expect(rows.flatMap((r) => [r, r.after]).some((part) => 'plan_item_id' in part || 'period' in part)).toBe(false)
  })

  it('keeps each leg’s own amount across currencies, and sends both legs', () => {
    const snapshot = snapshotOf()
    const t = target(snapshot, 'topup-now-in')
    expect(t.across).toBe(true)
    expect(editDraft(t, LOCALE)).toEqual({ day: '2026-10-02', amount: '500.00', received: '34750.00', note: 'Top-up' })
    const rows = rewritten(snapshot, 'topup-now-in', { received: '35000' })
    expect(rows.map((r) => [r.id, r.after.amount_minor])).toEqual([
      ['topup-now-out', -50000],
      ['topup-now-in', 3500000],
    ])
  })

  it('keeps a row’s sign, and writes only its day, amount and note, guarded by what was loaded', () => {
    const snapshot = snapshotOf()
    const [row] = rewritten(snapshot, 'groceries-4', { amount: '95', note: ' Supermarket and bakery ' })
    const before = snapshot.doc.transactions.find((t) => t.id === 'groceries-4')!
    expect(row).toEqual({
      id: 'groceries-4',
      household_id: HOUSEHOLD,
      account_id: 'main',
      kind: 'expense',
      transfer_id: null,
      before: { posted_on: before.posted_on, amount_minor: before.amount_minor, description: before.description },
      after: { posted_on: before.posted_on, amount_minor: -9500, description: 'Supermarket and bakery' },
    })
    // The row as it reads after the write passes the same row checks post_batch applies; batch_id is the table's, which post_batch stamps itself.
    const fields: Record<string, unknown> = { ...before, ...row!.after }
    delete fields.batch_id
    const ids = { id: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', account_id: '7a2e3d4c-5b6f-4071-9b8c-0d1e2f3a4b5c', category_id: '8b3f4e5d-6c70-4182-8c9d-1e2f3a4b5c6d' }
    expect(postBatchInput.safeParse({ batch_id: HOUSEHOLD, rows: [{ ...fields, ...ids }] }).success).toBe(true)
  })

  it('refuses a day before either leg’s account opened, and an amount that is not above 0', () => {
    const snapshot = snapshotOf()
    const t = target(snapshot, 'rewards-paid-before-in')
    const read = readEdit(t, { ...editDraft(t, LOCALE), day: '2026-08-31', amount: '0' }, OPTIONS)
    expect(read).toEqual({ ok: false, errors: { day: 'Rewards card opened on 2026-09-01, so this cannot be earlier.', amount: 'Enter an amount above 0.' } })
    // The other leg is the one that would fall before its account opened.
    const shifted = snapshotOf(abroad, (s) => (s.doc.accounts.find((a) => a.id === 'pesos')!.opening_date = '2026-09-10'))
    const leg = target(shifted, 'rewards-paid-before-in')
    expect(readEdit(leg, { ...editDraft(leg, LOCALE), day: '2026-09-10' }, OPTIONS)).toMatchObject({ ok: false, errors: { day: 'Pesos opened on 2026-09-10, so its leg cannot be earlier.' } })
    expect(readEdit(t, { ...editDraft(t, LOCALE), day: '2026-02-30' }, OPTIONS)).toMatchObject({ ok: false, errors: { day: 'Pick the day.' } })
  })

  it('sends nothing when nothing changed, and says which month the row now sits in', () => {
    const snapshot = snapshotOf()
    const t = target(snapshot, 'groceries-4')
    expect(readEdit(t, editDraft(t, LOCALE), OPTIONS)).toEqual({ ok: true, edit: null, month: '2026-10', partner_day: null })
    expect(readEdit(t, { ...editDraft(t, LOCALE), day: '2026-09-30' }, OPTIONS)).toMatchObject({ ok: true, month: '2026-09' })
  })

  it('deletes a row together with its transfer partner in one request', () => {
    const snapshot = snapshotOf()
    expect(deleteEdit(target(snapshot, 'topup-now-in'))).toEqual({ kind: 'delete', row_id: 'topup-now-in', transfer_id: 'topup-now' })
    expect(deleteEdit(target(snapshot, 'groceries-4'))).toEqual({ kind: 'delete', row_id: 'groceries-4', transfer_id: null })
  })

  it('jumps to the month of the row a save wrote on this account (invariant 191)', () => {
    const rows = [
      { account_id: 'main', posted_on: '2026-09-30' },
      { account_id: 'pesos', posted_on: '2026-10-02' },
    ]
    expect(savedMonth(rows, 'main')).toBe('2026-09')
    expect(savedMonth(rows, 'pesos')).toBe('2026-10')
    expect(savedMonth(rows, 'tax')).toBeNull()
  })
})
