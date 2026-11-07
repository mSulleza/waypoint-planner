import { expandPlan, monthKey, occurrenceId, snapshotIndex, validateLink, type Snapshot, type Transaction } from '@waypoint/core'
import { setLinkInput } from '@waypoint/core/agent'
import { Refusal } from '../../errors'
import { amount, AMOUNTS, DATA_TEXT, link } from '../read/shape'
import { afterWrite, changed, itemOf, periodProblem, transactionOf, WRITES, type WriteIO, type WriteTool } from './shape'

// Postgres array text for an exact match on skip_periods: '{2026-10-01,2026-11-01}'.
const arrayText = (days: readonly string[]) => `{${days.join(',')}}`

// A transfer links by its outgoing leg (core validateLink), so either leg's id names the link.
function linkingLeg(snapshot: Snapshot, row: Transaction): Transaction {
  if (row.transfer_id === null || row.amount_minor < 0) return row
  return snapshotIndex(snapshot).transfers.get(row.transfer_id)?.[0] ?? row
}

// The occurrence as the engine sees it after the write.
async function occurrenceAfter(io: WriteIO, planItemId: string, period: string) {
  const after = await afterWrite(io)
  if (!after) return null
  const { snapshot } = after
  const found = expandPlan(snapshot).occurrences.find((o) => o.id === occurrenceId(planItemId, period))
  if (!found) return null
  const currency = snapshotIndex(snapshot).accounts.get(found.account_id)?.currency ?? snapshot.doc.household.base_currency
  return { id: found.id, date: found.date, state: found.state, carried_to: found.carried_to, skipped: found.skipped, amount: amount(found.amount_minor, currency), linked: amount(found.linked_minor, currency), open: amount(found.open_minor, currency), linked_row_ids: found.links.map((t) => t.id) }
}

export const setLink: WriteTool<typeof setLinkInput> = {
  name: 'set_link',
  description: [
    'Settles or reopens one plan occurrence. link: a recorded row settles plan_item_id’s occurrence in period (list_open gives both; a transfer links by its outgoing leg, and either leg’s id works). unlink: the row settles nothing.',
    'skip: the occurrence is not expected this time, which for income means the money will not come; unskip undoes it. Each is one REST update that changes only while the row or the item still reads as this call found it.',
    'Asking for what already holds answers already_applied. The answer gives the occurrence’s state after the change.',
    WRITES,
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: setLinkInput,
  destructive: false,
  idempotent: true,
  async run(io, args) {
    const { snapshot } = io.before
    const answer = async (status: string, planItemId: string | null, period: string | null, rowId: string | null) => ({
      status,
      batch_id: null,
      row_id: rowId,
      occurrence: planItemId === null || period === null ? null : await occurrenceAfter(io, planItemId, period),
      link: period === null ? null : link(io.before, '/months', { month: monthKey(period), view: 'todo' }),
    })

    if (args.action === 'link' || args.action === 'unlink') {
      const row = linkingLeg(snapshot, transactionOf(snapshot, args.row_id ?? ''))
      if (args.action === 'unlink') {
        if (row.plan_item_id === null || row.period === null) return answer('already_applied', null, null, row.id)
        const [item, period] = [row.plan_item_id, row.period]
        await changed(io, (db) => db.from('transactions').update({ plan_item_id: null, period: null }).eq('id', row.id).eq('plan_item_id', item).eq('period', period).select('id'))
        return answer('unlinked', item, period, row.id)
      }
      const item = itemOf(snapshot, args.plan_item_id ?? '')
      const period = args.period ?? ''
      const problem = periodProblem(item, period)
      if (problem) throw new Refusal('bad_input', `Nothing was saved: ${problem}.`, { field: 'period' })
      if (row.plan_item_id === item.id && row.period === period) return answer('already_applied', item.id, period, row.id)
      if (row.plan_item_id !== null) throw new Refusal('already_linked', `Nothing was saved: row ${row.id} already settles plan item ${row.plan_item_id} for ${row.period}. Unlink it first.`, { row_id: row.id, plan_item_id: row.plan_item_id, period: row.period })
      const partner = row.transfer_id === null ? null : (snapshotIndex(snapshot).transfers.get(row.transfer_id)?.find((t) => t.id !== row.id) ?? null)
      const errors = validateLink(row, partner, item, snapshot.doc.accounts)
      if (errors.length > 0) throw new Refusal('bad_link', `Nothing was saved: row ${row.id} cannot settle plan item ${item.id}: ${errors.join('; ')}.`, { issues: errors })
      await changed(io, (db) => db.from('transactions').update({ plan_item_id: item.id, period }).eq('id', row.id).is('plan_item_id', null).select('id'))
      return answer('linked', item.id, period, row.id)
    }

    const item = itemOf(snapshot, args.plan_item_id ?? '')
    const period = args.period ?? ''
    const problem = periodProblem(item, period)
    if (problem) throw new Refusal('bad_input', `Nothing was saved: ${problem}.`, { field: 'period' })
    const skipped = item.skip_periods.includes(period)
    if (skipped === (args.action === 'skip')) return answer('already_applied', item.id, period, null)
    const after = args.action === 'skip' ? [...item.skip_periods, period].sort() : item.skip_periods.filter((p) => p !== period)
    // Only while the list is still the one this call read, so two writers never drop each other's period.
    await changed(io, (db) => db.from('plan_items').update({ skip_periods: after }).eq('id', item.id).eq('skip_periods', arrayText(item.skip_periods)).select('id'))
    return answer(args.action === 'skip' ? 'skipped' : 'unskipped', item.id, period, null)
  },
}
