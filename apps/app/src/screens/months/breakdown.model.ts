import {
  budgetRows,
  expandPlan,
  firstOfMonth,
  lastDayOfMonth,
  ledgerMonth,
  monthKey,
  snapshotIndex,
  textPart,
  type Copy,
  type LineItem,
  type Snapshot,
  type Transaction,
  type TransactionKind,
  type Walk,
} from '@waypoint/core'
import { cashAccounts, monthKind, type MonthKind } from './months.model'

// Spec §7 Months > Breakdown: the month's money by kind per currency. From today on it lists the walk's own line items, so its totals are the engine's month figures less moves inside one currency; before today, the rows.

// This month's rows up to today come first, as Recorded so far.
export const LINE_KINDS = ['recorded', 'income', 'bills', 'budgets', 'transfers', 'payments', 'top_ups', 'entered'] as const
export const ROW_KINDS = ['income', 'refunds', 'expenses', 'transfers', 'drawdowns', 'adjustments'] as const
export type BreakdownKind = (typeof LINE_KINDS)[number] | (typeof ROW_KINDS)[number]

export const KIND_TITLES: Record<BreakdownKind, string> = {
  recorded: 'Recorded so far',
  income: 'Income',
  bills: 'Bills',
  budgets: 'Budgets',
  transfers: 'Transfers',
  payments: 'Card and loan payments',
  top_ups: 'Top-ups',
  entered: 'Entered for later days',
  refunds: 'Refunds',
  expenses: 'Spending',
  drawdowns: 'Drawdowns',
  adjustments: 'Adjustments',
}

const ROW_KIND: Record<TransactionKind, (typeof ROW_KINDS)[number]> = { income: 'income', refund: 'refunds', expense: 'expenses', transfer: 'transfers', drawdown: 'drawdowns', adjustment: 'adjustments' }

// The walk's flags and states as words (spec §6.8): screens never read them as codes.
export const FLAG_WORDS = { to_send: 'To send', overdue: 'Overdue', estimated: 'Estimated' } as const

export interface BudgetFigures {
  currency: string
  budget_minor: number
  spent_minor: number
}

export interface BreakdownLine {
  id: string
  date: string
  // A budget's spending runs from date to until, spread evenly; equal to date for every other line.
  until: string
  account_id: string
  title: Copy
  // A transfer's other account: where the money went, or where it came from.
  other_account_id: string | null
  // Signed as it moves the account, in the account's currency; a move is positive.
  amount_minor: number
  // A move between two shown accounts in this currency: listed once from the account it left, and in neither total.
  move: boolean
  words: readonly string[]
  // A budget line: the category's budget and spending this month, which its amount is what is left of.
  budget: BudgetFigures | null
}

export interface KindGroup {
  kind: BreakdownKind
  title: string
  // Positive figures, moves left out.
  in_minor: number
  out_minor: number
  lines: readonly BreakdownLine[]
}

export interface CurrencyBreakdown {
  currency: string
  in_minor: number
  out_minor: number
  groups: readonly KindGroup[]
}

export interface Breakdown {
  month: string
  kind: MonthKind
  // The days it covers: the whole month, this one included.
  from: string
  to: string
  currencies: readonly CurrencyBreakdown[]
}

function kindOfLine(l: LineItem): Exclude<(typeof LINE_KINDS)[number], 'recorded'> {
  if (l.source === 'top_up') return 'top_ups'
  if (l.source === 'card' || l.source === 'loan') return 'payments'
  if (l.source === 'row') return 'entered'
  if (l.kind === 'income') return 'income'
  if (l.kind === 'allowance') return 'budgets'
  if (l.kind === 'transfer') return 'transfers'
  return 'bills'
}

// A line with the kind and currency it is filed under, and the id of its other leg's line.
interface Filed<K extends BreakdownKind> {
  kind: K
  currency: string
  line: BreakdownLine
  pair: string | null
}

const sum = (lines: readonly BreakdownLine[], sign: 1 | -1) => lines.reduce((total, l) => total + (!l.move && Math.sign(l.amount_minor) === sign ? Math.abs(l.amount_minor) : 0), 0)

// A move inside one currency with both legs listed shows once, as its leaving leg; a leg whose other one falls in another month counts. Core refuses unequal legs in one currency.
function oneLine<K extends BreakdownKind>(filed: readonly Filed<K>[]): Filed<K>[] {
  const byId = new Map(filed.map((f) => [f.line.id, f]))
  const landed = new Set<string>()
  const out = filed.map((f) => {
    const other = f.pair === null ? undefined : byId.get(f.pair)
    if (!other || other.currency !== f.currency || f.line.amount_minor >= 0) return f
    landed.add(other.line.id)
    return { ...f, line: { ...f.line, other_account_id: other.line.account_id, amount_minor: other.line.amount_minor, move: true } }
  })
  return out.filter((f) => !landed.has(f.line.id))
}

// An entered transfer's other leg; the walk and the ledger both name its line `row:<id>`.
function otherLeg(snapshot: Snapshot, row: Transaction | undefined): Transaction | undefined {
  return row?.transfer_id ? snapshotIndex(snapshot).transfers.get(row.transfer_id)?.find((t) => t.id !== row.id) : undefined
}

// A row's description, else where its transfer went or came from, else its kind: the same title before and after today.
function rowTitle(row: Transaction, other: Transaction | undefined): Copy {
  if (row.description) return [textPart(row.description)]
  return other ? [textPart(row.amount_minor < 0 ? 'Transfer to ' : 'Transfer from '), { account: other.account_id }] : [textPart(KIND_TITLES[ROW_KIND[row.kind]])]
}

// Per currency in the accounts' order, then per kind in `order`.
function byCurrency<K extends BreakdownKind>(order: readonly K[], currencies: readonly string[], filed: readonly Filed<K>[]): CurrencyBreakdown[] {
  return currencies.flatMap((currency) => {
    const own = filed.filter((f) => f.currency === currency)
    const groups = order.flatMap((kind): KindGroup[] => {
      const lines = own.filter((f) => f.kind === kind).map((f) => f.line)
      return lines.length === 0 ? [] : [{ kind, title: KIND_TITLES[kind], in_minor: sum(lines, 1), out_minor: sum(lines, -1), lines }]
    })
    return groups.length === 0 ? [] : [{ currency, in_minor: groups.reduce((t, g) => t + g.in_minor, 0), out_minor: groups.reduce((t, g) => t + g.out_minor, 0), groups }]
  })
}

// The walk's cash lines in the month: the out leg of a transfer, top-up or payment names where it went, the in leg where it came from.
function walkLines(snapshot: Snapshot, walk: Walk, month: string, accounts: ReadonlyMap<string, string>): Filed<(typeof LINE_KINDS)[number]>[] {
  const plan = expandPlan(snapshot)
  const byId = new Map(walk.lines.map((l) => [l.id, l]))
  const budgets = new Map(plan.budgets.filter((b) => b.month === month).map((b) => [b.category_id, b]))
  const fast = new Set(budgetRows(snapshot).filter((b) => b.month === month && b.word === 'Spending fast').map((b) => b.category_id))
  const rows = new Map(snapshot.doc.transactions.map((t) => [t.id, t]))
  return walk.lines
    .filter((l) => accounts.has(l.account_id) && monthKey(l.date) === month && l.amount_minor !== 0)
    .map((l) => {
      const kind = kindOfLine(l)
      const pair = l.pair_id === null ? undefined : byId.get(l.pair_id)
      const occurrence = l.occurrence_ids.length === 1 ? plan.byId.get(l.occurrence_ids[0] ?? '') : undefined
      const row = kind === 'entered' && l.row_id !== null ? rows.get(l.row_id) : undefined
      const leg = otherLeg(snapshot, row)
      const words: string[] = l.flags.map((f) => FLAG_WORDS[f])
      if (l.state === 'late') words.push('Late')
      if (l.state === 'partly_settled') words.push('Partly settled')
      let title: Copy
      let budget: BudgetFigures | null = null
      if (kind === 'budgets') {
        const category = occurrence?.category_id ?? plan.byId.get(l.occurrence_ids[0] ?? '')?.category_id ?? null
        const b = category === null ? undefined : budgets.get(category)
        title = category === null ? [textPart('Budget')] : [{ category }]
        budget = b ? { currency: b.currency, budget_minor: b.budget_minor, spent_minor: b.spent_minor } : null
        if (category !== null && fast.has(category)) words.push('Spending fast')
      } else if (kind === 'top_ups' && pair) {
        title = l.amount_minor < 0 ? [textPart('Top-up to '), { account: pair.account_id }] : [textPart('Top-up from '), { account: pair.account_id }]
      } else if (kind === 'payments' && pair) {
        title = l.id.startsWith('payment:') ? [{ account: pair.account_id }, textPart(' payment')] : [textPart('Extra payment to '), { account: pair.account_id }]
      } else if (kind === 'entered') {
        title = row ? rowTitle(row, leg) : [textPart(KIND_TITLES.entered)]
      } else {
        title = occurrence ? [{ item: occurrence.plan_item_id }] : [textPart(KIND_TITLES[kind])]
      }
      const other = kind === 'transfers' && pair ? pair.account_id : (leg?.account_id ?? null)
      return { kind, currency: accounts.get(l.account_id) ?? '', pair: leg ? `row:${leg.id}` : l.pair_id, line: { id: l.id, date: l.date, until: l.until, account_id: l.account_id, title, other_account_id: other, amount_minor: l.amount_minor, move: false, words, budget } }
    })
}

// Each cash account's rows in the month up to `until`, titled by their description or kind.
function ledgerLines<K extends BreakdownKind>(snapshot: Snapshot, month: string, accounts: ReadonlyMap<string, string>, kindOf: (row: Transaction) => K, until: string): Filed<K>[] {
  const out: Filed<K>[] = []
  for (const [accountId, currency] of accounts) {
    for (const row of ledgerMonth(snapshot, accountId, month)) {
      if (row.posted_on > until) continue
      const other = otherLeg(snapshot, row)
      out.push({ kind: kindOf(row), currency, pair: other ? `row:${other.id}` : null, line: { id: `row:${row.id}`, date: row.posted_on, until: row.posted_on, account_id: accountId, title: rowTitle(row, other), other_account_id: other?.account_id ?? null, amount_minor: row.amount_minor, move: false, words: [], budget: null } })
    }
  }
  return out.sort((a, b) => (a.line.date < b.line.date ? -1 : a.line.date > b.line.date ? 1 : a.line.id < b.line.id ? -1 : 1))
}

// The cash accounts Months shows (cashAccounts), so the totals sit beside its summary; each currency's in and out are the rows' up to today and the walk's lines from today on, less moves inside one currency.
export function breakdownOf(snapshot: Snapshot, walk: Walk, month: string): Breakdown {
  const key = monthKey(month)
  const kind = monthKind(key, snapshot.as_of)
  const accounts = new Map(cashAccounts(snapshot).map((a) => [a.id, a.currency]))
  const order = [...new Set(accounts.values())]
  // Rows dated today are in the walk's opening balance, not its lines, so Recorded so far takes them.
  const recorded = kind === 'current' ? ledgerLines(snapshot, key, accounts, () => 'recorded' as const, snapshot.as_of) : []
  const currencies =
    kind === 'past'
      ? byCurrency(ROW_KINDS, order, oneLine(ledgerLines(snapshot, key, accounts, (row) => ROW_KIND[row.kind], lastDayOfMonth(key))))
      : byCurrency(LINE_KINDS, order, oneLine([...recorded, ...walkLines(snapshot, walk, key, accounts)]))
  return { month: key, kind, from: firstOfMonth(key), to: lastDayOfMonth(key), currencies }
}
