import { addDays, ledgerSum, parseAmount, snapshotIndex, type Account, type PostBatchInput, type Snapshot } from '@waypoint/core'
import type { DataError } from '../../data/errors'
import { lineOf, partnerOf, type LedgerLine } from './ledger.model'

// Spec §7 Reconcile: the gap between the bank's figure and the ledger to today, closed only by a row the person chooses to add (invariants 24 and 25).

export const RECENT_DAYS = 7

export interface ReconcileView {
  account: Account
  // A card or loan: the bank's figure is what is owed, entered as a positive amount.
  debt: boolean
  // Opening balance plus every row to today, as the bank counts it.
  ledger_minor: number
  // The bank's figure as a balance (a debt's is below zero), or null until it reads as an amount.
  bank_minor: number | null
  // bank − ledger: above zero when the bank shows more than Waypoint.
  gap_minor: number | null
  // The first of the last 7 days.
  since: string
  // Rows of the last 7 days with no link to the plan, newest first: where a charge entered twice or a wrong amount shows up.
  recent: LedgerLine[]
}

export function reconcileView(snapshot: Snapshot, accountId: string, bankText: string, locale: string): ReconcileView | null {
  const index = snapshotIndex(snapshot)
  const account = index.accounts.get(accountId)
  if (!account) return null
  const debt = account.kind !== 'cash'
  const ledger = ledgerSum(snapshot, accountId, snapshot.as_of)
  const typed = bankText.trim() === '' ? null : parseAmount(bankText, locale, account.currency)
  const bank = typed === null ? null : debt ? -typed : typed
  const since = addDays(snapshot.as_of, 1 - RECENT_DAYS)
  const rows = index.rowsByAccount.get(accountId) ?? []
  let balance = account.opening_balance_minor
  const recent: LedgerLine[] = []
  for (const row of rows) {
    if (row.posted_on > snapshot.as_of) break
    balance += row.amount_minor
    if (row.posted_on < since) continue
    // A transfer links by its outgoing leg, so a card's incoming payment counts as linked when its partner is.
    const linked = row.plan_item_id !== null || (partnerOf(snapshot, row)?.plan_item_id ?? null) !== null
    if (!linked) recent.push(lineOf(snapshot, { ...row, running_balance_minor: balance }))
  }
  recent.reverse()
  return { account, debt, ledger_minor: ledger, bank_minor: bank, gap_minor: bank === null ? null : bank - ledger, since, recent }
}

export interface MissingParams {
  mode: 'in' | 'out'
  from?: string
  to?: string
  // Minor units of the account's currency, as the Add sheet's address takes them.
  amount: string
}

// Add missing transaction: money in when the bank shows more, money out when it shows less. Loans take no Add sheet row, so they get none.
export function missingParams(view: ReconcileView): MissingParams | null {
  const gap = view.gap_minor
  if (gap === null || gap === 0 || view.account.kind === 'loan') return null
  const amount = String(Math.abs(gap))
  return gap > 0 ? { mode: 'in', to: view.account.id, amount } : { mode: 'out', from: view.account.id, amount }
}

export type AdjustmentRead = { ok: true; batch: PostBatchInput } | { ok: false; error: string }

// Post adjustment: one row of the gap dated today, saved only while the ledger still reads what the person saw and lands exactly on the bank's figure.
export function adjustmentBatch(snapshot: Snapshot, view: ReconcileView, note: string, ids: { batch_id: string; row_id: string }): AdjustmentRead {
  const gap = view.gap_minor
  if (gap === null || view.bank_minor === null) return { ok: false, error: 'Enter what the bank says first.' }
  if (gap === 0) return { ok: false, error: 'The balances already match.' }
  const description = note.trim()
  if (description === '') return { ok: false, error: 'Say what the adjustment is for, so it can be found later.' }
  const id = view.account.id
  return {
    ok: true,
    batch: {
      batch_id: ids.batch_id,
      expect_before: { [id]: view.ledger_minor },
      expect_after: { [id]: view.bank_minor },
      rows: [
        {
          id: ids.row_id,
          account_id: id,
          posted_on: snapshot.as_of,
          amount_minor: gap,
          kind: 'adjustment',
          category_id: null,
          description,
          transfer_id: null,
          plan_item_id: null,
          period: null,
          external_id: null,
        },
      ],
    },
  }
}

// A refused adjustment in plain words. A changed balance shows once the household has reloaded (usePostBatch), so the gap below is already the new one.
export function adjustmentProblem(error: DataError): string {
  if (error.code === 'balance_mismatch') return 'The balance changed since this opened, so nothing was saved. The gap below now uses the latest balance; check it again.'
  return error.message
}
