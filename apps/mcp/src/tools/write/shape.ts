import { lastDayOfMonth, ledgerSum, minorDigits, monthKey, snapshotIndex, itemSchedule, type PlanItem, type Snapshot, type Transaction } from '@waypoint/core'
import { decimalMinor } from '@waypoint/core/agent'
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { Db } from '../../auth'
import type { DbError, Reply, Request, World } from '../../data'
import { AgentError, Refusal } from '../../errors'
import { amount, bySortOrder, type Amount } from '../read/shape'

export const WRITES = 'Every write answers with its status, its batch_id (null when it has none), every account’s balance after it (opening plus rows to today), and changes: each cash account’s lowest balance, days under floor and the FX margin, before and after, from the engine on the household before and after the write; changes.moved is true when one of those three moved, and says nothing of net worth (compare shows that). A refusal is JSON {error, message, …} and saves nothing.'

export interface WriteIO {
  // The household as this call found it, from its own export.
  before: World
  send(request: Request): Promise<Reply>
  // The household after the write, from a second export, loaded once.
  after(): Promise<World>
}

export interface Written {
  status: string
  batch_id: string | null
  link: string | null
  [field: string]: unknown
}

export interface WriteTool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  input: S
  // It removes rows, so a client may ask before it runs.
  destructive: boolean
  // The same call again changes nothing more.
  idempotent: boolean
  run(io: WriteIO, args: z.output<S>): Promise<Written>
}

// The household after the write, or null when reading it again failed; the write itself stands either way.
export async function afterWrite(io: WriteIO): Promise<World | null> {
  try {
    return await io.after()
  } catch {
    return null
  }
}

// Decimal text read once in the account's currency (rule 15).
export function minorOf(text: string, currency: string, field: string): number {
  const minor = decimalMinor(text, currency)
  if (minor !== null) return minor
  const digits = minorDigits(currency)
  throw new Refusal('bad_input', `${field}: '${text}' is not an amount in ${currency}, which takes ${digits === 0 ? 'no decimals' : `at most ${digits} decimal${digits === 1 ? '' : 's'}`}. Nothing was saved.`, { field })
}

// A row id made from the batch id and the row's place, so the same call makes the same ids and post_batch answers already_applied.
export function rowId(batchId: string, index: number): string {
  const hex = createHash('sha256').update(`waypoint-agent-row ${batchId.toLowerCase()} ${index}`).digest('hex')
  const variant = ((parseInt(hex.charAt(16), 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// The signed-in user, whose id is the household's (spec §4).
export async function ownerOf(db: Db): Promise<string> {
  const { data } = await db.auth.getSession()
  const id = data.session?.user.id
  if (!id) throw new AgentError('The agent has no session for this write; call again to sign in.')
  return id
}

export function itemOf(snapshot: Snapshot, id: string): PlanItem {
  const found = snapshotIndex(snapshot).planItems.get(id)
  if (!found) throw new Refusal('not_found', `No plan item '${id}' in this household. list_plan lists every item with its id.`, { id })
  return found
}

export function transactionOf(snapshot: Snapshot, id: string): Transaction {
  const found = snapshot.doc.transactions.find((t) => t.id === id)
  if (!found) throw new Refusal('not_found', `No transaction '${id}' in this household. get_ledger lists each account’s rows with their ids.`, { id })
  return found
}

export function categoryOf(snapshot: Snapshot, id: string): void {
  if (!snapshot.doc.categories.some((c) => c.id === id)) throw new Refusal('not_found', `No category '${id}' in this household. list_plan lists the categories with their ids.`, { id })
}

// An occurrence's period: the first of its month, or its own day for a weekly or two-weekly item; installments bill at a cut and take no links.
export function periodProblem(item: PlanItem, period: string): string | null {
  const month = `${monthKey(period)}-01`
  const periods = itemSchedule(item, null, month, lastDayOfMonth(month)).map(([p]) => p)
  if (periods.includes(period)) return null
  if (periods.length === 0) return `plan item ${item.id} has no occurrence in ${monthKey(period)}`
  return `${period} is not a period of plan item ${item.id}; its period${periods.length > 1 ? 's' : ''} in ${monthKey(period)} ${periods.length > 1 ? 'are' : 'is'} ${periods.join(', ')}`
}

// Each account's balance as the bank shows it after the write: opening plus every row dated today or earlier.
export function balancesOf(world: World) {
  const { snapshot } = world
  return [...snapshot.doc.accounts].sort(bySortOrder).map((a) => ({
    account_id: a.id,
    kind: a.kind,
    archived: a.archived_at !== null,
    balance: amount(ledgerSum(snapshot, a.id, snapshot.as_of), a.currency),
    data_text: { name: a.name },
  }))
}

const shown = (a: Amount) => `${a.amount} ${a.currency}`

type Detail = Record<string, unknown>

function parsed(details: string | null | undefined): Detail {
  try {
    const value: unknown = JSON.parse(details ?? '')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Detail) : {}
  } catch {
    return {}
  }
}

const UNIQUE: Record<string, [string, string]> = {
  statements_account_id_cut_date_key: ['statement_exists', 'the card already has a statement cut on that day; Waypoint keeps one per cut'],
  transactions_account_id_external_id_key: ['already_recorded', 'that external id is already recorded on its account'],
  categories_household_id_name_key: ['category_exists', 'a category with that name exists'],
}

// The database's refusal in plain words, with post_batch's DETAIL as figures; ids only, never typed text, so the words stay instructions-free.
export function refusal(error: DbError, world: World, nothing = 'Nothing was saved'): AgentError {
  const accounts = snapshotIndex(world.snapshot).accounts
  const money = (minor: unknown, accountId: unknown): Amount | null => {
    const currency = accounts.get(String(accountId))?.currency
    return typeof minor === 'number' && currency ? amount(minor, currency) : null
  }
  const named = /^([a-z_]+): (.*)$/s.exec(error.message)
  const name = named?.[1] ?? ''
  const words = named?.[2] ?? error.message
  const detail = parsed(error.details)
  if (error.code === 'P0001') {
    switch (name) {
      case 'balance_mismatch': {
        const rows = Array.isArray(detail.accounts) ? (detail.accounts as { account_id: string; expected_minor: number; actual_minor: number | null }[]) : []
        const list = rows.map((r) => ({ account_id: r.account_id, expected: money(r.expected_minor, r.account_id), actual: money(r.actual_minor, r.account_id) }))
        const said = list.map((r) => `account ${r.account_id} is ${r.actual ? shown(r.actual) : 'unknown'}, not the expected ${r.expected ? shown(r.expected) : 'figure'}`).join('; ')
        return new Refusal(name, `${nothing}: ${String(detail.when)} the batch, ${said}. A balance is the opening balance plus every row dated today or earlier, as the bank shows it.`, { when: detail.when, accounts: list })
      }
      case 'already_recorded':
        return new Refusal(name, `${nothing}: ${words}. Those bank transactions are in the ledger already (get_ledger shows each row’s external_id); leave them out.`, { external_ids: detail.external_ids, ids: detail.ids })
      case 'over_remainder': {
        const paid = money(detail.amount_minor, detail.account_id)
        const remaining = money(detail.remaining_minor, detail.account_id)
        const cut = typeof detail.cut_date === 'string' ? `the statement cut ${detail.cut_date}` : 'the opening balance'
        return new Refusal(
          name,
          `${nothing}: row ${String(detail.id)} pays ${paid ? shown(paid) : 'more'} into card ${String(detail.account_id)}, above the ${remaining ? shown(remaining) : ''} remaining due on ${cut}. get_debt gives left_to_pay; enter a newer statement with add_statement first, or set allow_over to pay more.`,
          { id: detail.id, account_id: detail.account_id, amount: paid, remaining, cut_date: detail.cut_date ?? null },
        )
      }
      case 'id_conflict':
        return new Refusal(name, `${nothing}: ${words}. A new batch needs a new batch_id (and new row ids when you give them); to retry a call, resend it unchanged.`, { ids: detail.ids })
      case 'partial_replay':
        return new Refusal(name, `${nothing}: ${words}.`, { ids: detail.ids })
      case 'unknown_account':
        return new Refusal(name, `${nothing}: ${words}. get_overview lists every account with its id.`, { account_ids: detail.account_ids })
      case 'bad_input':
        return new Refusal(name, `${nothing}: ${words}`, { issues: detail.issues })
      default:
        if (name) return new Refusal(name, `${nothing}: ${words}`)
    }
  }
  if (error.code === '23514') {
    const check = /^(check_link|check_plan_item|transfer_pair): (.*)$/s.exec(error.message)
    return new Refusal(check?.[1] ?? 'check_violation', `${nothing}: ${check?.[2] ?? error.message}`)
  }
  if (error.code === '23505') {
    const unique = Object.entries(UNIQUE).find(([key]) => error.message.includes(key))?.[1]
    if (unique) return new Refusal(unique[0], `${nothing}: ${unique[1]}.`)
    return new Refusal('id_conflict', `${nothing}: a row with that id exists already. Give a new id, or leave it out.`)
  }
  if (error.code === '23503') return new Refusal('linked_or_missing', `${nothing}: ${error.message}. A row names an id this household does not have, or rows still point at what this would remove.`)
  return new Refusal('database', `${nothing}: the database refused the write: ${error.message}${error.code ? ` (${error.code})` : ''}`)
}

// The request's rows, or the refusal; an empty answer means someone changed the row since this call read it.
export async function changed(io: WriteIO, request: Request, nothing = 'Nothing was saved'): Promise<unknown[]> {
  const reply = await io.send(request)
  if (reply.error) throw refusal(reply.error, io.before, nothing)
  const rows = Array.isArray(reply.data) ? reply.data : []
  if (rows.length === 0) throw new Refusal('stale', `${nothing}: the row changed since this call read the household. Read it again and retry.`)
  return rows
}
