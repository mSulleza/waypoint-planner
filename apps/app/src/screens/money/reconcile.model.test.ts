import { addDays, buildSnapshot, ledgerSum, postBatchInput, type Snapshot } from '@waypoint/core'
import { abroad, type Sample } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { DataError } from '../../data/errors'
import { adjustmentBatch, adjustmentProblem, missingParams, reconcileView, type ReconcileView } from './reconcile.model'

const AS_OF = '2026-10-09'
const LOCALE = 'en-PH'
const IDS = { batch_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', row_id: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a' }

function snapshotOf(edit?: (sample: Sample) => void): Snapshot {
  const sample = abroad(AS_OF)
  edit?.(sample)
  return buildSnapshot(sample.doc, AS_OF, sample.rates)
}

function view(snapshot: Snapshot, account: string, bank: string): ReconcileView {
  const v = reconcileView(snapshot, account, bank, LOCALE)
  if (!v) throw new Error(`no account ${account}`)
  return v
}

describe('Reconcile', () => {
  it('shows the exact gap: what the bank says minus the opening balance and every row to today', () => {
    // A row entered for a later day is not in the bank's figure yet.
    const snapshot = snapshotOf((s) => s.doc.transactions.push({ id: 'later', account_id: 'main', posted_on: addDays(AS_OF, 2), amount_minor: -20000, kind: 'expense', description: 'Booked' }))
    expect(view(snapshot, 'main', '')).toMatchObject({ ledger_minor: 645000, bank_minor: null, gap_minor: null })
    expect(view(snapshot, 'main', '6,460.00')).toMatchObject({ ledger_minor: 645000, bank_minor: 646000, gap_minor: 1000 })
    expect(view(snapshot, 'main', '€6,437.55')).toMatchObject({ gap_minor: -1245 })
    expect(view(snapshot, 'main', '6450')).toMatchObject({ gap_minor: 0 })
    expect(view(snapshot, 'main', 'six')).toMatchObject({ bank_minor: null, gap_minor: null })
    expect(view(snapshot, 'main', '').ledger_minor).toBe(ledgerSum(snapshot, 'main', AS_OF))
  })

  it('takes a card’s figure as what is owed, and keeps the gap in balance terms', () => {
    const v = view(snapshotOf(), 'rewards-card', '42,500.00')
    expect(v).toMatchObject({ debt: true, ledger_minor: -4200000, bank_minor: -4250000, gap_minor: -50000 })
    // The bank shows 500.00 more owed: a charge Waypoint is missing.
    expect(missingParams(v)).toEqual({ mode: 'out', from: 'rewards-card', amount: '50000' })
  })

  it('adds a missing transaction only through the Add sheet, prefilled with the gap', () => {
    const snapshot = snapshotOf()
    expect(missingParams(view(snapshot, 'main', '6,460.00'))).toEqual({ mode: 'in', to: 'main', amount: '1000' })
    expect(missingParams(view(snapshot, 'main', '6,437.55'))).toEqual({ mode: 'out', from: 'main', amount: '1245' })
    expect(missingParams(view(snapshot, 'main', '6,450.00'))).toBeNull()
    expect(missingParams(view(snapshot, 'main', ''))).toBeNull()
  })

  it('lists the unlinked rows of the last 7 days, newest first, so a late or doubled charge can be checked first (invariant 25)', () => {
    const snapshot = snapshotOf((s) => {
      s.doc.plan_items.push({ id: 'card-pay', kind: 'transfer', name: 'Shopping card payment', to_account_id: 'shopping-card', amount_minor: 100000, starts_on: '2026-10-05' })
      s.doc.transactions.push(
        // A payment linked by its outgoing leg counts as linked on the card too.
        { id: 'paid-out', account_id: 'pesos', posted_on: '2026-10-05', amount_minor: -100000, kind: 'transfer', description: 'Card payment', transfer_id: 'paid', plan_item_id: 'card-pay', period: '2026-10-05' },
        { id: 'paid-in', account_id: 'shopping-card', posted_on: '2026-10-05', amount_minor: 100000, kind: 'transfer', description: 'Card payment', transfer_id: 'paid' },
      )
    })
    const main = view(snapshot, 'main', '')
    expect(main.since).toBe('2026-10-03')
    // Rent (1 Oct) and the top-up (2 Oct) are older than the 7 days.
    expect(main.recent.map((l) => [l.posted_on, l.title])).toEqual([
      ['2026-10-06', 'Bakery'],
      ['2026-10-03', 'Supermarket'],
    ])
    // The friend's repayment on 6 Oct is linked to its income item.
    expect(view(snapshot, 'pesos', '').recent).toEqual([])
    expect(view(snapshot, 'shopping-card', '').recent.map((l) => l.id)).toEqual(['pharmacy-now'])
  })

  it('writes nothing by itself: an adjustment needs a note, and is checked to land on the bank’s figure (invariant 24)', () => {
    const snapshot = snapshotOf()
    const v = view(snapshot, 'main', '6,460.00')
    expect(adjustmentBatch(snapshot, v, '  ', IDS)).toEqual({ ok: false, error: 'Say what the adjustment is for, so it can be found later.' })
    expect(adjustmentBatch(snapshot, view(snapshot, 'main', ''), 'Interest', IDS)).toEqual({ ok: false, error: 'Enter what the bank says first.' })
    expect(adjustmentBatch(snapshot, view(snapshot, 'main', '6450'), 'Interest', IDS)).toEqual({ ok: false, error: 'The balances already match.' })
    const read = adjustmentBatch(snapshot, v, ' Interest paid ', IDS)
    expect(read).toEqual({
      ok: true,
      batch: {
        batch_id: IDS.batch_id,
        expect_before: { main: 645000 },
        expect_after: { main: 646000 },
        rows: [{ id: IDS.row_id, account_id: 'main', posted_on: AS_OF, amount_minor: 1000, kind: 'adjustment', category_id: null, description: 'Interest paid', transfer_id: null, plan_item_id: null, period: null, external_id: null }],
      },
    })
    // With database ids, it is a batch post_batch takes.
    if (!read.ok) throw new Error('no batch')
    const account = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b'
    const batch = { ...read.batch, expect_before: { [account]: 645000 }, expect_after: { [account]: 646000 }, rows: read.batch.rows.map((r) => ({ ...r, account_id: account })) }
    expect(postBatchInput.safeParse(batch).success).toBe(true)
  })

  it('says a changed balance in plain words, once the latest balance is on screen', () => {
    const changed = new DataError('rejected', 'The server did not accept this change.', { code: 'balance_mismatch' })
    expect(adjustmentProblem(changed)).toBe('The balance changed since this opened, so nothing was saved. The gap below now uses the latest balance; check it again.')
    expect(adjustmentProblem(new DataError('network', 'Waypoint could not reach the server.'))).toBe('Waypoint could not reach the server.')
  })
})
