import { addDays, daysBetween, monthKey, parseAmount, snapshotIndex, type Account, type LedgerRow, type Snapshot, type Transaction } from '@waypoint/core'
import type { Edit, Rewrite } from '../../data/edits'
import { amountText, isDay } from '../../data/field-text'

// Spec §7 Money: one account's month, newest day first, with the balance after every row; edits that keep a transfer's two legs together.

const KIND_LABELS: Record<string, string> = {
  income: 'Income',
  expense: 'Expense',
  refund: 'Refund',
  transfer: 'Transfer',
  drawdown: 'Drawdown',
  adjustment: 'Adjustment',
}

// A kind this build does not know yet reads as its own value, so a newer database never blanks the ledger (invariant 190).
export function kindLabel(kind: string): string {
  const known = KIND_LABELS[kind]
  if (known) return known
  const words = kind.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other'
}

export interface Bounds {
  first: string
  last: string
}

// The months the ledger steps through: from the opening month to this month, or to the last row entered for a later month.
export function ledgerBounds(snapshot: Snapshot, account: Account): Bounds {
  const first = monthKey(account.opening_date)
  const rows = snapshotIndex(snapshot).rowsByAccount.get(account.id) ?? []
  const latest = rows.at(-1)
  let last = monthKey(snapshot.as_of)
  if (latest && monthKey(latest.posted_on) > last) last = monthKey(latest.posted_on)
  return { first, last: last < first ? first : last }
}

// ?month= when it is a month inside the bounds, else this month, held inside them.
export function ledgerMonthOf(param: string | string[] | undefined, bounds: Bounds, asOf: string): string {
  const value = Array.isArray(param) ? param[0] : param
  const month = value !== undefined && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : monthKey(asOf)
  return month < bounds.first ? bounds.first : month > bounds.last ? bounds.last : month
}

export interface LedgerLine {
  id: string
  posted_on: string
  // The description, or the kind in words when there is none.
  title: string
  // The kind, the category, the other leg's account and the plan item it settles, as there are.
  detail: string
  amount_minor: number
  // The balance after this row in ledger order (posted_on, then id).
  balance_minor: number
  // Entered for a day after today.
  later: boolean
}

// The month is one card: its first day heading opens it, its last row closes it; first and last mark each day's rows inside it.
export type LedgerItem = { type: 'day'; key: string; day: string; top: boolean } | { type: 'row'; key: string; line: LedgerLine; first: boolean; last: boolean; bottom: boolean }

// The other leg, found across every month and account, so a pair split by a month end still reads as one move (invariant 191).
export function partnerOf(snapshot: Snapshot, row: Transaction): Transaction | null {
  if (row.transfer_id === null) return null
  const pair = snapshotIndex(snapshot).transfers.get(row.transfer_id)
  return pair ? (pair[0].id === row.id ? pair[1] : pair[0]) : null
}

export function lineOf(snapshot: Snapshot, row: LedgerRow): LedgerLine {
  const index = snapshotIndex(snapshot)
  const partner = partnerOf(snapshot, row)
  const other = partner ? index.accounts.get(partner.account_id)?.name : undefined
  const kind = other ? `${kindLabel(row.kind)} ${row.amount_minor < 0 ? 'to' : 'from'} ${other}` : kindLabel(row.kind)
  const title = row.description.trim() || kind
  const category = row.category_id === null ? undefined : snapshot.doc.categories.find((c) => c.id === row.category_id)?.name
  // A transfer links by its outgoing leg, so the incoming leg names the same item.
  const itemId = row.plan_item_id ?? partner?.plan_item_id ?? null
  const item = itemId === null ? undefined : index.planItems.get(itemId)?.name
  const detail = [title === kind ? null : kind, category ?? null, item ? `Linked to ${item}` : null].filter((p): p is string => p !== null).join(' · ')
  return { id: row.id, posted_on: row.posted_on, title, detail, amount_minor: row.amount_minor, balance_minor: row.running_balance_minor, later: row.posted_on > snapshot.as_of }
}

// Newest day first, each day's rows newest first under a day heading inside the month's one card.
export function ledgerItems(snapshot: Snapshot, rows: readonly LedgerRow[]): LedgerItem[] {
  const items: LedgerItem[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as LedgerRow
    const previous = rows[i + 1]
    const next = rows[i - 1]
    const first = previous?.posted_on !== row.posted_on
    if (first) items.push({ type: 'day', key: `day:${row.posted_on}`, day: row.posted_on, top: items.length === 0 })
    items.push({ type: 'row', key: row.id, line: lineOf(snapshot, row), first, last: next?.posted_on !== row.posted_on, bottom: i === 0 })
  }
  return items
}

// A day heading: Today, Yesterday or Tomorrow, else the weekday and date, with the year when it is not this year's.
export function ledgerDayTitle(day: string, asOf: string, locale: string): string {
  const gap = daysBetween(asOf, day)
  if (gap === 0) return 'Today'
  if (gap === -1) return 'Yesterday'
  if (gap === 1) return 'Tomorrow'
  const year = day.slice(0, 4) === asOf.slice(0, 4) ? undefined : 'numeric'
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}

// The month of the last row a save wrote on this account, when it wrote one (invariant 191).
export function savedMonth(rows: readonly { account_id: string; posted_on: string }[], accountId: string): string | null {
  const mine = rows.filter((r) => r.account_id === accountId)
  const latest = mine.at(-1)
  return latest ? monthKey(latest.posted_on) : null
}

export interface EditTarget {
  row: Transaction
  account: Account
  // The other leg of a transfer, and its account.
  partner: Transaction | null
  partner_account: Account | null
  // A transfer between two currencies: each leg keeps its own amount.
  across: boolean
  // The plan item the row settles; a transfer links by its outgoing leg.
  linked_item: string | null
}

export function editTarget(snapshot: Snapshot, rowId: string): EditTarget | null {
  const index = snapshotIndex(snapshot)
  const row = snapshot.doc.transactions.find((t) => t.id === rowId)
  const account = row ? index.accounts.get(row.account_id) : undefined
  if (!row || !account) return null
  const partner = partnerOf(snapshot, row)
  const partnerAccount = partner ? (index.accounts.get(partner.account_id) ?? null) : null
  const itemId = row.plan_item_id ?? partner?.plan_item_id ?? null
  const linked = itemId === null ? null : (index.planItems.get(itemId)?.name ?? null)
  return { row, account, partner, partner_account: partnerAccount, across: partnerAccount !== null && partnerAccount.currency !== account.currency, linked_item: linked }
}

export interface EditDraft {
  day: string
  // The amount, or across currencies what left the outgoing leg.
  amount: string
  // Across currencies only: what landed on the incoming leg.
  received: string
  note: string
}

// The outgoing leg of a transfer first, so Amount always reads as what was sent.
function legs(t: EditTarget): { out: Transaction; into: Transaction | null; outAccount: Account; intoAccount: Account | null } {
  if (t.partner && t.partner_account && t.row.amount_minor > 0) return { out: t.partner, into: t.row, outAccount: t.partner_account, intoAccount: t.account }
  return { out: t.row, into: t.partner, outAccount: t.account, intoAccount: t.partner_account }
}

export function editDraft(t: EditTarget, locale: string): EditDraft {
  const { out, into, outAccount, intoAccount } = legs(t)
  const amount = amountText(Math.abs(out.amount_minor), outAccount.currency, locale)
  return { day: t.row.posted_on, amount, received: t.across && into && intoAccount ? amountText(into.amount_minor, intoAccount.currency, locale) : '', note: t.row.description }
}

export type EditField = 'day' | 'amount' | 'received'

export type EditRead =
  // edit is null when nothing changed. month is where the edited row now sits; partner_day is where the other leg moves to.
  | { ok: true; edit: Edit | null; month: string; partner_day: string | null }
  | { ok: false; errors: Partial<Record<EditField, string>> }

export interface ReadOptions {
  locale: string
  // The signed-in user, whose id is the household's (row-level security).
  household_id: string
  // How an error names a day, in the household's locale.
  day: (iso: string) => string
}

// One write of the row, or of both legs together: a date edit moves both by the same number of days, so the 0 to 5 day gap between them stays; a same-currency amount edit sets both legs.
export function readEdit(t: EditTarget, draft: EditDraft, options: ReadOptions): EditRead {
  const errors: Partial<Record<EditField, string>> = {}
  const { out, into, outAccount, intoAccount } = legs(t)
  const day = draft.day.trim()
  let shift = 0
  if (!isDay(day)) errors.day = 'Pick the day.'
  else {
    shift = daysBetween(t.row.posted_on, day)
    for (const [leg, account] of [
      [t.row, t.account],
      [t.partner, t.partner_account],
    ] as const) {
      if (!leg || !account) continue
      const moved = addDays(leg.posted_on, shift)
      if (moved < account.opening_date && !errors.day) errors.day = `${account.name} opened on ${options.day(account.opening_date)}, so ${leg === t.row ? 'this' : 'its leg'} cannot be earlier.`
    }
  }
  const sent = parseAmount(draft.amount, options.locale, outAccount.currency)
  if (sent === null || sent <= 0) errors.amount = 'Enter an amount above 0.'
  const received = t.across && intoAccount ? parseAmount(draft.received, options.locale, intoAccount.currency) : sent
  if (t.across && (received === null || received <= 0)) errors.received = 'Enter the amount that arrived, above 0.'
  if (Object.keys(errors).length > 0 || sent === null || received === null) return { ok: false, errors }

  // A new note goes on both legs; an untouched one leaves each leg its own.
  const noted = draft.note !== t.row.description
  const rewrite = (leg: Transaction, amount: number): Rewrite => ({
    id: leg.id,
    household_id: options.household_id,
    account_id: leg.account_id,
    kind: leg.kind,
    transfer_id: leg.transfer_id,
    before: { posted_on: leg.posted_on, amount_minor: leg.amount_minor, description: leg.description },
    after: { posted_on: addDays(leg.posted_on, shift), amount_minor: amount, description: noted ? draft.note.trim() : leg.description },
  })
  // A row keeps its sign: an expense stays money out and an adjustment keeps its direction.
  const sign = out.amount_minor < 0 ? -1 : 1
  const rows = [rewrite(out, sign * sent), ...(into ? [rewrite(into, received)] : [])]
  const changed = rows.some(({ before, after }) => before.posted_on !== after.posted_on || before.amount_minor !== after.amount_minor || before.description !== after.description)
  const month = monthKey(addDays(t.row.posted_on, shift))
  const partnerDay = t.partner ? addDays(t.partner.posted_on, shift) : null
  return { ok: true, edit: changed ? { kind: 'rewrite', rows } : null, month, partner_day: partnerDay }
}

// Delete takes the row and, for a transfer, its other leg in the same request.
export function deleteEdit(t: EditTarget): Edit {
  return { kind: 'delete', row_id: t.row.id, transfer_id: t.row.transfer_id }
}
