import { monthKey, type Snapshot } from '@waypoint/core'
import { deleteTransactionsInput, type DeleteTransactionsInput } from '@waypoint/core/agent'
import { Refusal } from '../../errors'
import { DATA_TEXT, link } from '../read/shape'
import { refusal, transactionOf, WRITES, type WriteTool } from './shape'

const NOTHING = 'Nothing was deleted'

// The filter of one REST delete: the rows by id, and every leg of their transfers, so a transfer goes whole (invariant 7).
export function deleteFilter(snapshot: Snapshot, ids: readonly string[]): string {
  const rows = ids.map((id) => transactionOf(snapshot, id))
  const transfers = [...new Set(rows.flatMap((r) => (r.transfer_id === null ? [] : [r.transfer_id])))]
  return [`id.in.(${rows.map((r) => r.id).join(',')})`, ...(transfers.length > 0 ? [`transfer_id.in.(${transfers.join(',')})`] : [])].join(',')
}

export const deleteTransactions: WriteTool<typeof deleteTransactionsInput> = {
  name: 'delete_transactions',
  description: [
    'Deletes transactions: by ids (each row, and the other leg of any transfer among them) or by batch_id (every row post_transactions saved in that batch, which undoes the call).',
    'One request; an id the household does not have deletes nothing.',
    WRITES,
    DATA_TEXT,
  ].join(' '),
  input: deleteTransactionsInput,
  destructive: true,
  idempotent: false,
  async run(io, args: DeleteTransactionsInput) {
    const { snapshot } = io.before
    const filter = args.ids === undefined ? null : deleteFilter(snapshot, args.ids)
    const reply = await io.send((db) => {
      const rows = db.from('transactions').delete()
      return (filter === null ? rows.eq('batch_id', args.batch_id ?? '') : rows.or(filter)).select('id,account_id,posted_on')
    })
    if (reply.error) throw refusal(reply.error, io.before, NOTHING)
    const deleted = (Array.isArray(reply.data) ? reply.data : []) as { id: string; account_id: string; posted_on: string }[]
    if (deleted.length === 0) {
      throw args.batch_id === undefined
        ? new Refusal('stale', `${NOTHING}: the rows were deleted elsewhere since this call read the household.`)
        : new Refusal('not_found', `${NOTHING}: no transaction in this household has batch_id ${args.batch_id}. get_ledger shows each row’s batch_id.`, { batch_id: args.batch_id })
    }
    const [first] = [...deleted].sort((a, b) => (a.posted_on < b.posted_on ? -1 : 1))
    return {
      status: 'deleted',
      batch_id: args.batch_id ?? null,
      deleted_ids: deleted.map((d) => d.id).sort(),
      link: first ? link(io.before, `/money/${encodeURIComponent(first.account_id)}`, { month: monthKey(first.posted_on) }) : null,
    }
  },
}
