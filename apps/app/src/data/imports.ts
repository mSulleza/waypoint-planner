import { addDays } from '@waypoint/core'
import { rpcError } from './errors'
import type { WaypointClient } from './supabase'

// Days either side of a file's dates also searched, as a bank can re-date a row between two exports while its reference stays the same.
export const RECORDED_MARGIN_DAYS = 7

// A row already saved under an external id: its day and amount tell which of a file's rows it is when the file repeats a reference.
export interface RecordedRow {
  posted_on: string
  amount_minor: number
}

// The external ids already on one account around a file's dates, read in one request, so the review greys rows saved by an earlier import. post_batch still refuses any it misses (already_recorded).
export async function recordedIds(client: Pick<WaypointClient, 'from'>, accountId: string, from: string, to: string): Promise<ReadonlyMap<string, RecordedRow>> {
  const { data, error, status } = await client
    .from('transactions')
    .select('external_id,posted_on,amount_minor')
    .eq('account_id', accountId)
    .gte('posted_on', addDays(from, -RECORDED_MARGIN_DAYS))
    .lte('posted_on', addDays(to, RECORDED_MARGIN_DAYS))
    .not('external_id', 'is', null)
  if (error) throw rpcError('transactions', error, status)
  return new Map((Array.isArray(data) ? (data as (RecordedRow & { external_id: string })[]) : []).map((r) => [r.external_id, { posted_on: r.posted_on, amount_minor: Number(r.amount_minor) }]))
}
