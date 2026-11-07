import {
  addMonths,
  addOnInstallment,
  BREAKEVEN_LOWEST,
  canonical,
  firstOfMonth,
  floorAndTarget,
  fundingCurrency,
  horizonEnd,
  lastDayOfMonth,
  minorDigits,
  monthKey,
  parseAmount,
  snapshotIndex,
  textPart,
  type Account,
  type CompareResult,
  type CompareRow,
  type Copy,
  type CopyPart,
  type FloorWindow,
  type ItemLevers,
  type Lever,
  type LeverRegistry,
  type PlanItem,
  type RowRole,
  type Snapshot,
  type SortMetric,
} from '@waypoint/core'
import {
  amountLever,
  dayLever,
  decodeLevers,
  encodeLevers,
  endLever,
  extraPaymentLever,
  floorWindowLever,
  fxShiftLever,
  incomeGapLever,
  LINK_MAX_LEVERS,
  loanOfferLever,
  removeLever,
  sortRows,
  upsideLever,
} from '@waypoint/core/compare'
import { amountText } from '../../data/field-text'
import { SIDEBAR_MIN_WIDTH } from '../../shell/shell.model'
import { headline } from '../debts/debts.model'

// Spec §7 Compare: the baseline beside each lever and all of them together, measured by core compare(). Phone cards list only the figures a change moves, sorted by one picked figure; from 1,024 px a table shows every figure. Each figure and change is core's; nothing here measures again.

// The table takes over where the sidebar does.
export const TABLE_MIN_WIDTH = SIDEBAR_MIN_WIDTH

// The figures Compare shows (spec §6.8); a lowest-balance column per open cash account.
export type Metric = Exclude<SortMetric, 'months_under_target'>

export interface Column {
  // 'lowest:<account id>' for a lowest balance, else the metric.
  id: string
  metric: Metric
  account_id: string | null
  // The figure's name in a card and on the sort picker.
  title: string
  // The table's column heading.
  short: string
}

const bySortOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The columns this household has: FX margin only with two currencies, debt-free month and interest only with a card or loan.
export function columnsOf(snapshot: Snapshot): Column[] {
  const live = snapshot.doc.accounts.filter((a) => a.archived_at === null)
  const cash = live.filter((a) => a.kind === 'cash').sort(bySortOrder)
  const debts = live.some((a) => a.kind !== 'cash')
  return [
    { id: 'net_worth', metric: 'net_worth', account_id: null, title: 'Net worth', short: 'Net worth' },
    ...cash.map((a): Column => ({ id: `lowest:${a.id}`, metric: 'lowest', account_id: a.id, title: `Lowest balance in ${a.name}`, short: `Lowest in ${a.name}` })),
    { id: 'days_under_floor', metric: 'days_under_floor', account_id: null, title: 'Days under a floor', short: 'Days under floor' },
    ...(fundingCurrency(snapshot) === null ? [] : [{ id: 'fx_margin', metric: 'fx_margin', account_id: null, title: 'FX margin', short: 'FX margin' } satisfies Column]),
    ...(debts
      ? [{ id: 'debt_free_month', metric: 'debt_free_month', account_id: null, title: 'Debt-free', short: 'Debt-free' } satisfies Column, { id: 'interest', metric: 'interest', account_id: null, title: 'Interest', short: 'Interest' } satisfies Column]
      : []),
  ]
}

// The sort picker reads the columns; change in net worth first (core sortRows' default).
export const DEFAULT_SORT = 'net_worth'

export function sortColumn(columns: readonly Column[], id: string): Column {
  const found = columns.find((c) => c.id === id) ?? columns[0]
  if (!found) throw new RangeError('A household always has the net worth column')
  return found
}

export type Value = { kind: 'money'; minor: number; currency: string } | { kind: 'days'; n: number } | { kind: 'percent'; fraction: number; or_more: boolean } | { kind: 'copy'; copy: Copy } | { kind: 'unknown' }

// A change from the baseline, signed: a later debt-free month is a positive number of months.
export type Change = { kind: 'money'; minor: number; currency: string } | { kind: 'days'; n: number } | { kind: 'points'; fraction: number } | { kind: 'months'; n: number } | { kind: 'text'; text: string }

export interface Cell {
  column: string
  value: Value
  // null on the baseline and on a figure the change leaves as it was.
  change: Change | null
  moved: boolean
  // Whether the move helps, so a minus on interest reads as good: null where it moved neither way, such as a month that changed.
  verdict: Verdict | null
}

export type Verdict = 'Better' | 'Worse'

// A rise is better for net worth, a lowest balance and the FX margin; a fall is better for days under the floor, interest and the debt-free month.
const RISE_IS_BETTER = { net_worth: true, lowest: true, fx_margin: true, days_under_floor: false, interest: false, debt_free_month: false } as const

const TEXT_VERDICT: Record<string, Verdict | null> = { 'Debt-free now': 'Better', 'Was after the projection': 'Better', 'Now after the projection': 'Worse', Changed: null }

export function verdictOf(metric: keyof typeof RISE_IS_BETTER, change: Change | null): Verdict | null {
  if (change === null) return null
  if (change.kind === 'text') return TEXT_VERDICT[change.text] ?? null
  const n = change.kind === 'money' ? change.minor : change.kind === 'points' ? change.fraction : change.n
  if (n === 0) return null
  return n > 0 === RISE_IS_BETTER[metric] ? 'Better' : 'Worse'
}

const money = (t: { minor: number; currency: string } | null): Value => (t === null ? { kind: 'unknown' } : { kind: 'money', minor: t.minor, currency: t.currency })

// The breakeven search stops at half today's rate, so a margin there means that much or more; a world already shifted measures it from its own rate.
const marginCap = (shift: number) => Math.round((1 - BREAKEVEN_LOWEST / 1000 / (1 + shift)) * 1000) / 1000

// A debt-free month that moves to or from past the projection has no number of months to give.
function debtFreeChange(row: CompareRow, base: CompareRow): Change {
  if (row.delta_debt_free_months !== null) return { kind: 'months', n: row.delta_debt_free_months }
  if (row.debt_free_after_horizon) return { kind: 'text', text: 'Now after the projection' }
  if (row.debt_free_month === null) return { kind: 'text', text: 'Debt-free now' }
  return base.debt_free_after_horizon ? { kind: 'text', text: 'Was after the projection' } : { kind: 'text', text: 'Changed' }
}

// One option's figures in column order, each with its change from the baseline when it moved, and whether that helps.
export function cellsOf(columns: readonly Column[], row: CompareRow, base: CompareRow, horizonMonth: string): Cell[] {
  return columns.map((c) => {
    const cell = cellOf(c, row, base, horizonMonth)
    return { ...cell, verdict: verdictOf(c.metric, cell.change) }
  })
}

function cellOf(c: Column, row: CompareRow, base: CompareRow, horizonMonth: string): Omit<Cell, 'verdict'> {
  const lever = row.role !== 'baseline'
  switch (c.metric) {
    case 'net_worth': {
      const moved = lever && row.moved.net_worth
      return { column: c.id, value: money(row.net_worth), change: moved && row.delta_net_worth ? { kind: 'money', minor: row.delta_net_worth.minor, currency: row.delta_net_worth.currency } : null, moved }
    }
    case 'lowest': {
      const l = row.lowest_by_account.find((x) => x.account_id === c.account_id)
      const moved = lever && l !== undefined && l.delta_minor !== 0
      return { column: c.id, value: l ? { kind: 'money', minor: l.lowest_minor, currency: l.currency } : { kind: 'unknown' }, change: moved && l ? { kind: 'money', minor: l.delta_minor, currency: l.currency } : null, moved }
    }
    case 'days_under_floor': {
      const moved = lever && row.delta_days_under_floor !== 0
      return { column: c.id, value: { kind: 'days', n: row.days_under_floor }, change: moved ? { kind: 'days', n: row.delta_days_under_floor } : null, moved }
    }
    case 'fx_margin': {
      const moved = lever && row.moved.fx_margin
      return { column: c.id, value: row.fx_margin === null ? { kind: 'unknown' } : { kind: 'percent', fraction: row.fx_margin, or_more: row.fx_margin >= marginCap(row.patch.fx_shift_pct ?? 0) }, change: moved && row.delta_fx_margin !== null ? { kind: 'points', fraction: row.delta_fx_margin } : null, moved }
    }
    case 'debt_free_month': {
      const moved = lever && row.moved.debt_free_month
      const value: Value = { kind: 'copy', copy: headline({ month: row.debt_free_month, last_owed_month: null, after_horizon: row.debt_free_after_horizon }, horizonMonth).value }
      return { column: c.id, value, change: moved ? debtFreeChange(row, base) : null, moved }
    }
    case 'interest': {
      const moved = lever && row.moved.interest
      return { column: c.id, value: money(row.interest_total), change: moved && row.delta_interest_total ? { kind: 'money', minor: row.delta_interest_total.minor, currency: row.delta_interest_total.currency } : null, moved }
    }
  }
}

export interface OptionRow {
  key: string
  role: RowRole
  title: Copy
  // A title read from a link in a shape Compare does not know; its amounts are plain text, so the eye hides its digits.
  opaque: boolean
  // The lever's place in the link, for Remove; null on the baseline and all together.
  lever: number | null
  // The change's place among the changes as listed, which Remove's name gives so it reads in screen order.
  place: number | null
  // Who the Remove button names.
  name: string
  state: 'ready' | 'measuring' | 'failed'
  errors: readonly string[]
  cells: readonly Cell[]
}

export interface CompareView {
  columns: readonly Column[]
  sort: Column
  horizon_month: string
  // Baseline first, then the measured options best first by the sort column, failures after them, and options still measuring last in link order.
  rows: readonly OptionRow[]
  done: boolean
}

// A change in core compare's order: the baseline, each lever, then all together with two or more.
export interface Slot {
  role: RowRole
  lever: number | null
}

export function slotsOf(count: number): Slot[] {
  return [{ role: 'baseline', lever: null }, ...Array.from({ length: count }, (_, i): Slot => ({ role: 'lever', lever: i })), ...(count >= 2 ? [{ role: 'together', lever: null } satisfies Slot] : [])]
}

function titleOf(snapshot: Snapshot, slot: Slot, levers: readonly Lever[], locale: string): { title: Copy; opaque: boolean; name: string } {
  if (slot.role === 'baseline') return { title: [textPart('Baseline')], opaque: false, name: 'Baseline' }
  if (slot.role === 'together') return { title: [textPart('All together')], opaque: false, name: 'All together' }
  const lever = levers[slot.lever ?? -1]
  if (!lever) return { title: [], opaque: false, name: '' }
  const described = leverCopy(snapshot, lever, locale)
  return described ? { title: described.copy, opaque: false, name: described.name } : { title: [textPart(lever.label)], opaque: true, name: `change ${(slot.lever ?? 0) + 1}` }
}

// Compare's screen from the rows measured so far (null while a slot is still measuring), in slotsOf order.
export function compareView(snapshot: Snapshot, levers: readonly Lever[], results: readonly (CompareResult | null)[], sortId: string, locale: string): CompareView {
  const columns = columnsOf(snapshot)
  const sort = sortColumn(columns, sortId)
  const horizonMonth = monthKey(horizonEnd(snapshot.as_of))
  const slots = slotsOf(levers.length)
  const base = results[0]?.ok ? results[0] : null
  const rowOf = (slot: Slot, i: number): Omit<OptionRow, 'place'> => {
    const result = results[i] ?? null
    const head = titleOf(snapshot, slot, levers, locale)
    const key = slot.role === 'lever' ? `lever:${slot.lever}` : slot.role
    if (result === null) return { key, role: slot.role, ...head, lever: slot.lever, state: 'measuring', errors: [], cells: [] }
    if (!result.ok) return { key, role: slot.role, ...head, lever: slot.lever, state: 'failed', errors: result.errors, cells: [] }
    return { key, role: slot.role, ...head, lever: slot.lever, state: 'ready', errors: [], cells: base ? cellsOf(columns, result, base, horizonMonth) : [] }
  }
  const measured = slots.flatMap((slot, i) => {
    const result = results[i]
    return result ? [{ result, row: rowOf(slot, i) }] : []
  })
  // Back to its own slot, each slot once: two identical levers can share one memoised result object.
  const used = new Set<number>()
  const sorted = sortRows(
    measured.map((m) => m.result),
    sort.metric,
    sort.account_id ?? undefined,
  ).map((r) => {
    const at = measured.findIndex((m, i) => m.result === r && !used.has(i))
    used.add(at)
    return measured[at]?.row
  })
  const pending = slots.flatMap((slot, i) => (results[i] ? [] : [rowOf(slot, i)]))
  let place = 0
  const rows = [...sorted.flatMap((r) => (r ? [r] : [])), ...pending].map((r) => ({ ...r, place: r.lever === null ? null : ++place }))
  return { columns, sort, horizon_month: horizonMonth, rows, done: pending.length === 0 }
}

// Character counts for the table's column widths: an estimate that holds for Instrument Sans and the platform fonts (layout only; no figure is ever clipped to it).
const CHAR_EM = 0.58
const VALUE_SIZE = 15
const HEAD_SIZE = 13
export const TABLE_CELL_PAD = 12
// The names wrap down to this width before the table scrolls sideways; at 1,280 px eight figures fit beside them.
export const TABLE_LABEL_MIN = 200
const COLUMN_MIN = 72

function moneyChars(minor: number, currency: string, locale: string): number {
  const digits = minorDigits(currency)
  const number = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(minor) / 10 ** digits)
  // A sign, and a symbol or a short code.
  return number.length + 3
}

function valueChars(value: Value, locale: string): number {
  switch (value.kind) {
    case 'money':
      return moneyChars(value.minor, value.currency, locale)
    case 'days':
      return String(value.n).length + 5
    case 'percent':
      return value.or_more ? 15 : 7
    case 'copy':
      return 14
    case 'unknown':
      return 9
  }
}

function changeChars(change: Change, locale: string): number {
  switch (change.kind) {
    case 'money':
      return moneyChars(change.minor, change.currency, locale)
    case 'days':
      return String(Math.abs(change.n)).length + 6
    case 'points':
      return 12
    case 'months':
      return String(Math.abs(change.n)).length + 14
    case 'text':
      return 14
  }
}

// Each figure column wide enough for its widest value or change, and for the longest word of its heading.
export function columnWidths(view: CompareView, locale: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const column of view.columns) {
    let chars = 0
    for (const row of view.rows) {
      const cell = row.cells.find((c) => c.column === column.id)
      if (!cell) continue
      chars = Math.max(chars, valueChars(cell.value, locale), cell.change ? changeChars(cell.change, locale) : 0)
    }
    const word = Math.max(...column.short.split(' ').map((w) => w.length))
    out[column.id] = Math.max(COLUMN_MIN, Math.ceil(chars * VALUE_SIZE * CHAR_EM), Math.ceil(word * HEAD_SIZE * CHAR_EM)) + 2 * TABLE_CELL_PAD
  }
  return out
}

// A phone card: the baseline lists every figure, an option only those that moved.
export function cardCells(row: OptionRow): readonly Cell[] {
  return row.role === 'baseline' ? row.cells : row.cells.filter((c) => c.moved)
}

const dayFormats = new Map<string, Intl.DateTimeFormat>()

function dayWithYear(day: string, locale: string): string {
  let format = dayFormats.get(locale)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    dayFormats.set(locale, format)
  }
  return format.format(new Date(`${day}T00:00:00Z`))
}

const pct = (fraction: number, locale: string) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 3 }).format(fraction)

const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7))

const onlyKeys = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((k) => k in value)

// A lever's words with each amount as a money part, so the eye masks it, read from what its patch does rather than its label; null for a patch in a shape the picker does not make.
export function leverCopy(snapshot: Snapshot, lever: Lever, locale: string): { copy: Copy; name: string } | null {
  const index = snapshotIndex(snapshot)
  const p = lever.patch
  const parts = Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined)
  if (parts.length !== 1) return null
  const currencyOf = (id: string | null) => (id === null ? undefined : index.accounts.get(id)?.currency)
  const itemCurrency = (item: PlanItem) => currencyOf(item.from_account_id ?? item.to_account_id)
  const accountName = (id: string) => index.accounts.get(id)?.name
  if (p.fx_shift_pct !== undefined) {
    const funding = fundingCurrency(snapshot)
    if (funding === null) return null
    // The code never sits beside a figure, so the words never read as an amount the eye would hide.
    return { copy: [textPart(`${funding} ${p.fx_shift_pct < 0 ? 'weaker' : 'stronger'} by ${pct(Math.abs(p.fx_shift_pct), locale)}`)], name: `${funding} rate` }
  }
  if (p.items) {
    const entries = Object.entries(p.items)
    const [id, change] = entries[0] ?? []
    const item = id === undefined ? undefined : index.planItems.get(id)
    if (entries.length !== 1 || !item || !change || id === undefined) return null
    const name = item.name
    if (onlyKeys(change, ['removed']) && change.removed === true) return { copy: [textPart('Remove '), { item: id }], name }
    if (onlyKeys(change, ['include_upside']) && change.include_upside === true) return { copy: [textPart('Include '), { item: id }], name }
    if (onlyKeys(change, ['ends_on']) && change.ends_on !== undefined) return { copy: [{ item: id }, textPart(change.ends_on === null ? ': no end date' : `: ends ${dayWithYear(change.ends_on, locale)}`)], name }
    const currency = itemCurrency(item)
    if (onlyKeys(change, ['amount_minor', 'from_month']) && change.amount_minor !== undefined && change.from_month && currency) {
      return { copy: [{ item: id }, textPart(': '), { money: { minor: change.amount_minor, currency } }, textPart(' from '), { month: change.from_month }], name }
    }
    if (onlyKeys(change, ['day', 'from_month']) && change.day !== undefined && change.from_month) return { copy: [{ item: id }, textPart(`: day ${change.day} from `), { month: change.from_month }], name }
    return null
  }
  if (p.add) {
    const [first, second, ...rest] = p.add
    if (!first || rest.length > 0) return null
    const firstCurrency = itemCurrency(first)
    if (!second && first.kind === 'transfer' && first.id.startsWith('extra-') && firstCurrency) {
      const head: CopyPart[] = first.to_account_id === null ? [textPart('Extra for debts from '), { account: first.from_account_id ?? '' }] : [textPart('Extra into '), { account: first.to_account_id }]
      const when: CopyPart[] = first.every === 'once' ? [textPart(` on ${dayWithYear(first.starts_on, locale)}`)] : [textPart(' a month from '), { month: monthKey(first.starts_on) }]
      return { copy: [...head, textPart(': '), { money: { minor: first.amount_minor, currency: firstCurrency } }, ...when], name: first.to_account_id === null ? 'Extra for debts' : `Extra into ${accountName(first.to_account_id) ?? ''}` }
    }
    const offer = first.id.endsWith('-draw') && second?.id === `${first.id.slice(0, -5)}-emi`
    if (offer && second && second.kind === 'installment' && first.to_account_id && second.from_account_id && second.ends_on && firstCurrency) {
      const months = monthsBetween(second.starts_on, second.ends_on) + 1
      return {
        copy: [
          textPart('Loan offer '),
          { money: { minor: first.amount_minor, currency: firstCurrency } },
          textPart(' into '),
          { account: first.to_account_id },
          textPart(` on ${dayWithYear(first.starts_on, locale)}, then `),
          { money: { minor: second.amount_minor, currency: firstCurrency } },
          textPart(` a month for ${months} month${months === 1 ? '' : 's'} on `),
          { account: second.from_account_id },
        ],
        name: 'Loan offer',
      }
    }
    return null
  }
  if (p.income_gap) {
    const { from_month, months, item_ids } = p.income_gap
    const named = item_ids?.map((id) => index.planItems.get(id)?.name)
    if (named?.some((n) => n === undefined)) return null
    const who = named ? named.join(' and ') : 'Income'
    return { copy: [textPart(`${who} stops for ${months} month${months === 1 ? '' : 's'} from `), { month: from_month }], name: 'Income stops' }
  }
  if (p.accounts) {
    const entries = Object.entries(p.accounts)
    const [id, change] = entries[0] ?? []
    const currency = id === undefined ? undefined : currencyOf(id)
    if (entries.length !== 1 || id === undefined || !change || !currency) return null
    const windows: CopyPart[] = change.floor_windows.flatMap((w, i) => [
      ...(i > 0 ? [textPart(', ')] : []),
      { money: { minor: w.amount_minor, currency } },
      textPart(' from '),
      { month: w.from_month },
      ...(w.to_month === null ? [] : [textPart(' to '), { month: w.to_month }]),
    ])
    return { copy: [{ account: id }, textPart(' floor: '), ...(windows.length > 0 ? windows : [textPart('none')])], name: `${accountName(id) ?? ''} floor` }
  }
  return null
}

// The levers in the address after '#l=', or a named problem; no fragment is no levers.
export type LinkLevers = { ok: true; levers: readonly Lever[] } | { ok: false; errors: readonly string[] }

export function leversOf(fragment: string | null): LinkLevers {
  if (fragment === null) return { ok: true, levers: [] }
  const decoded = decodeLevers(fragment)
  return decoded.ok ? { ok: true, levers: decoded.value } : { ok: false, errors: decoded.errors }
}

// What follows '#' for these levers; undefined with none, so the address loses its fragment.
export function fragmentOf(levers: readonly Lever[]): string | undefined {
  return levers.length === 0 ? undefined : `l=${encodeLevers(levers)}`
}

// The link Copy link gives: Compare's address (`page`) with the levers after '#', and the sample when one is open, so the link opens the same household.
export function compareLink(page: string, sample: string | null, levers: readonly Lever[]): string {
  const fragment = fragmentOf(levers)
  return `${page}${sample === null ? '' : `?sample=${encodeURIComponent(sample)}`}${fragment === undefined ? '' : `#${fragment}`}`
}

// A link holds at most this many, so a shared address never asks for an unbounded run of walks.
export const MAX_LEVERS = LINK_MAX_LEVERS

export const sameLever = (a: Lever, b: Lever) => canonical(a.patch) === canonical(b.patch)

// The picker (spec §7): each kind of change Compare can try, from core's lever registry.
export const LEVER_KINDS = ['amount', 'day', 'end', 'remove', 'upside', 'extra', 'offer', 'fx', 'gap', 'floor'] as const
export type LeverKind = (typeof LEVER_KINDS)[number]

export const KIND_WORDS: Record<LeverKind, { title: string; detail: string }> = {
  amount: { title: 'Change an amount', detail: 'From a month on, such as a rent rise.' },
  day: { title: 'Move a day', detail: 'From a month on, such as a payday moving to the 20th.' },
  end: { title: 'End an item', detail: 'Its last month, such as a subscription you cancel.' },
  remove: { title: 'Remove an item', detail: 'As if it were not in the plan.' },
  upside: { title: 'Count an upside', detail: 'Money you hope for, counted as expected.' },
  extra: { title: 'Pay extra toward debts', detail: 'Once, or every month.' },
  offer: { title: 'Try a loan offer', detail: 'A draw now, paid back in monthly installments on a card.' },
  fx: { title: 'Shift the exchange rate', detail: 'Your income’s currency weaker or stronger than today.' },
  gap: { title: 'Stop income', detail: 'No income for a number of months.' },
  floor: { title: 'Change a floor', detail: 'The lowest balance an account keeps, from a month.' },
}

const ITEM_LEVER: Partial<Record<LeverKind, ItemLevers['levers'][number]>> = { amount: 'amount', day: 'day', end: 'end', remove: 'remove', upside: 'include_upside' }

export function itemsFor(reg: LeverRegistry, kind: LeverKind): ItemLevers[] {
  const lever = ITEM_LEVER[kind]
  return lever === undefined ? [] : reg.items.filter((i) => i.levers.includes(lever))
}

// Kinds this household can try, in LEVER_KINDS order.
export function leverKinds(reg: LeverRegistry): LeverKind[] {
  return LEVER_KINDS.filter((k) => {
    if (ITEM_LEVER[k] !== undefined) return itemsFor(reg, k).length > 0
    if (k === 'extra') return reg.extra_payment !== null && reg.extra_payment.from_account_ids.length + reg.extra_payment.debt_ids.length > 0
    if (k === 'offer') return reg.loan_offer !== null
    if (k === 'fx') return reg.fx_shift !== null
    if (k === 'gap') return reg.income_gap !== null
    return reg.floor_windows.length > 0
  })
}

const KIND_GROUPS: readonly { kind: PlanItem['kind']; title: string }[] = [
  { kind: 'income', title: 'Income' },
  { kind: 'bill', title: 'Bills' },
  { kind: 'allowance', title: 'Budgets' },
  { kind: 'transfer', title: 'Transfers' },
  { kind: 'installment', title: 'Installments' },
]

// The items a kind of change can pick, grouped by kind and sorted by name.
export function itemGroups(reg: LeverRegistry, kind: LeverKind, locale: string): { title: string; items: ItemLevers[] }[] {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true })
  const items = itemsFor(reg, kind)
  return KIND_GROUPS.flatMap((g) => {
    const members = items.filter((i) => i.kind === g.kind).sort((a, b) => collator.compare(a.name, b.name) || (a.item_id < b.item_id ? -1 : 1))
    return members.length === 0 ? [] : [{ title: g.title, items: members }]
  })
}

export interface LeverDraft {
  kind: LeverKind
  // The plan item for amount, day, end, remove and upside.
  item: string | null
  amount: string
  day: string
  // From this month (amount, day, extra, gap, floor), the last month (end), or the draw month (offer).
  month: string
  // A floor's last month; null runs on with no end.
  to_month: string | null
  every: 'once' | 'month'
  // Extra for debts from a cash account ('from:<id>'), or into one debt ('to:<id>').
  target: string | null
  card: string | null
  to: string | null
  term: string
  // Percent a month, as typed.
  rate: string
  emi: string
  // The installment was typed, so it no longer follows the formula.
  emi_typed: boolean
  direction: 'weaker' | 'stronger'
  percent: string
  // One income item to stop, or null for all of them.
  income: string | null
  months: string
  account: string | null
}

export type DraftField = 'form' | 'item' | 'amount' | 'day' | 'month' | 'to_month' | 'target' | 'card' | 'to' | 'term' | 'rate' | 'emi' | 'percent' | 'months' | 'account'

export interface MonthRange {
  min: string
  max: string
}

export function horizonMonth(snapshot: Snapshot): string {
  return monthKey(horizonEnd(snapshot.as_of))
}

const nextMonth = (snapshot: Snapshot) => monthKey(addMonths(firstOfMonth(snapshot.as_of), 1))

const later = (a: string, b: string) => (a > b ? a : b)

const itemOf = (reg: LeverRegistry, id: string | null) => reg.items.find((i) => i.item_id === id)

// The months the draft's month can take, and whether it can move at all (an item that happens once changes in its own month).
export function monthRange(snapshot: Snapshot, reg: LeverRegistry, draft: LeverDraft): MonthRange {
  const thisMonth = monthKey(snapshot.as_of)
  const last = horizonMonth(snapshot)
  const item = itemOf(reg, draft.item)
  if (item && (draft.kind === 'amount' || draft.kind === 'day')) return item.every === 'once' ? { min: item.first_month, max: item.first_month } : { min: item.first_month, max: later(last, item.first_month) }
  if (item && draft.kind === 'end') return { min: item.first_month, max: later(last, item.first_month) }
  return { min: thisMonth, max: last }
}

const clampMonth = (month: string, range: MonthRange) => (month < range.min ? range.min : month > range.max ? range.max : month)

// The amount's currency: the item's, the account's the extra leaves or the debt's it goes into, the lending card's, or the floor's account.
export function draftCurrency(snapshot: Snapshot, reg: LeverRegistry, draft: LeverDraft): string | null {
  const index = snapshotIndex(snapshot)
  if (draft.kind === 'extra') return draft.target === null ? null : (index.accounts.get(draft.target.slice(draft.target.indexOf(':') + 1))?.currency ?? null)
  if (draft.kind === 'offer') return draft.card === null ? null : (index.accounts.get(draft.card)?.currency ?? null)
  if (draft.kind === 'floor') return draft.account === null ? null : (index.accounts.get(draft.account)?.currency ?? null)
  return itemOf(reg, draft.item)?.currency ?? null
}

// Where a loan offer's draw can land: the lending card's own currency only, cash accounts first.
export function offerTargets(snapshot: Snapshot, reg: LeverRegistry, cardId: string | null): Account[] {
  const index = snapshotIndex(snapshot)
  const card = cardId === null ? undefined : index.accounts.get(cardId)
  if (!card || !reg.loan_offer) return []
  const all = reg.loan_offer.to_account_ids.flatMap((id) => index.accounts.get(id) ?? []).filter((a) => a.currency === card.currency)
  return [...all.filter((a) => a.kind === 'cash'), ...all.filter((a) => a.kind !== 'cash')]
}

// A cash account's floor from `month`: the floor the plan holds then, as a prefill.
export function floorIn(snapshot: Snapshot, accountId: string | null, month: string): number {
  const account = accountId === null ? undefined : snapshotIndex(snapshot).accounts.get(accountId)
  return account && account.kind === 'cash' ? floorAndTarget(account.floor_windows, month).floor : 0
}

// The amount and day fields follow the picked item, so they start from what the plan holds.
export function pickItem(snapshot: Snapshot, reg: LeverRegistry, draft: LeverDraft, itemId: string, locale: string): LeverDraft {
  const item = itemOf(reg, itemId)
  if (!item) return draft
  const next = { ...draft, item: itemId, amount: amountText(item.amount_minor, item.currency, locale), day: item.day === null ? '' : String(item.day) }
  const range = monthRange(snapshot, reg, next)
  const month = draft.kind === 'end' ? range.min : item.every === 'once' ? range.min : clampMonth(later(nextMonth(snapshot), range.min), range)
  return { ...next, month }
}

export function pickFloorAccount(snapshot: Snapshot, draft: LeverDraft, accountId: string, locale: string): LeverDraft {
  const currency = snapshotIndex(snapshot).accounts.get(accountId)?.currency
  return { ...draft, account: accountId, amount: currency ? amountText(floorIn(snapshot, accountId, draft.month), currency, locale) : '' }
}

export function pickCard(snapshot: Snapshot, reg: LeverRegistry, draft: LeverDraft, cardId: string, locale: string): LeverDraft {
  const targets = offerTargets(snapshot, reg, cardId)
  const keep = targets.some((a) => a.id === draft.to)
  return withEmi(snapshot, { ...draft, card: cardId, to: keep ? draft.to : (targets[0]?.id ?? null) }, locale)
}

// The installment follows the add-on formula until it is typed (P3-8: amount × (1 + rate × months) ÷ months, rounded half up).
export function withEmi(snapshot: Snapshot, draft: LeverDraft, locale: string): LeverDraft {
  if (draft.kind !== 'offer' || draft.emi_typed) return draft
  const terms = offerTerms(snapshot, draft, locale)
  return { ...draft, emi: terms ? amountText(addOnInstallment(terms.amount, terms.rate, terms.term), terms.currency, locale) : '' }
}

function offerTerms(snapshot: Snapshot, draft: LeverDraft, locale: string): { amount: number; rate: number; term: number; currency: string } | null {
  const currency = draft.card === null ? undefined : snapshotIndex(snapshot).accounts.get(draft.card)?.currency
  if (!currency) return null
  const amount = parseAmount(draft.amount.trim(), locale, currency)
  const rate = readRate(draft.rate)
  const term = readWhole(draft.term, 1, 600)
  return amount !== null && amount > 0 && rate !== null && term !== null ? { amount, rate, term, currency } : null
}

// What a loan offer repays in all, and how much of that is more than the amount drawn; null until the terms read.
export function offerCost(snapshot: Snapshot, draft: LeverDraft, locale: string): { total_minor: number; extra_minor: number; currency: string } | null {
  const terms = offerTerms(snapshot, draft, locale)
  if (!terms) return null
  const emi = parseAmount(draft.emi.trim(), locale, terms.currency)
  if (emi === null || emi <= 0) return null
  return { total_minor: emi * terms.term, extra_minor: emi * terms.term - terms.amount, currency: terms.currency }
}

// A whole number from `min` to `max`, or null.
export function readWhole(text: string, min: number, max: number): number | null {
  const t = text.trim()
  if (!/^\d{1,4}$/.test(t)) return null
  const n = Number(t)
  return n >= min && n <= max ? n : null
}

// A percent a month as typed ('1', '0.97', '1,25'), as a fraction below 1: 0.0097.
export function readRate(text: string): number | null {
  const t = text.trim().replace(/\s*%$/, '').replace(',', '.')
  if (!/^\d{1,2}(\.\d{1,4})?$/.test(t)) return null
  const n = Number(t)
  return n < 100 ? Math.round(n * 1e6) / 1e8 : null
}

// A percent from 1 to 90, as typed, as a fraction.
function readShift(text: string): number | null {
  const t = text.trim().replace(/\s*%$/, '').replace(',', '.')
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null
  const n = Number(t)
  return n > 0 && n <= 90 ? Math.round(n * 100) / 10000 : null
}

// A new draft for a kind, prefilled from the plan: next month (this month for a loan offer's draw), 12 months for an offer, 10% for FX, 3 months of no income.
export function newDraft(snapshot: Snapshot, reg: LeverRegistry, kind: LeverKind, locale: string): LeverDraft {
  const draft: LeverDraft = {
    kind,
    item: null,
    amount: '',
    day: '',
    month: nextMonth(snapshot),
    to_month: null,
    every: 'month',
    target: null,
    card: null,
    to: null,
    term: '12',
    rate: '',
    emi: '',
    emi_typed: false,
    direction: 'weaker',
    percent: '10',
    income: null,
    months: '3',
    account: null,
  }
  switch (kind) {
    case 'extra': {
      const e = reg.extra_payment
      const target = e?.from_account_ids[0] ? `from:${e.from_account_ids[0]}` : e?.debt_ids[0] ? `to:${e.debt_ids[0]}` : null
      return { ...draft, target }
    }
    case 'offer': {
      const card = reg.loan_offer?.card_ids[0] ?? null
      return card === null ? draft : pickCard(snapshot, reg, { ...draft, month: monthKey(snapshot.as_of) }, card, locale)
    }
    case 'floor': {
      const account = reg.floor_windows[0]?.account_id
      return account === undefined ? draft : pickFloorAccount(snapshot, draft, account, locale)
    }
    case 'fx':
    case 'gap':
      return draft
    default: {
      // The form opens on the list of items, unless there is only one to pick.
      const items = itemsFor(reg, kind)
      const only = items.length === 1 ? items[0] : undefined
      return only ? pickItem(snapshot, reg, draft, only.item_id, locale) : draft
    }
  }
}

// From `from` (to `to`, or with no end) the account keeps `amount` and nothing else; its windows before and after that span stay as they were.
export function floorWindowsFor(windows: readonly FloorWindow[], span: { from: string; to: string | null; amount_minor: number }): FloorWindow[] {
  const before = monthKey(addMonths(`${span.from}-01`, -1))
  const after = span.to === null ? null : monthKey(addMonths(`${span.to}-01`, 1))
  const out: FloorWindow[] = []
  for (const w of windows) {
    if (w.from_month < span.from) out.push({ ...w, to_month: w.to_month === null || w.to_month > before ? before : w.to_month })
    if (after !== null && (w.to_month === null || w.to_month >= after)) out.push({ ...w, from_month: w.from_month > after ? w.from_month : after })
  }
  if (span.amount_minor > 0) out.push({ from_month: span.from, to_month: span.to, amount_minor: span.amount_minor })
  return out.sort((a, b) => (a.from_month < b.from_month ? -1 : a.from_month > b.from_month ? 1 : 0))
}

export type ReadLever = { ok: true; lever: Lever } | { ok: false; errors: Partial<Record<DraftField, string>> }

const example = (currency: string, locale: string) => amountText(10 ** minorDigits(currency) * 1250, currency, locale)

// The draft as a lever from core's builders, or what to fix, field by field.
export function readLever(snapshot: Snapshot, reg: LeverRegistry, draft: LeverDraft, locale: string): ReadLever {
  const errors: Partial<Record<DraftField, string>> = {}
  const currency = draftCurrency(snapshot, reg, draft)
  // A budget may go below zero (a credit) and a floor to zero; no other amount may.
  const amountOf = (field: 'amount' | 'emi', allow: { negative?: boolean; zero?: boolean } = {}): number | null => {
    const typed = draft[field].trim()
    if (!currency) return null
    const value = typed === '' ? null : parseAmount(typed, locale, currency)
    if (typed === '') errors[field] = 'Type an amount.'
    else if (value === null || (value < 0 && !allow.negative)) errors[field] = `Type an amount such as ${example(currency, locale)}.`
    else if (value === 0 && !allow.zero) errors[field] = draft.kind === 'amount' ? 'Type an amount other than 0. To stop the item, end or remove it instead.' : 'Type an amount above 0.'
    else return value
    return null
  }
  const range = monthRange(snapshot, reg, draft)
  if (draft.month < range.min || draft.month > range.max) errors.month = 'Pick a month inside the projection.'
  const item = itemOf(reg, draft.item)
  const build = (make: () => Lever): ReadLever => {
    if (Object.keys(errors).length > 0) return { ok: false, errors }
    try {
      return { ok: true, lever: make() }
    } catch (error) {
      if (error instanceof RangeError) return { ok: false, errors: { form: error.message } }
      throw error
    }
  }
  switch (draft.kind) {
    case 'amount': {
      if (!item) errors.item = 'Pick an item.'
      const amount = amountOf('amount', { negative: item?.kind === 'allowance' })
      if (item && amount !== null && amount === item.amount_minor) errors.amount = 'That is the amount the plan already holds.'
      return build(() => amountLever(snapshot, item?.item_id ?? '', amount ?? 0, draft.month))
    }
    case 'day': {
      if (!item) errors.item = 'Pick an item.'
      const day = readWhole(draft.day, 1, 31)
      if (day === null) errors.day = 'Type a day of the month, 1 to 31.'
      else if (item && day === item.day) errors.day = 'That is the day the plan already holds.'
      return build(() => dayLever(snapshot, item?.item_id ?? '', day ?? 1, draft.month))
    }
    case 'end': {
      if (!item) errors.item = 'Pick an item.'
      // An installment's last month is its last billed month, kept as its first day, as split_plan_item ends one.
      const endsOn = item?.kind === 'installment' ? firstOfMonth(draft.month) : lastDayOfMonth(draft.month)
      return build(() => endLever(snapshot, item?.item_id ?? '', endsOn))
    }
    case 'remove':
      if (!item) errors.item = 'Pick an item.'
      return build(() => removeLever(snapshot, item?.item_id ?? ''))
    case 'upside':
      if (!item) errors.item = 'Pick an item.'
      return build(() => upsideLever(snapshot, item?.item_id ?? ''))
    case 'extra': {
      if (draft.target === null) errors.target = 'Pick where the extra goes.'
      const amount = amountOf('amount')
      const thisMonth = monthKey(snapshot.as_of)
      const starts_on = draft.month === thisMonth ? snapshot.as_of : firstOfMonth(draft.month)
      const target = draft.target ?? ''
      const id = target.slice(target.indexOf(':') + 1)
      return build(() => extraPaymentLever(snapshot, { amount_minor: amount ?? 0, every: draft.every, starts_on, ...(target.startsWith('from:') ? { from_account_id: id } : { to_debt_id: id }) }))
    }
    case 'offer': {
      if (draft.card === null) errors.card = 'Pick the card that lends.'
      if (draft.to === null) errors.to = 'Pick where the money lands.'
      const amount = amountOf('amount')
      const term = readWhole(draft.term, 1, 600)
      if (term === null) errors.term = 'Type a number of months, such as 12.'
      const rate = readRate(draft.rate)
      if (rate === null) errors.rate = 'Type the rate a month, such as 1 for 1%.'
      const emi = amountOf('emi')
      return build(() =>
        loanOfferLever(snapshot, {
          amount_minor: amount ?? 0,
          term_months: term ?? 0,
          monthly_rate: rate ?? 0,
          draw_month: draft.month,
          to_account_id: draft.to ?? '',
          card_id: draft.card ?? '',
          ...(emi !== null && term !== null && rate !== null && amount !== null && emi !== addOnInstallment(amount, rate, term) ? { emi_minor: emi } : {}),
        }),
      )
    }
    case 'fx': {
      const shift = readShift(draft.percent)
      if (shift === null) errors.percent = 'Type a percent from 1 to 90.'
      return build(() => fxShiftLever(snapshot, draft.direction === 'weaker' ? -(shift ?? 0) : (shift ?? 0)))
    }
    case 'gap': {
      const months = readWhole(draft.months, 1, 60)
      if (months === null) errors.months = 'Type a number of months from 1 to 60.'
      return build(() => incomeGapLever(snapshot, { from_month: draft.month, months: months ?? 1, ...(draft.income === null ? {} : { item_ids: [draft.income] }) }))
    }
    case 'floor': {
      const account = draft.account === null ? undefined : reg.floor_windows.find((f) => f.account_id === draft.account)
      if (!account) errors.account = 'Pick an account.'
      const amount = amountOf('amount', { zero: true })
      if (draft.to_month !== null && draft.to_month < draft.month) errors.to_month = 'Pick a month on or after the first.'
      const windows = account && amount !== null ? floorWindowsFor(account.floor_windows, { from: draft.month, to: draft.to_month, amount_minor: amount }) : []
      if (account && amount !== null && canonical(windows) === canonical(account.floor_windows)) errors.amount = 'That is the floor the plan already holds.'
      return build(() => floorWindowLever(snapshot, account?.account_id ?? '', windows))
    }
  }
}

// A lever back as the picker's draft, so a change on the list opens prefilled and changes in place; null for a shape the picker does not build alone (a loan offer, a floor over several windows).
export function draftOf(snapshot: Snapshot, reg: LeverRegistry, lever: Lever, locale: string): LeverDraft | null {
  const p = lever.patch
  const keys = Object.keys(p)
  const base = newDraft(snapshot, reg, 'fx', locale)
  const index = snapshotIndex(snapshot)
  if (keys.length === 1 && p.fx_shift_pct !== undefined) {
    const pct = Math.round(Math.abs(p.fx_shift_pct) * 10000) / 100
    return { ...base, kind: 'fx', direction: p.fx_shift_pct < 0 ? 'weaker' : 'stronger', percent: String(pct) }
  }
  if (keys.length === 1 && p.income_gap) {
    const gap = p.income_gap
    return { ...base, kind: 'gap', month: gap.from_month, months: String(gap.months), income: gap.item_ids?.length === 1 ? (gap.item_ids[0] ?? null) : null }
  }
  if (keys.length === 1 && p.add?.length === 1) {
    const row = p.add[0] as PlanItem
    const target = row.from_account_id !== null ? `from:${row.from_account_id}` : row.to_account_id !== null ? `to:${row.to_account_id}` : null
    const currency = index.accounts.get(row.from_account_id ?? row.to_account_id ?? '')?.currency
    if (row.kind !== 'transfer' || target === null || !currency || (row.every !== 'once' && row.every !== 'month')) return null
    return { ...base, kind: 'extra', target, every: row.every, amount: amountText(row.amount_minor, currency, locale), month: monthKey(row.starts_on) }
  }
  const entries = Object.entries(p.items ?? {})
  const [entry] = entries
  if (keys.length !== 1 || entries.length !== 1 || !entry) return null
  const [id, change] = entry
  const item = reg.items.find((i) => i.item_id === id)
  if (!item) return null
  const picked = pickItem(snapshot, reg, { ...base, kind: 'amount' }, id, locale)
  if (change.removed) return { ...picked, kind: 'remove' }
  if (change.include_upside) return { ...picked, kind: 'upside' }
  if (change.amount_minor !== undefined && change.from_month) return { ...picked, kind: 'amount', amount: amountText(change.amount_minor, item.currency, locale), month: change.from_month }
  if (change.day !== undefined && change.from_month) return { ...picked, kind: 'day', day: String(change.day), month: change.from_month }
  if (change.ends_on) return { ...picked, kind: 'end', month: monthKey(change.ends_on) }
  return null
}
