import {
  addDays,
  addMonths,
  daysBetween,
  firstOfMonth,
  floorSchedule,
  floorScheduleCopy,
  horizonEnd,
  installmentProgress,
  itemSchedule,
  minorDigits,
  monthKey,
  MONTHS_APART,
  moneyPart,
  snapshotIndex,
  textPart,
  walkMetrics,
  type Account,
  type Copy,
  type CopyPart,
  type FxBreakeven,
  type Money,
  type MoneyLasts,
  type PlanItem,
  type RateIndependent,
  type Snapshot,
  type Walk,
  type WalkFailure,
} from '@waypoint/core'
import { NEW_ITEM_ID } from '../../shell/url.model'
import { headline, heroHeadline, minimumNote, minimumOnly, tryExtraLink, type DebtLink, type Headline } from '../debts/debts.model'
import { EVERY_WORDS } from './item.model'

// Spec §7 Plan: the debt-free month, each cash account's lowest balance, floor and days under floor, FX margin and breakeven rate, months the money lasts if income stops, then every plan item by kind. Every figure is the engine's (rule 139); nothing here sums again.

export type PlanLink = { pathname: '/plan/item/[id]'; params: { id: string } } | { pathname: '/plan/compare' }

// The plan item editor opened on a new item.
export const NEW_ITEM: PlanLink = { pathname: '/plan/item/[id]', params: { id: NEW_ITEM_ID } }
export const COMPARE: PlanLink = { pathname: '/plan/compare' }

// Says the headline is a projection from what is recorded today, so every page quoting it quotes the same walk (rule 139).
export const BASIS = (day: string) => `From the balances on ${day} and every plan item`

export interface CashLine {
  account_id: string
  currency: string
  // The lowest end-of-day balance to the end of the projection, and the first day it occurs.
  lowest_minor: number
  lowest_on: string
  // The floor and target from this month on, in core's words; null when no window sets either.
  floor: Copy | null
  // Days ending below the floor after top-ups, the figure Compare compares, and below the target.
  days_under_floor: number
  days_under_target: number
  // The account's word over the whole projection, on Months' scale: Short with a day under the floor, Tight with one under the target only.
  word: 'OK' | 'Tight' | 'Short'
}

export interface CashGroup {
  currency: string
  accounts: readonly CashLine[]
}

export interface PlanHeadline {
  debt_free: Headline
  // Compare with extra payments, when the plan pays only the minimum on a card it never clears.
  try_extra: DebtLink | null
  // The last month the projection covers.
  horizon_month: string
  cash: readonly CashGroup[]
}

const bySortOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The headline numbers of one walk with the card and loan modules (core runEngine), read from core walkMetrics.
export function planHeadline(snapshot: Snapshot, walk: Walk): PlanHeadline {
  const metrics = walkMetrics(snapshot, walk)
  const horizon = monthKey(walk.horizon_end)
  const debts = snapshot.doc.accounts.some((a) => a.kind !== 'cash' && a.archived_at === null)
  const debtFree = headline(metrics.debt_free, horizon)
  const minimum = debts && metrics.debt_free.after_horizon ? minimumNote(minimumOnly(snapshot, walk)) : null
  const fromMonth = monthKey(snapshot.as_of)
  const groups: { currency: string; accounts: CashLine[] }[] = []
  const open = snapshot.doc.accounts.filter((a) => a.kind === 'cash' && a.archived_at === null).sort(bySortOrder)
  for (const account of open) {
    const m = metrics.cash.find((c) => c.account_id === account.id)
    if (!m) continue
    const phases = floorSchedule(account.floor_windows, fromMonth)
    const line: CashLine = {
      account_id: account.id,
      currency: account.currency,
      lowest_minor: m.lowest_minor,
      lowest_on: m.lowest_on,
      floor: phases.every((p) => p.floor_minor === 0 && p.target_minor === 0) ? null : floorScheduleCopy(phases, account.currency),
      days_under_floor: m.days_under_floor,
      days_under_target: m.days_under_target,
      word: m.days_under_floor > 0 ? 'Short' : m.days_under_target > 0 ? 'Tight' : 'OK',
    }
    const group = groups.find((g) => g.currency === account.currency)
    if (group) group.accounts.push(line)
    else groups.push({ currency: account.currency, accounts: [line] })
  }
  return {
    debt_free: !debts ? { ...debtFree, note: [textPart('No cards or loans.')] } : heroHeadline(metrics.debt_free, horizon, minimum, snapshot),
    try_extra: minimum ? tryExtraLink(snapshot, walk) : null,
    horizon_month: horizon,
    cash: groups,
  }
}

export type BreakevenResult = FxBreakeven | WalkFailure | null

export interface FxPairView {
  // The stronger currency is the unit, as in the FX chip: '€1 = ₱48.23'.
  from: string
  to: string
  unit_minor: number
  today_minor: number
  breakeven_minor: number
}

export type FxView =
  // A one-currency household has no FX margin.
  | { state: 'none' }
  | { state: 'calculating' }
  | { state: 'failed'; message: string }
  | {
      state: 'ready'
      funding_currency: string
      // 1 − m, to 0.001; below zero, the funding currency has to rise before every day stays at or above zero.
      margin: number
      // m = 0.5 already holds, so the margin is 50% or more.
      below_range: boolean
      pairs: readonly FxPairView[]
      // Where the money runs out first past the breakeven.
      binding: { account_id: string; date: string } | null
      // Days below zero at any rate, which the margin leaves out.
      rate_independent: readonly RateIndependent[]
    }

const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1

const errorText = (failure: WalkFailure | Error) => (failure instanceof Error ? failure.message : failure.errors.map((e) => e.message).join(' '))

// The breakeven pair as the FX chip writes it: whichever currency buys at least one whole unit of the other is the unit.
function pairOf(funding: string, currency: string, today: number, breakeven: number): FxPairView {
  const strong = today >= 1
  const [from, to] = strong ? [funding, currency] : [currency, funding]
  const scale = 10 ** minorDigits(to)
  const price = (rate: number) => Math.round((strong ? rate : 1 / rate) * scale)
  return { from, to, unit_minor: 10 ** minorDigits(from), today_minor: price(today), breakeven_minor: price(breakeven) }
}

// The FX rows from core fxBreakeven: undefined while it runs between frames, null in a one-currency household.
export function fxView(result: BreakevenResult | Error | undefined): FxView {
  if (result === undefined) return { state: 'calculating' }
  if (result === null) return { state: 'none' }
  if (result instanceof Error || !result.ok) return { state: 'failed', message: errorText(result) }
  return {
    state: 'ready',
    funding_currency: result.funding_currency,
    margin: result.margin,
    below_range: result.below_range,
    pairs: result.rates.map((r) => pairOf(result.funding_currency, r.currency, r.today, r.breakeven)),
    binding: result.binding ? { account_id: result.binding.account_id, date: result.binding.date } : null,
    rate_independent: result.rate_independent,
  }
}

export type MoneyLastsResult = MoneyLasts | WalkFailure | null

export type LastsView =
  | { state: 'calculating' }
  | { state: 'failed'; message: string }
  // Income stops from `from_month` (core's next month); the first cash account to end a day below zero sets the count.
  | { state: 'ready'; months: number; account_id: string; date: string; from_month: string }
  // No cash account ends a day below zero before the projection ends, so the money lasts at least `months`.
  | { state: 'through'; months: number; from_month: string; horizon_month: string }

// Months the money lasts if income stops, from core monthsMoneyLasts (never called runway).
export function lastsView(result: MoneyLastsResult | Error | undefined, asOf: string, horizonMonth: string): LastsView {
  if (result === undefined) return { state: 'calculating' }
  const from = monthKey(addMonths(firstOfMonth(asOf), 1))
  if (result === null) return { state: 'through', months: monthIndex(horizonMonth) - monthIndex(from) + 1, from_month: from, horizon_month: horizonMonth }
  if (result instanceof Error || !result.ok) return { state: 'failed', message: errorText(result) }
  return { state: 'ready', months: result.months, account_id: result.account_id, date: result.date, from_month: from }
}

export const ITEM_GROUPS = ['income', 'bills', 'budgets', 'transfers', 'installments', 'upsides', 'past'] as const
export type ItemGroup = (typeof ITEM_GROUPS)[number]

export const GROUP_TITLES: Record<ItemGroup, string> = {
  income: 'Income',
  bills: 'Bills',
  budgets: 'Budgets',
  transfers: 'Transfers',
  installments: 'Installments',
  upsides: 'Upsides',
  past: 'Past',
}

// Upsides never reach the walk; Compare includes one at a time.
export const GROUP_NOTES: Partial<Record<ItemGroup, string>> = {
  upsides: 'Left out of every figure above. Compare shows what one would change.',
  past: 'Already happened. Kept so past months still add up.',
}

// A group's title with its row count: 'Income · 12'.
export const groupHeading = (group: ItemGroup, count: number) => `${GROUP_TITLES[group]} · ${count}`

const GROUP_OF_KIND: Record<PlanItem['kind'], ItemGroup> = { income: 'income', bill: 'bills', allowance: 'budgets', transfer: 'transfers', installment: 'installments' }

export type ItemChip = 'Estimated' | 'Upside'

export interface ItemRow {
  // The step that covers this month, else the next to start, else the last; the row's editor opens it.
  item: PlanItem
  // The item's rows, oldest first: one, or each step split_plan_item made.
  steps: readonly PlanItem[]
  group: ItemGroup
  // The amount in the currency of the account it is counted on.
  amount: Money
  // The accounts it moves money between, in words.
  route: Copy
  chips: readonly ItemChip[]
  // An installment's statements billed so far, of all it bills.
  progress: { billed: number; total: number } | null
  // The last step's last date, which the schedule words end on; null for no end.
  ends_on: string | null
  // 'Changes to <amount> from <month>' or 'Changed from <amount> in <month>'; null when no step has another amount.
  change: Copy | null
  // The steps before this one, each with its amount and months; null when there are none.
  earlier: Copy | null
  // The next day money moves, or the last day it moved when none is left to come; orders the group.
  on: string
  link: PlanLink
}

// The item's last occurrence falls in a month before this one, so nothing of it is left to come.
export function ended(item: PlanItem, asOf: string): boolean {
  const now = monthKey(asOf)
  if (item.every === 'once') return monthKey(item.starts_on) < now
  return item.ends_on !== null && monthKey(item.ends_on) < now
}

// `next` starts after `prev` ends and no later than prev's next occurrence would have fallen, as split_plan_item leaves the two rows.
function follows(prev: PlanItem, next: PlanItem): boolean {
  if (prev.every === 'once' || prev.ends_on === null || next.starts_on <= prev.ends_on) return false
  if (prev.every === 'week' || prev.every === '2weeks') return daysBetween(prev.ends_on, next.starts_on) <= (prev.every === 'week' ? 7 : 14)
  return monthIndex(next.starts_on) - monthIndex(prev.ends_on) <= MONTHS_APART[prev.every]
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Rows that are one item over time: the same kind, name, accounts and category, each starting where the one before ends. Every row is in one series, oldest first.
export function itemSeries(items: readonly PlanItem[]): PlanItem[][] {
  const same = new Map<string, PlanItem[]>()
  for (const item of items) {
    const key = JSON.stringify([item.kind, item.name, item.from_account_id, item.to_account_id, item.category_id])
    const list = same.get(key)
    if (list) list.push(item)
    else same.set(key, [item])
  }
  const out: PlanItem[][] = []
  for (const rows of same.values()) {
    rows.sort((a, b) => byText(a.starts_on, b.starts_on) || byText(a.id, b.id))
    let series: PlanItem[] = []
    for (const row of rows) {
      const prev = series.at(-1)
      if (prev && follows(prev, row)) series.push(row)
      else {
        if (prev) out.push(series)
        series = [row]
      }
    }
    out.push(series)
  }
  return out
}

// The steps of the series item `id` is in, oldest first; null for an item of one row.
export function stepsOf(items: readonly PlanItem[], id: string): readonly PlanItem[] | null {
  const series = itemSeries(items).find((s) => s.some((p) => p.id === id))
  return series && series.length > 1 ? series : null
}

// The first later amount that differs, else the last earlier one that did.
function changeOf(steps: readonly PlanItem[], at: number, currency: string): Copy | null {
  const now = (steps[at] as PlanItem).amount_minor
  const next = steps.slice(at + 1).find((s) => s.amount_minor !== now)
  if (next) return [textPart('Changes to '), moneyPart(next.amount_minor, currency), textPart(' from '), { month: monthKey(next.starts_on) }]
  for (let k = at - 1; k >= 0; k--) {
    const before = steps[k] as PlanItem
    if (before.amount_minor !== now) return [textPart('Changed from '), moneyPart(before.amount_minor, currency), textPart(' in '), { month: monthKey((steps[k + 1] as PlanItem).starts_on) }]
  }
  return null
}

// 'Earlier: €1,098.00 from October 2026 to December 2026'; a step with a later one always has an end.
function earlierOf(steps: readonly PlanItem[], at: number, currency: string): Copy | null {
  if (at === 0) return null
  const parts: CopyPart[] = [textPart('Earlier: ')]
  steps.slice(0, at).forEach((s, i) => {
    const first = monthKey(s.starts_on)
    const last = monthKey(s.ends_on ?? s.starts_on)
    if (i > 0) parts.push(textPart('; '))
    parts.push(moneyPart(s.amount_minor, currency), ...(first === last ? [textPart(' in '), { month: first }] : [textPart(' from '), { month: first }, textPart(' to '), { month: last }]))
  })
  return parts
}

// The first day money moves on or after today, else the last day it moved before today; a skipped period moves nothing.
function dayOn(steps: readonly PlanItem[], cutDay: number | null, asOf: string): string {
  const end = horizonEnd(asOf)
  for (const s of steps) {
    const next = itemSchedule(s, cutDay, asOf, end).find(([period]) => !s.skip_periods.includes(period))
    if (next) return next[1]
  }
  const before = addDays(asOf, -1)
  for (const s of [...steps].reverse()) {
    const last = itemSchedule(s, cutDay, s.starts_on, before)
      .filter(([period]) => !s.skip_periods.includes(period))
      .at(-1)
    if (last) return last[1]
  }
  return (steps[0] as PlanItem).starts_on
}

// The account an item's amount is counted on: income and a transfer into a debt in the account receiving it, everything else in the account it leaves (core's occurrences).
function countedOn(item: PlanItem): string | null {
  if (item.kind === 'income' || (item.kind === 'transfer' && item.from_account_id === null)) return item.to_account_id
  return item.from_account_id
}

function routeOf(item: PlanItem, accounts: ReadonlyMap<string, Account>, categoryName: string | null): Copy {
  const account = (id: string): CopyPart => ({ account: id })
  const on = (id: string | null): Copy => (id === null ? [] : [textPart(accounts.get(id)?.kind === 'cash' ? 'from ' : 'on '), account(id)])
  const from = item.from_account_id
  const to = item.to_account_id
  switch (item.kind) {
    case 'income':
      return to === null ? [] : [textPart('into '), account(to)]
    case 'transfer': {
      if (to === null) return from === null ? [] : [account(from), textPart(' → debts, in payoff order')]
      // A transfer into a debt is paid from the debt's funded-from account, which it follows when that changes.
      const payer = from ?? (accounts.get(to)?.kind !== 'cash' ? accounts.get(to)?.funded_from_account_id : null) ?? null
      return payer === null ? [textPart('into '), account(to)] : [account(payer), textPart(' → '), account(to)]
    }
    case 'allowance':
      return categoryName !== null && categoryName !== item.name ? [...on(from), textPart(' · '), { category: item.category_id ?? '' }] : on(from)
    default:
      return on(from)
  }
}

const monthsBetween = (first: string, last: string) => monthIndex(last) - monthIndex(first) + 1

// One row per item, a stepped series as one: its group, current amount, accounts, chips, steps and, for an installment, n of N from the walk's card replays.
export function itemRows(snapshot: Snapshot, walk: Walk): ItemRow[] {
  const index = snapshotIndex(snapshot)
  const asOf = snapshot.as_of
  const progress = new Map<string, { billed: number; total: number }>()
  for (const a of snapshot.doc.accounts) {
    if (a.kind !== 'credit_card' || !snapshot.doc.plan_items.some((p) => p.kind === 'installment' && p.from_account_id === a.id)) continue
    for (const p of installmentProgress(snapshot, walk, a.id)) progress.set(p.plan_item_id, { billed: p.billed, total: p.total })
  }
  const base = snapshot.doc.household.base_currency
  const categories = new Map(snapshot.doc.categories.map((c) => [c.id, c.name]))
  return itemSeries(snapshot.doc.plan_items).map((steps) => {
    const live = steps.findIndex((s) => !ended(s, asOf))
    const at = live === -1 ? steps.length - 1 : live
    const item = steps[at] as PlanItem
    const done = live === -1
    const group: ItemGroup = done ? 'past' : item.confidence === 'upside' ? 'upsides' : GROUP_OF_KIND[item.kind]
    const counted = countedOn(item)
    const account = counted === null ? undefined : index.accounts.get(counted)
    const currency = account?.currency ?? base
    const category = item.category_id === null ? null : (categories.get(item.category_id) ?? null)
    const chips: ItemChip[] = []
    if (item.confidence === 'estimated') chips.push('Estimated')
    if (item.confidence === 'upside') chips.push('Upside')
    let billed: { billed: number; total: number } | null = null
    if (item.kind === 'installment' && item.ends_on !== null) {
      const total = monthsBetween(item.starts_on, item.ends_on)
      // An installment the card replay no longer lists has billed every month.
      billed = progress.get(item.id) ?? { billed: done ? total : 0, total }
    }
    // An installment bills at its card's cut, as the engine dates it.
    const cutDay = item.kind === 'installment' && account?.kind === 'credit_card' ? account.terms.cut_day : null
    return {
      item,
      steps,
      group,
      amount: { minor: item.amount_minor, currency },
      route: routeOf(item, index.accounts, category),
      chips,
      progress: billed,
      ends_on: (steps.at(-1) as PlanItem).ends_on,
      change: changeOf(steps, at, currency),
      earlier: earlierOf(steps, at, currency),
      on: dayOn(steps, cutDay, asOf),
      link: { pathname: '/plan/item/[id]', params: { id: item.id } },
    }
  })
}

export type PlanListItem =
  | { type: 'group'; key: string; group: ItemGroup; count: number }
  // Past, closed until the person opens it.
  | { type: 'past'; key: string; count: number; open: boolean }
  | { type: 'item'; key: string; row: ItemRow; first: boolean; last: boolean }

// The rows in ITEM_GROUPS order, each group headed with its count and sorted by next date; Past lists the latest first, and only when open.
export function planList(rows: readonly ItemRow[], locale: string, pastOpen = false): PlanListItem[] {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true })
  const byName = (a: ItemRow, b: ItemRow) => collator.compare(a.item.name, b.item.name) || byText(a.item.id, b.item.id)
  const out: PlanListItem[] = []
  for (const group of ITEM_GROUPS) {
    const past = group === 'past'
    const members = rows.filter((r) => r.group === group).sort((a, b) => (past ? byText(b.on, a.on) : byText(a.on, b.on)) || byName(a, b))
    if (members.length === 0) continue
    if (past) out.push({ type: 'past', key: 'group:past', count: members.length, open: pastOpen })
    else out.push({ type: 'group', key: `group:${group}`, group, count: members.length })
    if (past && !pastOpen) continue
    members.forEach((row, i) => out.push({ type: 'item', key: `item:${row.item.id}`, row, first: i === 0, last: i === members.length - 1 }))
  }
  return out
}

const dayOf = (day: string, locale: string, asOf: string) =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: day.slice(0, 4) === asOf.slice(0, 4) ? undefined : 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))

const monthOf = (day: string, locale: string) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day.slice(0, 7)}-01T00:00:00Z`))

const weekdayOf = (day: string, locale: string) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))

// The four months a quarterly item falls in, in calendar order: 'Jan, Apr, Jul and Oct'.
function quarterMonths(start: string, locale: string): string {
  const first = Number(start.slice(5, 7)) - 1
  const names = [0, 3, 6, 9].map((k) => (first + k) % 12).sort((a, b) => a - b).map((m) => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, m, 1))))
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
}

// The app's copy is English, so day numbers take English ordinals in any locale: 1st, 2nd, 3rd, 11th, 22nd.
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

// A step's months: 'October 2026 to December 2026', 'From January 2029', or its one month.
export function stepMonths(step: PlanItem, locale: string): string {
  const first = monthOf(step.starts_on, locale)
  if (step.every !== 'once' && step.ends_on === null) return `From ${first}`
  const last = monthOf(step.ends_on ?? step.starts_on, locale)
  return first === last ? first : `${first} to ${last}`
}

const weekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())

const ROLL_WORDS = { none: '', following: ', or the Monday after a weekend', preceding: ', or the Friday before a weekend' } as const

// When an item's money moves, in words: 'Monthly on the 25th, or the Friday before a weekend, until 30 Jun 2027', or 'Every 3 months on the 15th of Jan, Apr, Jul and Oct'.
export function scheduleWords(item: PlanItem, asOf: string, locale: string): string {
  const roll = ROLL_WORDS[item.roll]
  const start = item.starts_on
  if (item.kind === 'installment') return item.ends_on === null ? 'Monthly' : `Monthly, ${monthOf(start, locale)} to ${monthOf(item.ends_on, locale)}`
  if (item.every === 'once') return `Once on ${dayOf(start, locale, asOf)}${roll}`
  const day = Number(start.slice(8, 10))
  let when: string
  if (item.kind === 'allowance') when = EVERY_WORDS[item.every]
  // A weekday never rolls, so only a weekend day says where it moves.
  else if (item.every === 'week' || item.every === '2weeks') when = `${EVERY_WORDS[item.every]} on ${weekdayOf(start, locale)}${weekend(start) ? roll : ''}`
  else if (item.every === 'year') when = `${EVERY_WORDS.year} on ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${start}T00:00:00Z`))}${roll}`
  // Counting from the start keeps a 29th to 31st on the last day of shorter months (core itemSchedule).
  else if (item.every === 'quarter') when = `${EVERY_WORDS.quarter} on the ${ordinal(day)} of ${quarterMonths(start, locale)}${day > 28 ? ', or the month’s last day' : ''}${roll}`
  else when = `${EVERY_WORDS.month} on the ${ordinal(day)}${day > 28 ? ' or the month’s last day' : ''}${roll}`
  const bounds: string[] = []
  if (start > asOf) bounds.push(`from ${dayOf(start, locale, asOf)}`)
  if (item.ends_on !== null) bounds.push(`${item.ends_on < asOf ? 'ended' : 'until'} ${dayOf(item.ends_on, locale, asOf)}`)
  return [when, ...bounds].join(', ')
}
