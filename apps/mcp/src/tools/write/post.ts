import { checkInput, monthKey, postBatchInput, type PostBatchInput, type Snapshot } from '@waypoint/core'
import { postTransactionsInput, type PostTransactionsInput } from '@waypoint/core/agent'
import { Refusal } from '../../errors'
import { accountOf, AMOUNTS, DATA_TEXT, link } from '../read/shape'
import { categoryOf, itemOf, minorOf, periodProblem, refusal, rowId, WRITES, type WriteTool } from './shape'

// post_batch's input: each amount read once in its row's account currency, a missing id made from the batch id, and every row checked as core checks it.
export function batchOf(snapshot: Snapshot, args: PostTransactionsInput): PostBatchInput {
  const rows = args.rows.map((r, i) => {
    const account = accountOf(snapshot, r.account_id)
    if (r.category_id) categoryOf(snapshot, r.category_id)
    if (r.plan_item_id) {
      const problem = r.period ? periodProblem(itemOf(snapshot, r.plan_item_id), r.period) : null
      if (problem) throw new Refusal('bad_input', `rows[${i}].period: ${problem}. Nothing was saved.`, { field: `rows[${i}].period` })
    }
    return {
      id: r.id ?? rowId(args.batch_id, i),
      account_id: r.account_id,
      posted_on: r.posted_on,
      amount_minor: minorOf(r.amount, account.currency, `rows[${i}].amount`),
      kind: r.kind,
      category_id: r.category_id ?? null,
      description: r.description ?? '',
      transfer_id: r.transfer_id ?? null,
      plan_item_id: r.plan_item_id ?? null,
      period: r.period ?? null,
      external_id: r.external_id ?? null,
    }
  })
  const balances = (field: 'expect_before' | 'expect_after') => {
    const given = args[field]
    if (given === undefined) return {}
    return { [field]: Object.fromEntries(Object.entries(given).map(([id, text]) => [id, minorOf(text, accountOf(snapshot, id).currency, `${field}.${id}`)])) }
  }
  const checked = checkInput(postBatchInput, { batch_id: args.batch_id, rows, ...(args.allow_over === undefined ? {} : { allow_over: args.allow_over }), ...balances('expect_before'), ...balances('expect_after') })
  if (!checked.ok) throw new Refusal('bad_input', `Nothing was saved: ${checked.errors.map((e) => e.replace(/\.amount_minor:/, '.amount:')).join('; ')}`, { issues: checked.errors })
  return checked.value
}

interface Posted {
  status: 'applied' | 'already_applied'
  batch_id: string
  inserted: number
}

export const postTransactions: WriteTool<typeof postTransactionsInput> = {
  name: 'post_transactions',
  description: [
    'Records transactions as one batch through post_batch, in one database transaction: rows as post_batch takes them, each amount a decimal string in its account’s currency (negative for money out: an expense is negative, income positive; a transfer is two rows sharing a transfer_id, the outgoing leg negative, each in its own currency).',
    'batch_id is a new random uuid for each new batch. Row ids may be left out: they are made from the batch id and the row’s place, so resending the same call answers already_applied and saves nothing twice; reusing a batch_id with other rows is refused.',
    'A row settles a plan occurrence with plan_item_id and period (list_open gives both). Put the bank’s reference in external_id (such as a bank transfer id), so posting it again is refused as already_recorded.',
    'Pass expect_before and expect_after, {account id: decimal balance as the bank shows it}: a mismatch saves nothing and names the actual balance. A card payment above what is left on the latest entered statement is refused unless allow_over is true.',
    'Undo a batch with delete_transactions and its batch_id.',
    WRITES,
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: postTransactionsInput,
  destructive: false,
  idempotent: true,
  async run(io, args) {
    const batch = batchOf(io.before.snapshot, args)
    const reply = await io.send((db) => db.rpc('post_batch', { p_batch: batch }))
    if (reply.error) throw refusal(reply.error, io.before)
    const posted = reply.data as Posted
    const [first] = batch.rows
    return {
      status: posted.status,
      batch_id: posted.batch_id,
      inserted: posted.inserted,
      row_ids: batch.rows.map((r) => r.id),
      link: first ? link(io.before, `/money/${encodeURIComponent(first.account_id)}`, { month: monthKey(first.posted_on) }) : null,
    }
  },
}
