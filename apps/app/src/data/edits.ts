import type { Account, Category, Household, PlanItem, Statement, Transaction } from '@waypoint/core'
import type { CsvMapping } from '@waypoint/core/csv'
import { DataError, rpcError, type RpcFailure } from './errors'
import type { WaypointClient } from './supabase'

// The columns a ledger edit writes. The plan link, category and batch stay as the table holds them, so a link made elsewhere survives.
export type RowChange = Pick<Transaction, 'posted_on' | 'amount_minor' | 'description'>

// One row of a ledger edit: what the screen loaded and what it should read now. The fixed columns are what a new-row check needs, since an upsert is checked as an insert first.
export interface Rewrite extends Pick<Transaction, 'id' | 'account_id' | 'kind' | 'transfer_id'> {
  // The signed-in user, as row-level security checks.
  household_id: string
  before: RowChange
  after: RowChange
}

// A card statement as the table holds it: the printed figures and the signed-in user, as row-level security checks.
export type SavedStatement = Statement & { household_id: string }

// The columns the plan item editor sets. skip_periods stays as the table holds it, so a Skip made elsewhere survives a Save.
export const ITEM_VALUES = ['kind', 'name', 'from_account_id', 'to_account_id', 'category_id', 'amount_minor', 'every', 'starts_on', 'ends_on', 'roll', 'confidence', 'stops_with_income'] as const satisfies readonly (keyof PlanItem)[]
export type ItemValues = Pick<PlanItem, (typeof ITEM_VALUES)[number]>

// A plan item as the table holds it: the row and the signed-in user, as row-level security checks.
export type SavedItem = PlanItem & { household_id: string }

// What split_plan_item carries into the row it starts (spec §4): any of these, and day for an item that repeats monthly, every 3 months or yearly.
export type SplitPatch = Partial<Pick<PlanItem, 'amount_minor' | 'name' | 'from_account_id' | 'to_account_id' | 'category_id' | 'every' | 'roll' | 'confidence' | 'stops_with_income' | 'ends_on'>> & { day?: number }

// The household settings Settings sets; track_from stays as set-up wrote it.
export const HOUSEHOLD_VALUES = ['base_currency', 'timezone', 'locale', 'payoff_order'] as const satisfies readonly (keyof Household)[]
export type HouseholdValues = Pick<Household, (typeof HOUSEHOLD_VALUES)[number]>

// The columns the account editor sets. csv_mapping and sort_order stay as the table holds them, so a mapping an import saved elsewhere survives a Save.
export const ACCOUNT_VALUES = ['name', 'kind', 'currency', 'opening_balance_minor', 'opening_date', 'terms', 'funded_from_account_id', 'floor_windows', 'fx_fee_pct', 'archived_at'] as const satisfies readonly (keyof Account)[]
export type AccountValues = Pick<Account, (typeof ACCOUNT_VALUES)[number]>

// An account as the table holds it: the row and the signed-in user, as row-level security checks.
export type SavedAccount = Account & { household_id: string }

export const CATEGORY_VALUES = ['name', 'archived_at'] as const satisfies readonly (keyof Category)[]
export type CategoryValues = Pick<Category, (typeof CATEGORY_VALUES)[number]>

export type SavedCategory = Category & { household_id: string }

// To-do's marks (spec §6.6), the ledger's edits, the Statement sheet, the plan item editor and Settings: each writes with one REST request or one database function, under the same row-level security as every read.
export type Edit =
  // Settles an occurrence with a row already saved, at any amount.
  | { kind: 'link'; row_id: string; plan_item_id: string; period: string }
  | { kind: 'unlink'; row_id: string; plan_item_id: string; period: string }
  // A plan item's skipped periods, as loaded and as wanted: Skip adds the period, Unskip takes it out.
  | { kind: 'skips'; plan_item_id: string; before: readonly string[]; after: readonly string[] }
  // Removes the row, and both legs when it is a transfer (invariant 18).
  | { kind: 'delete'; row_id: string; transfer_id: string | null }
  // Sets the day, amount and note of a row, or of both legs of a transfer in one request so its pair check sees them move together; only while each still reads as loaded.
  | { kind: 'rewrite'; rows: readonly Rewrite[] }
  // A new printed statement. A retry from the same sheet sends the same id, which changes that row and adds none.
  | { kind: 'add_statement'; row: SavedStatement }
  // A saved statement's printed figures, only while the table still holds them as loaded.
  | { kind: 'edit_statement'; before: SavedStatement; after: SavedStatement }
  // A new plan item. A retry from the same editor sends the same id, which changes that row and adds none.
  | { kind: 'add_item'; row: SavedItem }
  // A saved plan item's columns, only while the table still holds every one as loaded.
  | { kind: 'edit_item'; id: string; before: ItemValues; after: Partial<ItemValues> }
  // Ends the item the day before `from` and starts a copy with the patch, moving later links and skips to it (split_plan_item).
  | { kind: 'split_item'; id: string; from: string; patch: SplitPatch }
  // The database refuses while any transaction links to it.
  | { kind: 'delete_item'; id: string }
  // The household's settings, only while each reads as loaded.
  | { kind: 'edit_household'; id: string; before: HouseholdValues; after: Partial<HouseholdValues> }
  // A new account; a retry from the same editor sends the same id, which changes that row and adds none.
  | { kind: 'add_account'; row: SavedAccount }
  // A saved account's columns, archiving included, only while the table still holds every one as loaded.
  | { kind: 'edit_account'; id: string; before: AccountValues; after: Partial<AccountValues> }
  | { kind: 'add_category'; row: SavedCategory }
  | { kind: 'edit_category'; id: string; before: CategoryValues; after: Partial<CategoryValues> }
  // An account's CSV columns, remembered for every device; this column alone, so a mapping saved last wins and nothing else changes.
  | { kind: 'csv_mapping'; account_id: string; mapping: CsvMapping }
  // Undo of one import: every row it saved, and only those (spec §4 batch_id).
  | { kind: 'delete_batch'; batch_id: string }

export type EditClient = Pick<WaypointClient, 'from' | 'rpc'>

// What each request answers: the rows it changed, so a row someone else changed first is caught.
interface Reply {
  data: unknown
  error: RpcFailure | null
  status: number
}

const STALE = 'This changed elsewhere since Waypoint loaded it, so nothing was saved. Check the latest and try again.'

// Postgres array text for an exact match on skip_periods: '{2026-10-01,2026-11-01}'.
const arrayText = (days: readonly string[]) => `{${days.join(',')}}`

// The filter Delete payment sends: the row by its id, and every leg of its transfer.
export function deleteFilter(rowId: string, transferId: string | null): string {
  return transferId === null ? `id.in.(${rowId})` : `id.in.(${rowId}),transfer_id.in.(${transferId})`
}

type Loaded = Record<'id' | 'posted_on' | 'amount_minor' | 'description', unknown>

const reads = (row: Loaded, wanted: Rewrite) => row.id === wanted.id && row.posted_on === wanted.before.posted_on && Number(row.amount_minor) === wanted.before.amount_minor && row.description === wanted.before.description

async function rewrite(client: EditClient, rows: readonly Rewrite[]): Promise<Reply> {
  const [only] = rows
  // One row: an update that matches only while the row reads as loaded, so a row changed or deleted elsewhere is never written back.
  if (only && rows.length === 1) {
    const { before } = only
    return client.from('transactions').update(only.after).eq('id', only.id).eq('posted_on', before.posted_on).eq('amount_minor', before.amount_minor).eq('description', before.description).select('id')
  }
  // Two legs need two values in one statement, which only an upsert sends; read them first, and send it only while both still read as loaded.
  const found = await client.from('transactions').select('id,posted_on,amount_minor,description').in('id', rows.map((r) => r.id))
  if (found.error) return found
  const current = (Array.isArray(found.data) ? found.data : []) as Loaded[]
  if (!rows.every((r) => current.some((row) => reads(row, r)))) return { data: [], error: null, status: found.status }
  const sent = rows.map((r) => ({ id: r.id, household_id: r.household_id, account_id: r.account_id, kind: r.kind, transfer_id: r.transfer_id, ...r.after }))
  return client.from('transactions').upsert(sent, { onConflict: 'id' }).select('id')
}

// Every column of a statement but its keys: what an edit sets, and what it must still find.
const STATEMENT_VALUES = [
  'cut_date',
  'due_date',
  'previous_balance_minor',
  'payments_and_credits_minor',
  'charges_minor',
  'installments_minor',
  'interest_minor',
  'fees_minor',
  'total_due_minor',
  'minimum_due_minor',
  'available_credit_minor',
] as const satisfies readonly (keyof Statement)[]

function editStatement(client: EditClient, before: SavedStatement, after: SavedStatement): PromiseLike<Reply> {
  let query = client
    .from('statements')
    .update(Object.fromEntries(STATEMENT_VALUES.map((c) => [c, after[c]])))
    .eq('id', before.id)
  for (const c of STATEMENT_VALUES) {
    const value = before[c]
    query = value === null ? query.is(c, null) : query.eq(c, value)
  }
  return query.select('id')
}

// An update that matches only while every listed column reads as loaded; a JSON column matches by value, as Postgres compares jsonb.
function guarded(client: EditClient, table: string, id: string, columns: readonly string[], before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): PromiseLike<Reply> {
  let query = client.from(table).update(after).eq('id', id)
  for (const c of columns) {
    const value = before[c]
    query = value === null ? query.is(c, null) : query.eq(c, typeof value === 'object' ? JSON.stringify(value) : value)
  }
  return query.select('id')
}

function request(client: EditClient, edit: Edit): PromiseLike<Reply> {
  if (edit.kind === 'add_item') return client.from('plan_items').upsert(edit.row, { onConflict: 'id' }).select('id')
  if (edit.kind === 'edit_item') return guarded(client, 'plan_items', edit.id, ITEM_VALUES, edit.before, edit.after)
  if (edit.kind === 'split_item') return client.rpc('split_plan_item', { p_id: edit.id, p_from: edit.from, p_patch: edit.patch })
  if (edit.kind === 'delete_item') return client.from('plan_items').delete().eq('id', edit.id).select('id')
  if (edit.kind === 'edit_household') return guarded(client, 'households', edit.id, HOUSEHOLD_VALUES, edit.before, edit.after)
  if (edit.kind === 'add_account') {
    const row: Readonly<Record<string, unknown>> = edit.row
    return client.from('accounts').upsert(row, { onConflict: 'id' }).select('id')
  }
  if (edit.kind === 'edit_account') return guarded(client, 'accounts', edit.id, ACCOUNT_VALUES, edit.before, edit.after)
  if (edit.kind === 'add_category') return client.from('categories').upsert(edit.row, { onConflict: 'id' }).select('id')
  if (edit.kind === 'edit_category') return guarded(client, 'categories', edit.id, CATEGORY_VALUES, edit.before, edit.after)
  if (edit.kind === 'add_statement') return client.from('statements').upsert(edit.row, { onConflict: 'id' }).select('id')
  if (edit.kind === 'edit_statement') return editStatement(client, edit.before, edit.after)
  if (edit.kind === 'csv_mapping') return client.from('accounts').update({ csv_mapping: edit.mapping }).eq('id', edit.account_id).select('id')
  const rows = client.from('transactions')
  if (edit.kind === 'link') return rows.update({ plan_item_id: edit.plan_item_id, period: edit.period }).eq('id', edit.row_id).is('plan_item_id', null).select('id')
  if (edit.kind === 'unlink') return rows.update({ plan_item_id: null, period: null }).eq('id', edit.row_id).eq('plan_item_id', edit.plan_item_id).eq('period', edit.period).select('id')
  if (edit.kind === 'delete') return rows.delete().or(deleteFilter(edit.row_id, edit.transfer_id)).select('id')
  if (edit.kind === 'delete_batch') return rows.delete().eq('batch_id', edit.batch_id).select('id')
  if (edit.kind === 'rewrite') return rewrite(client, edit.rows)
  // Only while the list is still the one loaded, so two devices skipping at once never drop each other's period.
  return client.from('plan_items').update({ skip_periods: [...edit.after] }).eq('id', edit.plan_item_id).eq('skip_periods', arrayText(edit.before)).select('id')
}

const ITEM_EDITS: ReadonlySet<Edit['kind']> = new Set(['add_item', 'edit_item', 'split_item', 'delete_item'])

// A plan item refusal named by what refused it, with its own words as detail: a trigger at commit (check_plan_item, check_link) or split_plan_item's error name.
function itemRefusal(edit: Edit, error: RpcFailure): DataError | null {
  const technical = `${edit.kind}: ${error.message}${error.code ? ` (${error.code})` : ''}`
  if (edit.kind === 'delete_item' && error.code === '23503') return new DataError('rejected', 'Payments are linked to this item, so it cannot be deleted. End it instead.', { code: 'linked', technical })
  const named = /^(check_plan_item|check_link|bad_split|bad_patch|unknown_plan_item): (?:(?:plan item|transaction) \S+: )?(.+)$/s.exec(error.message)
  if (!named || (error.code !== '23514' && error.code !== 'P0001')) return null
  return new DataError('rejected', 'The server did not accept this change.', { code: named[1], detail: named[2], technical })
}

// Sends one mark and checks it changed what it meant to; a refusal comes back as a DataError in plain words.
export async function sendEdit(client: EditClient, edit: Edit): Promise<void> {
  const { data, error, status } = await request(client, edit)
  if (error?.code === '23505' && error.message.includes('statements_account_id_cut_date_key')) {
    throw new DataError('rejected', 'A statement for this date exists.', { code: 'statement_exists', technical: `${edit.kind}: ${error.message}` })
  }
  // Names are unique ignoring case (categories_household_id_name_key).
  if (error?.code === '23505' && error.message.includes('categories_household_id_name_key')) {
    throw new DataError('rejected', 'A category with this name exists.', { code: 'category_exists', technical: `${edit.kind}: ${error.message}` })
  }
  const refused = error && ITEM_EDITS.has(edit.kind) ? itemRefusal(edit, error) : null
  if (refused) throw refused
  if (error) throw rpcError(edit.kind, error, status)
  // A table request answers with the rows it changed; split_plan_item with the new row's id.
  const changed = Array.isArray(data) ? data.length : typeof data === 'string' && data !== '' ? 1 : 0
  if (changed === 0) throw new DataError('rejected', STALE, { code: 'stale', technical: `${edit.kind}: no row matched` })
}
