import {
  addDays,
  alerts,
  budgetRows,
  daysBetween,
  dropSameSubject,
  expandPlan,
  lastDayOfMonth,
  monthKey,
  moneyPart,
  nextAction,
  reviewList,
  snapshotIndex,
  textPart,
  todayBudgets,
  type Alert,
  type BudgetRow,
  type Copy,
  type FxBreakeven,
  type LineItem,
  type MonthWord,
  type NextAction,
  type ReviewItem,
  type Route,
  type Snapshot,
  type Walk,
} from '@waypoint/core'
import { NEW_ITEM_ID } from '../../shell/url.model'
import { identityIndex, identityOf } from '../../ui/identity'

// Spec §7 Today, top to bottom. Alerts sit above every figure below them, so phone order is also priority order (rule 182).
export const SECTIONS = ['next', 'alert', 'cash', 'budgets', 'agenda'] as const
export type Section = (typeof SECTIONS)[number]

export const AGENDA_DAYS = 30

// An address inside the app; the screen passes it to the router as it is.
export type TodayLink =
  | { pathname: '/add'; params: Partial<Record<'mode' | 'from' | 'to' | 'amount' | 'plan_item_id' | 'period', string>> }
  | { pathname: '/statement'; params: { account: string } }
  | { pathname: '/months'; params: { month: string; view: 'todo' | 'breakdown' | 'chart' } }
  | { pathname: '/settings/account/[id]'; params: { id: string } }
  | { pathname: '/debts/[accountId]'; params: { accountId: string } }
  | { pathname: '/money/[accountId]'; params: { accountId: string } }
  | { pathname: '/plan/item/[id]'; params: { id: string } }
  | { pathname: '/' | '/budgets' | '/debts' | '/money' | '/plan' }

// Where 'Add your income and bills' leads: the plan item editor on a new item.
export const PLAN_EDITOR: TodayLink = { pathname: '/plan/item/[id]', params: { id: NEW_ITEM_ID } }

// The app records a transfer or payment the person makes at their bank; it moves no money, so a button never says Send or Pay.
export const RECORD_TRANSFER = 'Record transfer'
export const RECORD_PAYMENT = 'Record payment'

export interface TodayNext {
  action: NextAction
  // When it is for, beside 'Next action': late, today, or a later day this month it can be done by.
  when: { late: true } | { late: false; by: string | null }
  // The line under the title: the action's context, or for a top-up where it is made and what it covers.
  detail: Copy
  // A later top-up this month on the same route, such as 'Then €104.87 more on 28 Oct.'
  later: Copy | null
  // null for 'Nothing to do now'.
  button: { label: string; link: TodayLink } | null
}

export interface TodayAlert {
  alert: Alert
  // What it is about: the first name in its body, and the month when it is not this one.
  about: Copy
  tone: 'negative' | 'caution' | 'neutral'
  // The alerts left after this one; the line opens this month's To-do, where alerts come first.
  more: number
  link: TodayLink
}

export interface CashRow {
  account_id: string
  currency: string
  // Opening plus every row up to today, and the walk's balance at month end.
  live_minor: number
  end_minor: number
  word: MonthWord
  // The account's place in the account order, which picks its tile's colour on every screen.
  colour: number
  // This month's floor; null with no floor set, when floor_link is set instead.
  floor_minor: number | null
  // Where a Short or Tight month dips: its lowest balance and that day, so the word and the figures agree.
  lowest: { minor: number; on: string } | null
  // Set when no floor window covers this month: the account editor sets one.
  floor_link: TodayLink | null
}

export interface AgendaItem {
  // The walk line it shows: a transfer, a top-up or a debt payment shows once, as the leg leaving cash.
  id: string
  date: string
  account_id: string
  // The cash account a transfer or a top-up lands in.
  to_account_id: string | null
  // The listed account's place in the account order, which picks its swatch's colour as on every screen.
  colour: number
  title: Copy
  currency: string
  amount_minor: number
  // The account's balance after this item: the walk's end of day less the items listed after it that day.
  after_minor: number
  words: readonly string[]
  // Money that landed in this account since its row before, listed only on the account it left: its balance after takes it in.
  landed: readonly AgendaLanding[]
  // This month's open plan entries, and late income, open the Add sheet linked to their occurrence.
  record: TodayLink | null
}

export interface AgendaLanding {
  from_account_id: string
  kind: 'top_up' | 'transfer'
}

export interface AgendaDay {
  date: string
  items: readonly AgendaItem[]
}

export interface TodayModel {
  as_of: string
  month: string
  // Where the cash accounts' second figure is read.
  month_end: string
  // No plan items: 'Add your income and bills' follows any action due now.
  empty: boolean
  // The sections with something to show, always in SECTIONS order.
  sections: readonly Section[]
  next: TodayNext
  alert: TodayAlert | null
  cash: readonly CashRow[]
  budgets: readonly BudgetRow[]
  all_budgets: TodayLink
  agenda: readonly AgendaDay[]
  // The last day of the agenda window.
  until: string
}

export interface TodayInputs {
  snapshot: Snapshot
  // A full walk with the card and loan modules (core runEngine).
  walk: Walk
  // null only in a one-currency household.
  breakeven: FxBreakeven | null
}

const TONES = { critical: 'negative', warning: 'caution', info: 'neutral' } as const

// The first account, item or category its body names, so the line says which one without its figures.
function aboutOf(alert: Alert, month: string): Copy {
  const name = alert.body.find((p) => 'account' in p || 'item' in p || 'category' in p)
  const other = 'month' in alert.subject && alert.subject.month !== month ? alert.subject.month : null
  if (!name) return other ? [{ month: other }] : []
  return other ? [name, textPart(', '), { month: other }] : [name]
}

const monthsLink = (month: string, view: 'todo' | 'breakdown' | 'chart'): TodayLink => ({ pathname: '/months', params: { month, view } })

// A core route as an address: a tab, with Months' month and view, or an account's page.
export function routeLink(route: Route, month: string): TodayLink {
  if (route.sheet === 'statement' && route.account_id) return { pathname: '/statement', params: { account: route.account_id } }
  if (route.sheet === 'add') return { pathname: '/add', params: route.account_id ? { from: route.account_id } : {} }
  if (route.tab === 'months') return monthsLink(route.month ?? month, route.segment ?? 'todo')
  if (route.tab === 'debts') return route.account_id ? { pathname: '/debts/[accountId]', params: { accountId: route.account_id } } : { pathname: '/debts' }
  if (route.tab === 'money') return route.account_id ? { pathname: '/money/[accountId]', params: { accountId: route.account_id } } : { pathname: '/money' }
  if (route.tab === 'plan') return { pathname: '/plan' }
  return { pathname: '/' }
}

// Record: the Add sheet linked to one occurrence, which brings its mode, accounts and open amount.
const recordLink = (planItemId: string, period: string): TodayLink => ({ pathname: '/add', params: { plan_item_id: planItemId, period } })

// One button per next action, opening the Add or Statement sheet prefilled; a suggestion goes to To-do, where it is linked rather than recorded again.
function nextButton(snapshot: Snapshot, action: NextAction, review: readonly ReviewItem[], month: string): TodayNext['button'] {
  const prefill = action.prefill
  const from = prefill?.from_account_id ? { from: prefill.from_account_id } : {}
  if (action.kind === 'send' && prefill?.sent) {
    return { label: RECORD_TRANSFER, link: { pathname: '/add', params: { mode: 'move', ...from, to: prefill.to_account_id, amount: String(prefill.sent.minor) } } }
  }
  // No amount for a card: the sheet prefills left to pay itself, in Received when the currencies differ.
  if (action.kind === 'pay' && prefill) return { label: RECORD_PAYMENT, link: { pathname: '/add', params: { mode: 'move', ...from, to: prefill.to_account_id } } }
  if (action.kind === 'enter_statement' && action.route.account_id) return { label: 'Enter statement', link: { pathname: '/statement', params: { account: action.route.account_id } } }
  if (action.kind !== 'review') return null
  const item = review.find((r) => r.id === action.review_id)
  const occurrence = item?.occurrence_id ? expandPlan(snapshot).byId.get(item.occurrence_id) : undefined
  if (item && occurrence && (item.kind === 'overdue_outflow' || item.kind === 'unconfirmed_inflow')) return { label: 'Record', link: recordLink(occurrence.plan_item_id, occurrence.period) }
  if (item?.kind === 'overdue_outflow' && item.occurrence_id === null) return { label: RECORD_PAYMENT, link: { pathname: '/add', params: { mode: 'move', to: item.account_id } } }
  if (item?.kind === 'statement_warning') return { label: 'Check statement', link: { pathname: '/statement', params: { account: item.account_id } } }
  return { label: 'Review', link: routeLink(action.route, month) }
}

const MAKE_TRANSFER = 'Make this transfer at your bank, then record it here.'

// A top-up says where it is made and what it covers, since the app moves no money; its later line, 'and €104.87 more on 28 Oct', becomes its own sentence.
export function nextLines(action: NextAction, covers: Copy | null = null): Pick<TodayNext, 'detail' | 'later'> {
  if (action.kind !== 'send') return { detail: action.context, later: null }
  const detail: Copy = [textPart(MAKE_TRANSFER), ...(covers ? [textPart(' '), ...covers] : [])]
  if (action.context.length === 0) return { detail, later: null }
  const [first, ...rest] = action.context
  return { detail, later: first && 'text' in first && first.text === 'and ' ? [textPart('Then '), ...rest, textPart('.')] : action.context }
}

// Late before today's date, else the day it is for; null when it has no day.
export function nextWhen(action: NextAction, asOf: string): TodayNext['when'] {
  if (action.act_by !== null && action.act_by < asOf) return { late: true }
  return { late: false, by: action.act_by }
}

// What a top-up is for: the largest payment out of the account it lands in on its day, which takes that account under its floor; across currencies, what lands too.
export function topUpCovers(snapshot: Snapshot, walk: Walk, action: NextAction): Copy | null {
  const prefill = action.prefill
  if (action.kind !== 'send' || !prefill?.from_account_id || action.act_by === null) return null
  const day = action.act_by
  const out = walk.lines.find((l) => l.source === 'top_up' && l.amount_minor < 0 && l.date === day && l.id.startsWith(`top-up:${prefill.from_account_id}>${prefill.to_account_id}:`))
  const landed = out?.pair_id ? walk.lines.find((l) => l.id === out.pair_id) : undefined
  const paid = walk.lines.filter((l) => l.account_id === prefill.to_account_id && l.date === day && l.amount_minor < 0 && l.source !== 'top_up' && l.kind !== 'allowance').sort((a, b) => a.amount_minor - b.amount_minor)[0]
  const index = snapshotIndex(snapshot)
  const across = landed !== undefined && index.accounts.get(prefill.from_account_id)?.currency !== index.accounts.get(prefill.to_account_id)?.currency
  const arrives: Copy = across && landed ? [textPart('It arrives as '), moneyPart(landed.amount_minor, index.accounts.get(prefill.to_account_id)?.currency ?? '')] : []
  const when: Copy = day === snapshot.as_of ? [textPart(' today.')] : [textPart(' on '), { date: day }, textPart('.')]
  if (!paid) return arrives.length > 0 ? [...arrives, textPart('.')] : null
  const what = lineTitles(snapshot, walk)(paid)
  return [...(arrives.length > 0 ? [...arrives, textPart(' and covers the ')] : [textPart('It covers the ')]), ...what, ...when]
}

export interface PaceBar {
  // Spent as a share of the budget, 0 to 1, and the share of the month gone by today, where the plan's mark sits.
  spent: number
  mark: number
  // What the plan spends by today: the budget over the month's days, times the days gone.
  plan_minor: number
  // Caution while spending fast; Cobalt text colour otherwise.
  fill: 'caution' | 'brandText'
}

// A budget's pace as a bar: what is spent so far against where the plan is today (spec §7 budget pace).
export function paceBar(row: BudgetRow): PaceBar {
  const share = row.budget_minor > 0 ? row.spent_minor / row.budget_minor : row.spent_minor > 0 ? 1 : 0
  return {
    spent: Math.min(1, Math.max(0, share)),
    mark: row.days_in_month > 0 ? row.days_elapsed / row.days_in_month : 0,
    plan_minor: row.days_in_month > 0 ? Math.round((row.budget_minor * row.days_elapsed) / row.days_in_month) : 0,
    fill: row.word === 'Spending fast' ? 'caution' : 'brandText',
  }
}

// The walk lines the next action already states: today's top-up and the later one it names, today's card payment, or the review item's own line.
export function coveredLines(snapshot: Snapshot, walk: Walk, action: NextAction, review: readonly ReviewItem[]): ReadonlySet<string> {
  const asOf = snapshot.as_of
  const month = monthKey(asOf)
  const prefill = action.prefill
  const out = new Set<string>()
  if (action.kind === 'send' && prefill?.from_account_id && action.act_by !== null) {
    const day = action.act_by
    const head = `top-up:${prefill.from_account_id}>${prefill.to_account_id}:`
    const sends = walk.lines.filter((l) => l.source === 'top_up' && l.amount_minor < 0 && l.id.startsWith(head) && monthKey(l.date) === month)
    for (const l of [sends.find((x) => x.date === day), sends.find((x) => x.date > day)]) if (l) out.add(l.id)
  }
  if (action.kind === 'pay' && prefill) {
    // The payment's first day from today: today when it is due or late, else its pay day this month.
    const legs = walk.lines.filter((l) => l.source === 'card' && l.date >= asOf && l.amount_minor < 0 && l.id.startsWith(`payment:${prefill.to_account_id}:`))
    const first = legs[0]?.date
    for (const l of legs) if (l.date === first) out.add(l.id)
  }
  const item = action.kind === 'review' ? review.find((r) => r.id === action.review_id) : undefined
  if (item?.occurrence_id) for (const l of walk.lines) if (l.source === 'plan' && l.occurrence_ids.includes(item.occurrence_id)) out.add(l.id)
  if (item?.kind === 'overdue_outflow' && item.occurrence_id === null) out.add(`${item.id.slice('overdue_outflow:'.length)}#out`)
  return out
}

const RECORDABLE = new Set(['due', 'overdue', 'late', 'partly_settled'])

// A walk line's name: its plan item, a card's payment, a transfer's other account, or the row's own description.
export function lineTitles(snapshot: Snapshot, walk: Walk): (l: LineItem) => Copy {
  const index = snapshotIndex(snapshot)
  const plan = expandPlan(snapshot)
  const byId = new Map(walk.lines.map((l) => [l.id, l]))
  const rows = new Map(snapshot.doc.transactions.map((t) => [t.id, t]))
  return (l) => {
    const pair = l.pair_id === null ? undefined : byId.get(l.pair_id)
    const occurrence = l.occurrence_ids.length === 1 ? plan.byId.get(l.occurrence_ids[0] ?? '') : undefined
    if (l.source === 'plan' && occurrence) return [{ item: occurrence.plan_item_id }]
    if (l.source === 'top_up') return [textPart('Top-up')]
    if ((l.source === 'card' || l.source === 'loan') && pair) {
      if (l.id.startsWith('payment:')) return [{ account: pair.account_id }, textPart(' payment')]
      if (occurrence) return [{ item: occurrence.plan_item_id }]
      return [textPart('Extra payment to '), { account: pair.account_id }]
    }
    const row = l.row_id === null ? undefined : rows.get(l.row_id)
    if (row?.description) return [textPart(row.description)]
    const other = row?.transfer_id ? index.transfers.get(row.transfer_id)?.find((t) => t.id !== row.id) : undefined
    if (other) return [textPart(l.amount_minor > 0 ? 'Transfer from ' : 'Transfer to '), { account: other.account_id }]
    return [textPart(row ? ROW_WORDS[row.kind] : 'Recorded')]
  }
}

const ROW_WORDS = { income: 'Income', expense: 'Expense', refund: 'Refund', transfer: 'Transfer', drawdown: 'Drawdown', adjustment: 'Adjustment' } as const

// Each cash line from today to the window's end, by day, with the balance after it, less what the next action states; budgets spend apart from it and show above.
export function agendaOf(snapshot: Snapshot, walk: Walk, skip: ReadonlySet<string> = new Set(), days = AGENDA_DAYS): { days: AgendaDay[]; until: string } {
  const index = snapshotIndex(snapshot)
  const plan = expandPlan(snapshot)
  const asOf = snapshot.as_of
  const month = monthKey(asOf)
  const until = addDays(asOf, days - 1)
  const cash = new Set(snapshot.doc.accounts.filter((a) => a.kind === 'cash' && a.archived_at === null).map((a) => a.id))
  const identity = identityIndex(snapshot.doc.accounts)
  const byId = new Map(walk.lines.map((l) => [l.id, l]))
  const titleOf = lineTitles(snapshot, walk)
  const lines = walk.lines.filter((l) => cash.has(l.account_id) && l.date <= until && l.kind !== 'allowance' && l.amount_minor !== 0)
  const listed = new Set(lines.map((l) => l.id))
  // The leg landing in cash is the same move as the leg leaving it.
  const landing = (l: LineItem) => l.amount_minor > 0 && l.pair_id !== null && listed.has(l.pair_id) && (byId.get(l.pair_id)?.amount_minor ?? 0) < 0
  const shown = lines.filter((l) => !skip.has(l.id) && !landing(l))

  const items: AgendaItem[] = shown.map((l) => {
    const pair = l.pair_id === null ? undefined : byId.get(l.pair_id)
    const occurrence = l.source === 'plan' && l.occurrence_ids.length === 1 ? plan.byId.get(l.occurrence_ids[0] ?? '') : undefined
    const words: string[] = []
    if (l.flags.includes('overdue')) words.push('Overdue')
    if (l.state === 'late') words.push('Late')
    if (l.state === 'partly_settled') words.push('Partly settled')
    if (l.flags.includes('estimated')) words.push('Estimated')
    // Late income is past money carried to next month, so it can be recorded now.
    const record = occurrence && l.state !== null && RECORDABLE.has(l.state) && (monthKey(l.date) === month || l.state === 'late') ? recordLink(occurrence.plan_item_id, occurrence.period) : null
    const to = pair && pair.account_id !== l.account_id && (l.source === 'top_up' || (l.source === 'plan' && cash.has(pair.account_id))) ? pair.account_id : null
    return {
      id: l.id,
      date: l.date,
      account_id: l.account_id,
      to_account_id: to,
      colour: identityOf(identity, l.account_id),
      title: titleOf(l),
      currency: index.accounts.get(l.account_id)?.currency ?? snapshot.doc.household.base_currency,
      amount_minor: l.amount_minor,
      after_minor: 0,
      words,
      landed: [],
      record,
    }
  })

  // A landing leg counts from the start of its day, so the account's next row on or after that day is the one whose balance takes it in.
  for (const l of lines) {
    const from = l.pair_id === null ? undefined : byId.get(l.pair_id)
    if (!landing(l) || !from) continue
    const next = items.find((i) => i.account_id === l.account_id && i.date >= l.date)
    const kind = l.source === 'top_up' ? 'top_up' : 'transfer'
    // Two moves from one account into the same row say so once.
    if (next && !next.landed.some((x) => x.from_account_id === from.account_id && x.kind === kind)) (next.landed as AgendaLanding[]).push({ from_account_id: from.account_id, kind })
  }

  // Backwards from each day's closing balance, so the day's last item ends where the walk does.
  const later = new Map<string, number>()
  for (let k = items.length - 1; k >= 0; k--) {
    const item = items[k] as AgendaItem
    const key = `${item.account_id} ${item.date}`
    const end = walk.balances.get(item.account_id)?.[daysBetween(asOf, item.date)]
    if (end === undefined) throw new Error(`The walk has no balance for '${item.account_id}' on ${item.date}`)
    const after = later.get(key) ?? 0
    item.after_minor = end - after
    later.set(key, after + item.amount_minor)
  }

  const out: AgendaDay[] = []
  for (const item of items) {
    const last = out.at(-1)
    if (last?.date === item.date) (last.items as AgendaItem[]).push(item)
    else out.push({ date: item.date, items: [item] })
  }
  return { days: out, until }
}

// Everything Today shows, from one snapshot and its full walk; the screen only lays it out.
export function todayModel({ snapshot, walk, breakeven }: TodayInputs): TodayModel {
  const asOf = snapshot.as_of
  const month = monthKey(asOf)
  const review = reviewList(snapshot, walk)
  const rows = budgetRows(snapshot)
  const action = nextAction({ snapshot, walk, review })
  const left = dropSameSubject(alerts({ snapshot, walk, review, breakeven, budgets: rows }), action)
  const worst = left[0]
  const alert: TodayAlert | null = worst ? { alert: worst, about: aboutOf(worst, month), tone: TONES[worst.severity], more: left.length - 1, link: monthsLink(month, 'todo') } : null

  const identity = identityIndex(snapshot.doc.accounts)
  const cash: CashRow[] = snapshot.doc.accounts
    .filter((a) => a.kind === 'cash' && a.archived_at === null)
    .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1))
    .map((a) => {
      const figures = walk.figures.get(a.id)?.[0]
      const live = walk.start.get(a.id)
      if (!figures || live === undefined) throw new Error(`The walk has no figures for '${a.id}'`)
      return {
        account_id: a.id,
        currency: a.currency,
        live_minor: live,
        end_minor: figures.closing_minor,
        word: figures.word,
        colour: identityOf(identity, a.id),
        floor_minor: figures.floor_set ? figures.floor_minor : null,
        lowest: figures.word === 'OK' ? null : { minor: figures.lowest_minor, on: figures.lowest_on },
        floor_link: figures.floor_set ? null : { pathname: '/settings/account/[id]', params: { id: a.id } },
      }
    })

  const budgets = todayBudgets(rows)
  const agenda = agendaOf(snapshot, walk, coveredLines(snapshot, walk, action, review))
  const empty = snapshot.doc.plan_items.length === 0
  // With no plan, what is due now and the live balances stay above 'Add your income and bills'.
  const has: Record<Section, boolean> = empty
    ? { next: action.kind !== 'none', alert: alert !== null, cash: cash.length > 0, budgets: false, agenda: false }
    : // 'Nothing to do now' never sits above an alert or a short account; then the alert leads.
      { next: action.kind !== 'none' || (alert === null && cash.every((c) => c.word === 'OK')), alert: alert !== null, cash: cash.length > 0, budgets: budgets.length > 0, agenda: true }
  return {
    as_of: asOf,
    month,
    month_end: lastDayOfMonth(asOf),
    empty,
    sections: SECTIONS.filter((s) => has[s]),
    next: { action, when: nextWhen(action, asOf), ...nextLines(action, topUpCovers(snapshot, walk, action)), button: nextButton(snapshot, action, review, month) },
    alert,
    cash,
    budgets,
    all_budgets: { pathname: '/budgets' },
    agenda: agenda.days,
    until: agenda.until,
  }
}

// 'Today', 'Tomorrow', else the weekday and date in the household locale.
export function dayTitle(day: string, asOf: string, locale: string): string {
  const gap = daysBetween(asOf, day)
  if (gap === 0) return 'Today'
  if (gap === 1) return 'Tomorrow'
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}
