import { z } from 'zod'
import { addDays, dayFromNumber, dayNumber, daysBetween, monthKey } from './dates'
import type { Rate } from './rates'
import { currencyCode, isoDay, listIssues, strictKeys } from './schema/common'
import { importDoc } from './schema/import-doc'
import { validateLink, validatePlanItem, type AccountRef } from './schema/routing'
import type { Account, PlanItem, Statement, Transaction } from './schema/rows'

export const rateRow = strictKeys({
  quote: currencyCode,
  rate: z.number().positive('must be above 0'),
  day: isoDay,
}).refine((r) => r.quote !== 'EUR' || r.rate === 1, { message: 'EUR per EUR must be 1', path: ['rate'] })

// Every row from one export_household() call (or a sample), the day's rates and today in the household time zone.
export const snapshotSchema = strictKeys({
  version: z.literal(1, 'must be 1'),
  as_of: isoDay,
  rates: z.array(rateRow).superRefine((rates, ctx) => {
    const seen = new Set<string>()
    rates.forEach((r, i) => {
      if (seen.has(r.quote)) ctx.addIssue({ code: 'custom', message: `duplicate rate for '${r.quote}'`, path: [i, 'quote'] })
      seen.add(r.quote)
    })
  }),
  doc: importDoc,
})

export type Snapshot = z.output<typeof snapshotSchema>

export interface LedgerRow extends Transaction {
  running_balance_minor: number
}

export interface SnapshotIndex {
  accounts: ReadonlyMap<string, Account>
  planItems: ReadonlyMap<string, PlanItem>
  // Each account's rows in ledger order: posted_on, then id.
  rowsByAccount: ReadonlyMap<string, readonly Transaction[]>
  // Rows linked to one occurrence, keyed by occurrenceId, in ledger order.
  linksByOccurrence: ReadonlyMap<string, readonly Transaction[]>
  // Each card's statements by cut_date.
  statementsByAccount: ReadonlyMap<string, readonly Statement[]>
  // The two legs of each transfer, outgoing first.
  transfers: ReadonlyMap<string, readonly [Transaction, Transaction]>
}

export class SnapshotError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`The household data is not valid: ${issues.join('; ')}`)
    this.name = 'SnapshotError'
    this.issues = issues
  }
}

export function occurrenceId(planItemId: string, period: string): string {
  return `${planItemId}:${period}`
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byId = (a: { id: string }, b: { id: string }) => byText(a.id, b.id)
const byLedger = (a: Transaction, b: Transaction) => byText(a.posted_on, b.posted_on) || byId(a, b)

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    if (k === null) continue
    const group = groups.get(k)
    if (group) group.push(row)
    else groups.set(k, [row])
  }
  return groups
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

// The database enforces these through foreign keys, unique indexes and its three triggers, so every export passes them.
function crossTableIssues(doc: Snapshot['doc'], legs: ReadonlyMap<string, Transaction[]>): string[] {
  const issues: string[] = []
  const issue = (table: string, id: string, message: string) => issues.push(`${table}['${id}']: ${message}`)
  const accounts = new Map(doc.accounts.map((a) => [a.id, a]))
  const refs: AccountRef[] = doc.accounts.map((a) => ({ id: a.id, kind: a.kind }))
  const categories = new Set(doc.categories.map((c) => c.id))
  const items = new Map(doc.plan_items.map((p) => [p.id, p]))

  const names = new Map<string, string>()
  for (const c of doc.categories) {
    const taken = names.get(c.name.toLowerCase())
    if (taken !== undefined) issue('categories', c.id, `name: '${c.name}' is already used by category '${taken}'`)
    else names.set(c.name.toLowerCase(), c.id)
  }

  for (const a of doc.accounts) {
    if (a.funded_from_account_id !== null && !accounts.has(a.funded_from_account_id)) issue('accounts', a.id, `funded_from_account_id: no account '${a.funded_from_account_id}'`)
  }

  for (const p of doc.plan_items) {
    for (const message of validatePlanItem(p, refs)) issue('plan_items', p.id, message)
    if (p.category_id !== null && !categories.has(p.category_id)) issue('plan_items', p.id, `category_id: no category '${p.category_id}'`)
  }

  const cuts = new Set<string>()
  for (const s of doc.statements) {
    if (!accounts.has(s.account_id)) issue('statements', s.id, `account_id: no account '${s.account_id}'`)
    const cut = `${s.account_id} ${s.cut_date}`
    if (cuts.has(cut)) issue('statements', s.id, `cut_date: account '${s.account_id}' already has a statement cut on ${s.cut_date}`)
    cuts.add(cut)
  }

  const externalIds = new Set<string>()
  for (const t of doc.transactions) {
    if (!accounts.has(t.account_id)) issue('transactions', t.id, `account_id: no account '${t.account_id}'`)
    if (t.category_id !== null && !categories.has(t.category_id)) issue('transactions', t.id, `category_id: no category '${t.category_id}'`)
    if (t.external_id !== null) {
      const key = JSON.stringify([t.account_id, t.external_id])
      if (externalIds.has(key)) issue('transactions', t.id, `external_id: '${t.external_id}' is already recorded on account '${t.account_id}'`)
      externalIds.add(key)
    }
    if (t.plan_item_id === null) continue
    const item = items.get(t.plan_item_id)
    if (!item) {
      issue('transactions', t.id, `plan_item_id: no plan item '${t.plan_item_id}'`)
      continue
    }
    const partner = t.transfer_id === null ? null : (legs.get(t.transfer_id)?.find((leg) => leg.id !== t.id) ?? null)
    for (const message of validateLink(t, partner, item, refs)) issue('transactions', t.id, message)
  }

  for (const [transferId, pair] of legs) {
    const [first, second] = pair
    if (pair.length !== 2 || !first || !second) {
      for (const leg of pair) issue('transactions', leg.id, `transfer_id: '${transferId}' has ${pair.length} leg${pair.length === 1 ? '' : 's'}; a transfer has exactly 2`)
      continue
    }
    const [out, into] = first.amount_minor < 0 ? [first, second] : [second, first]
    if (out.account_id === into.account_id) issue('transactions', into.id, `account_id: both legs of transfer '${transferId}' are on account '${out.account_id}'`)
    if (out.amount_minor >= 0 || into.amount_minor <= 0) issue('transactions', into.id, `amount_minor: the legs of transfer '${transferId}' need opposite signs`)
    else if (into.posted_on < out.posted_on || into.posted_on > addDays(out.posted_on, 5)) {
      issue('transactions', into.id, `posted_on: the incoming leg of transfer '${transferId}' must post 0 to 5 days after the outgoing leg (${out.posted_on})`)
    }
    const [from, to] = [accounts.get(out.account_id), accounts.get(into.account_id)]
    if (from && to && from.currency === to.currency && -out.amount_minor !== into.amount_minor) {
      issue('transactions', into.id, `amount_minor: transfer '${transferId}' moves ${-out.amount_minor} out and ${into.amount_minor} in within ${from.currency}; a fee is its own row`)
    }
  }
  return issues
}

const indexes = new WeakMap<Snapshot, SnapshotIndex>()

// Pure: checks the export, sorts every table by id and indexes rows; sums are derived from rows, so no field repeats another.
export function buildSnapshot(doc: unknown, asOf: string, rates: readonly Rate[]): Snapshot {
  const parsed = snapshotSchema.safeParse({ version: 1, as_of: asOf, rates, doc })
  if (!parsed.success) throw new SnapshotError(listIssues(parsed.error))
  const snapshot = parsed.data
  const { doc: d } = snapshot
  snapshot.rates.sort((a, b) => byText(a.quote, b.quote))
  for (const table of [d.accounts, d.categories, d.plan_items, d.statements, d.transactions]) table.sort(byId)

  const ledger = [...d.transactions].sort(byLedger)
  const legs = groupBy(ledger, (t) => t.transfer_id)
  const issues = crossTableIssues(d, legs)
  if (issues.length > 0) throw new SnapshotError(issues)

  const transfers = new Map<string, readonly [Transaction, Transaction]>()
  for (const [id, [a, b]] of legs) if (a && b) transfers.set(id, a.amount_minor < 0 ? [a, b] : [b, a])
  indexes.set(freeze(snapshot), {
    accounts: new Map(d.accounts.map((a) => [a.id, a])),
    planItems: new Map(d.plan_items.map((p) => [p.id, p])),
    rowsByAccount: groupBy(ledger, (t) => t.account_id),
    linksByOccurrence: groupBy(ledger, (t) => (t.plan_item_id === null || t.period === null ? null : occurrenceId(t.plan_item_id, t.period))),
    statementsByAccount: groupBy([...d.statements].sort((a, b) => byText(a.cut_date, b.cut_date) || byId(a, b)), (s) => s.account_id),
    transfers,
  })
  return snapshot
}

export function snapshotIndex(snapshot: Snapshot): SnapshotIndex {
  const index = indexes.get(snapshot)
  if (!index) throw new Error('This snapshot was not made by buildSnapshot; build it from the export and rates')
  return index
}

function ledgerOf(snapshot: Snapshot, accountId: string): { account: Account; rows: readonly Transaction[] } {
  const index = snapshotIndex(snapshot)
  const account = index.accounts.get(accountId)
  if (!account) throw new RangeError(`No account '${accountId}' in the snapshot`)
  return { account, rows: index.rowsByAccount.get(accountId) ?? [] }
}

// Opening balance plus every row posted on or before the day.
export function ledgerSum(snapshot: Snapshot, accountId: string, onOrBefore: string): number {
  const day = addDays(onOrBefore, 0) // throws RangeError on a malformed day
  const { account, rows } = ledgerOf(snapshot, accountId)
  let sum = account.opening_balance_minor
  for (const row of rows) {
    if (row.posted_on > day) break
    sum += row.amount_minor
  }
  return sum
}

// The month's rows in ledger order, each with the balance after it: opening plus every earlier row plus this one.
export function ledgerMonth(snapshot: Snapshot, accountId: string, month: string): LedgerRow[] {
  const key = monthKey(month)
  const { account, rows } = ledgerOf(snapshot, accountId)
  let balance = account.opening_balance_minor
  const out: LedgerRow[] = []
  for (const row of rows) {
    const rowMonth = row.posted_on.slice(0, 7)
    if (rowMonth > key) break
    balance += row.amount_minor
    if (rowMonth === key) out.push({ ...row, running_balance_minor: balance })
  }
  return out
}

export interface LedgerTotals {
  opening_minor: number
  closing_minor: number
  in_minor: number
  // Positive.
  out_minor: number
}

// A month from its rows alone, as every month before this one reads (spec §6.3): opening is the balance before its first day, closing after its last.
export function ledgerTotals(snapshot: Snapshot, accountId: string, month: string): LedgerTotals {
  const key = monthKey(month)
  const { account, rows } = ledgerOf(snapshot, accountId)
  const t = { opening_minor: account.opening_balance_minor, closing_minor: 0, in_minor: 0, out_minor: 0 }
  for (const row of rows) {
    const rowMonth = row.posted_on.slice(0, 7)
    if (rowMonth > key) break
    if (rowMonth < key) t.opening_minor += row.amount_minor
    else if (row.amount_minor > 0) t.in_minor += row.amount_minor
    else t.out_minor -= row.amount_minor
  }
  t.closing_minor = t.opening_minor + t.in_minor - t.out_minor
  return t
}

// Each day's closing balance from rows alone, `from` to `to`: index 0 is `from`.
export function ledgerDays(snapshot: Snapshot, accountId: string, from: string, to: string): Float64Array {
  const span = daysBetween(from, to) + 1 // throws RangeError on a malformed day
  if (span < 1) throw new RangeError(`${to} is before ${from}`)
  const { account, rows } = ledgerOf(snapshot, accountId)
  const out = new Float64Array(span)
  let balance = account.opening_balance_minor
  let r = 0
  for (let i = 0; i < span; i++) {
    const day = dayFromNumber(dayNumber(from) + i)
    for (let row = rows[r]; row && row.posted_on <= day; row = rows[++r]) balance += row.amount_minor
    out[i] = balance
  }
  return out
}
