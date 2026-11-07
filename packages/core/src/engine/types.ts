import type { PlanItemKind, Transaction } from '../schema/rows'

// The horizon ends with the 60th month after this one (spec §6.1).
export const HORIZON_MONTHS = 60
// Occurrences reach back at most this many months before this one, which bounds how far an unpaid outflow or late income carries (spec §6.3).
export const LOOKBACK_MONTHS = 12
// Suggestion window and amount tolerance (spec §6.6, defaults to tune).
export const SUGGEST_DAYS = 7
export const SUGGEST_PCT = 5

// What an occurrence moves, from its plan item kind and the kinds of its accounts.
export type Flow =
  | 'income' // income into a cash account
  | 'draw' // income onto a debt: a planned draw, a credit with no cash event
  | 'bill' // a bill leaving a cash account
  | 'card_bill' // a bill on a card: a card charge
  | 'allowance' // a category budget spent evenly over its month, on cash or a card
  | 'transfer' // cash to cash
  | 'debt_transfer' // into a debt: only sizes that debt's payment
  | 'extra' // extra for debts: only sizes payments
  | 'installment' // billed at the card's cut in its month

export type OccurrenceState = 'settled' | 'partly_settled' | 'on_statement' | 'due' | 'overdue' | 'late' | 'unconfirmed' | 'lapsed'

export interface Occurrence {
  id: string
  plan_item_id: string
  kind: PlanItemKind
  flow: Flow
  // An allowance's category; null for every other kind.
  category_id: string | null
  // First of the month for month, quarter, year and once; the date for week and 2weeks.
  period: string
  // The date before roll, clamped to the month end; an installment's is its month's cut.
  scheduled_on: string
  // The date after roll, where it lands.
  date: string
  // The account it moves: the paying account, the receiving one for income and draws, the debt for a debt transfer.
  account_id: string
  // A cash-to-cash transfer's receiving account; null otherwise.
  to_account_id: string | null
  amount_minor: number
  // The rows linked to this occurrence, in ledger order, and the sum of their sizes.
  links: readonly Transaction[]
  linked_minor: number
  skipped: boolean
  // null for a debt transfer, extra for debts and a negative allowance, which show only inside their debt or category.
  state: OccurrenceState | null
  // What is still expected: amount − links while open, else 0.
  open_minor: number
  // Late income counts on this day, the first of the month after as_of's; null in every other state.
  carried_to: string | null
}

export interface Suggestion {
  id: string
  row_id: string
  occurrence_id: string
  account_id: string
  days_apart: number
  // |row| − open amount; negative when the row is smaller.
  amount_gap_minor: number
}

// A category's allowances in one month, netted once against tagged spend on any account.
export interface CategoryBudget {
  category_id: string
  month: string
  // The currency the netting runs in: the allowance accounts' own, or the base currency when they differ.
  currency: string
  budget_minor: number
  spent_minor: number
  left_minor: number
  // left_minor split across the allowance accounts by amount, each in its account's currency.
  shares: readonly { account_id: string; amount_minor: number }[]
  occurrence_ids: readonly string[]
  // Currencies with no rate: their lines keep their full amount and their spend nets nothing, which keeps cash low.
  missing_rates: readonly string[]
}

// Day order (spec §6.2): only top-ups read balances, so anything on a cut day falls in that cut.
export const ORDER = { money_in: 1, cash_transfer: 2, spending: 3, payment: 4, cut: 5, top_up: 6 } as const
export type OrderClass = (typeof ORDER)[keyof typeof ORDER]

export type EventKind = 'income' | 'draw' | 'bill' | 'card_bill' | 'allowance' | 'transfer' | 'installment' | 'row'

export interface EngineEvent {
  // The occurrence id, `row:<id>` for a recorded row, or `allowance:<account>:<category>:<YYYY-MM>`.
  id: string
  kind: EventKind
  order: OrderClass
  date: string
  // The last day of an allowance spread; equal to date for every other event.
  until: string
  account_id: string
  // A planned cash-to-cash transfer lands its net here; the walk converts and charges the fee.
  to_account_id: string | null
  // Signed, in the account's currency, as it moves that account: a transfer's is −gross, an allowance's the whole spread.
  amount_minor: number
  occurrence_ids: readonly string[]
  row_id: string | null
  overdue: boolean
}

export interface ExpandedPlan {
  as_of: string
  // Occurrences dated before it are history, with no state and no event; an allowance whose month reaches it still counts.
  history_from: string
  horizon_end: string
  // Date order, then id.
  occurrences: readonly Occurrence[]
  byId: ReadonlyMap<string, Occurrence>
  suggestions: readonly Suggestion[]
  // This month to the horizon end, by month then category.
  budgets: readonly CategoryBudget[]
  // Date order, then order class, then id.
  events: readonly EngineEvent[]
}

export type WalkMode = 'full' | 'metrics'

export type WalkErrorCode = 'funding_cycle' | 'non_cash_funder' | 'statement_not_on_card' | 'row_before_opening' | 'missing_rate'

// A walk that cannot run says why, so no screen ever reads a zero in place of a figure.
export interface WalkError {
  code: WalkErrorCode
  message: string
  // The accounts, statements or rows it names.
  ids: readonly string[]
}

export type DebtMoveKind = 'payment' | 'interest'
export type LineSource = 'plan' | 'row' | 'top_up' | 'card' | 'loan'
export type LineKind = EventKind | 'top_up' | DebtMoveKind
export type LineFlag = 'to_send' | 'overdue' | 'estimated'

// One money movement the walk made on one account; screens read these and never re-derive them.
export interface LineItem {
  id: string
  source: LineSource
  kind: LineKind
  order: OrderClass
  account_id: string
  // Signed as it moves the account, in the account's currency.
  amount_minor: number
  // The day it moves the walk's balance; a debt event dated before as_of moves it on as_of.
  date: string
  // An allowance's last day, spent evenly from date; equal to date for every other line.
  until: string
  // The occurrence's state; null for rows, top-ups and debt moves.
  state: OccurrenceState | null
  flags: readonly LineFlag[]
  occurrence_ids: readonly string[]
  row_id: string | null
  // The other leg of a transfer, a top-up or a payment.
  pair_id: string | null
}

export type MonthWord = 'Short' | 'Tight' | 'OK'

// One cash account's month, summed from the walked days; this month starts at as_of.
export interface MonthFigures {
  account_id: string
  month: string
  first_day: string
  last_day: string
  // The balance before the month's first walked day, and at the end of its last.
  opening_minor: number
  closing_minor: number
  // Money in and out as positive figures, top-ups apart, so closing = opening + in − out + top-ups in − top-ups out.
  in_minor: number
  out_minor: number
  top_up_in_minor: number
  top_up_out_minor: number
  lowest_minor: number
  lowest_on: string
  floor_minor: number
  target_minor: number
  // False when no floor window covers the month, so floor and target are both 0.
  floor_set: boolean
  days_under_floor: number
  days_under_target: number
  // The largest shortfall below the floor after top-ups that no later top-up that month covers.
  unfixable_gap_minor: number
  word: MonthWord
}

export interface Walk {
  ok: true
  as_of: string
  horizon_end: string
  mode: WalkMode
  // The currency money leaves when it crosses currencies; null in a one-currency household.
  funding_currency: string | null
  fx_shift_pct: number
  // The rates per EUR the walk converted at, after the shift.
  rates: Readonly<Record<string, number>>
  // Walked days, as_of first; index i of every balance array is days[i].
  days: readonly string[]
  // This month to the horizon end, as YYYY-MM.
  months: readonly string[]
  // Each account's balance before as_of's events: opening plus every row up to as_of.
  start: ReadonlyMap<string, number>
  // End-of-day balance per account and walked day, in whole minor units.
  balances: ReadonlyMap<string, Float64Array>
  // Cash accounts only, one entry per month in `months`.
  figures: ReadonlyMap<string, readonly MonthFigures[]>
  // Date, then order class, then id; empty in metrics mode.
  lines: readonly LineItem[]
  cards: unknown
  loans: unknown
}

export interface WalkFailure {
  ok: false
  errors: readonly WalkError[]
}

export type WalkResult = Walk | WalkFailure
