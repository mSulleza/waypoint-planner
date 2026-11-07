import { z } from 'zod'
import { addMonths, dayInMonth, firstOfMonth, monthKey } from './dates'
import { expandPlan } from './engine/events'
import { fundingCurrency } from './engine/fx'
import { cutOnOrAfter, horizonEnd, itemSchedule } from './engine/occurrences'
import type { OccurrenceState } from './engine/types'
import { fnv1a64 } from './hash'
import { canonical, type Lever } from './levers'
import { addOnInstallment, formatMoney } from './money'
import { checkInput, strictKeys, type Checked } from './schema/common'
import { patchSchema, type Patch } from './schema/patch'
import type { Account, FloorWindow, PlanItem, PlanItemKind } from './schema/rows'
import { snapshotIndex, type Snapshot } from './snapshot'

export type ItemLeverKind = 'amount' | 'day' | 'end' | 'remove' | 'include_upside'

// One plan item a person can still decide about, and the levers it takes.
export interface ItemLevers {
  item_id: string
  name: string
  kind: PlanItemKind
  currency: string
  amount_minor: number
  // The day of the month it falls on; null for a weekly item, an allowance or an installment.
  day: number | null
  every: PlanItem['every']
  starts_on: string
  ends_on: string | null
  upside: boolean
  // The first month a change can apply from: this month, or the item's own first month when that is later or the item happens once.
  first_month: string
  levers: readonly ItemLeverKind[]
}

export interface LeverRegistry {
  items: readonly ItemLevers[]
  // Cash accounts that pay debts, for extra for debts, and the debts an extra payment can go into; null with no debt.
  extra_payment: { from_account_ids: readonly string[]; debt_ids: readonly string[] } | null
  // Cards that can lend, and every account a draw can land on; null with no card.
  loan_offer: { card_ids: readonly string[]; to_account_ids: readonly string[] } | null
  // null in a one-currency household.
  fx_shift: { funding_currency: string } | null
  // Income items a gap can stop by name; null with no income item.
  income_gap: { item_ids: readonly string[]; first_month: string } | null
  floor_windows: readonly { account_id: string; floor_windows: readonly FloorWindow[] }[]
}

const OPEN: ReadonlySet<OccurrenceState> = new Set(['due', 'overdue', 'late', 'partly_settled'])

const accountOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The levers Compare offers (spec §7): an item is listed only while one of its occurrences is still open from today, so no lever is offered once nothing is left to decide.
export function registry(snapshot: Snapshot): LeverRegistry {
  const index = snapshotIndex(snapshot)
  const asOf = snapshot.as_of
  const thisMonth = monthKey(asOf)
  const open = new Set<string>()
  for (const o of expandPlan(snapshot).occurrences) {
    // A negative allowance has no state but still nets against its whole month.
    const ahead = o.flow === 'allowance' ? o.period.slice(0, 7) >= thisMonth : o.date >= asOf
    if (!o.skipped && (o.state === null ? ahead : OPEN.has(o.state))) open.add(o.plan_item_id)
  }
  const end = horizonEnd(asOf)
  const items: ItemLevers[] = []
  for (const item of snapshot.doc.plan_items) {
    const upside = item.confidence === 'upside'
    if (upside ? itemSchedule(item, null, asOf, end).length === 0 : !open.has(item.id)) continue
    const account = index.accounts.get(item.from_account_id ?? item.to_account_id ?? '')
    if (!account) continue
    const dated = item.kind !== 'installment' && item.kind !== 'allowance' && item.every !== 'week' && item.every !== '2weeks'
    const levers: ItemLeverKind[] = upside ? ['include_upside'] : ['amount', ...(dated ? (['day'] as const) : []), ...(item.every === 'once' ? [] : (['end'] as const)), 'remove']
    const first = monthKey(item.starts_on)
    items.push({
      item_id: item.id,
      name: item.name,
      kind: item.kind,
      currency: account.currency,
      amount_minor: item.amount_minor,
      day: dated ? Number(item.starts_on.slice(8, 10)) : null,
      every: item.every,
      starts_on: item.starts_on,
      ends_on: item.ends_on,
      upside,
      // A one-off changes in place, so one still late or overdue from an earlier month keeps that month.
      first_month: item.every === 'once' || first > thisMonth ? first : thisMonth,
      levers: Object.freeze(levers),
    })
  }
  const live = snapshot.doc.accounts.filter((a) => a.archived_at === null).sort(accountOrder)
  const debts = live.filter((a) => a.kind !== 'cash')
  const cards = live.filter((a) => a.kind === 'credit_card')
  const funders = live.filter((a) => a.kind === 'cash' && debts.some((d) => d.funded_from_account_id === a.id))
  const income = snapshot.doc.plan_items.filter((p) => p.kind === 'income' && p.confidence !== 'upside')
  const funding = fundingCurrency(snapshot)
  return Object.freeze({
    items: Object.freeze(items),
    extra_payment: debts.length === 0 ? null : { from_account_ids: funders.map((a) => a.id), debt_ids: debts.map((a) => a.id) },
    loan_offer: cards.length === 0 ? null : { card_ids: cards.map((a) => a.id), to_account_ids: live.map((a) => a.id) },
    fx_shift: funding === null ? null : { funding_currency: funding },
    income_gap: income.length === 0 ? null : { item_ids: income.map((p) => p.id), first_month: thisMonth },
    floor_windows: live.flatMap((a) => (a.kind === 'cash' ? [{ account_id: a.id, floor_windows: a.floor_windows }] : [])),
  })
}

// One item's levers, or null when nothing is left to decide about it (an unknown id included).
export function itemLevers(snapshot: Snapshot, itemId: string): ItemLevers | null {
  return registry(snapshot).items.find((i) => i.item_id === itemId) ?? null
}

const monthFormats = new Map<string, Intl.DateTimeFormat>()
const dayFormats = new Map<string, Intl.DateTimeFormat>()

function dateText(formats: Map<string, Intl.DateTimeFormat>, locale: string, day: string, options: Intl.DateTimeFormatOptions): string {
  let fmt = formats.get(locale)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC', calendar: 'gregory' })
    formats.set(locale, fmt)
  }
  return fmt.format(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10) || '1')))
}

function wording(snapshot: Snapshot) {
  const index = snapshotIndex(snapshot)
  const { locale } = snapshot.doc.household
  const account = (id: string): Account => {
    const found = index.accounts.get(id)
    if (!found) throw new RangeError(`No account '${id}' in the snapshot`)
    return found
  }
  const item = (id: string): PlanItem => {
    const found = index.planItems.get(id)
    if (!found) throw new RangeError(`No plan item '${id}' in the snapshot`)
    return found
  }
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 3 })
  return {
    account,
    item,
    money: (minor: number, accountId: string) => formatMoney(minor, account(accountId).currency, locale),
    itemMoney: (minor: number, p: PlanItem) => formatMoney(minor, account(p.from_account_id ?? p.to_account_id ?? '').currency, locale),
    month: (key: string) => dateText(monthFormats, locale, key, { month: 'short', year: 'numeric' }),
    day: (day: string) => dateText(dayFormats, locale, day, { day: 'numeric', month: 'short', year: 'numeric' }),
    percent: (fraction: number) => percent.format(fraction),
  }
}

export function amountLever(snapshot: Snapshot, itemId: string, amount_minor: number, from_month: string): Lever {
  const w = wording(snapshot)
  const p = w.item(itemId)
  return { label: `${p.name}: ${w.itemMoney(amount_minor, p)} from ${w.month(from_month)}`, patch: { items: { [itemId]: { amount_minor, from_month } } } }
}

export function dayLever(snapshot: Snapshot, itemId: string, day: number, from_month: string): Lever {
  const w = wording(snapshot)
  return { label: `${w.item(itemId).name}: day ${day} from ${w.month(from_month)}`, patch: { items: { [itemId]: { day, from_month } } } }
}

// ends_on null takes an end date away.
export function endLever(snapshot: Snapshot, itemId: string, ends_on: string | null): Lever {
  const w = wording(snapshot)
  const name = w.item(itemId).name
  return { label: ends_on === null ? `${name}: no end date` : `${name}: ends ${w.day(ends_on)}`, patch: { items: { [itemId]: { ends_on } } } }
}

export function removeLever(snapshot: Snapshot, itemId: string): Lever {
  return { label: `Remove ${wording(snapshot).item(itemId).name}`, patch: { items: { [itemId]: { removed: true } } } }
}

export function upsideLever(snapshot: Snapshot, itemId: string): Lever {
  return { label: `Include ${wording(snapshot).item(itemId).name}`, patch: { items: { [itemId]: { include_upside: true } } } }
}

// Ids of added rows come from what they hold, so the same choice always adds the same ids and a link round-trips.
const choiceId = (prefix: string, choice: unknown) => `${prefix}-${fnv1a64(canonical(choice)).slice(0, 10)}`

export interface ExtraPaymentChoice {
  amount_minor: number
  every: 'once' | 'month'
  starts_on: string
  // Extra for debts leaves this cash account and follows the payoff order.
  from_account_id?: string
  // Or the debt it goes into, paid from that debt's funded-from account.
  to_debt_id?: string
}

// A transfer item with no to account from a cash account, or with no from account into one debt.
export function extraPaymentLever(snapshot: Snapshot, choice: ExtraPaymentChoice): Lever {
  const w = wording(snapshot)
  const issues: string[] = []
  if ((choice.from_account_id === undefined) === (choice.to_debt_id === undefined)) issues.push('name either from_account_id (extra for debts) or to_debt_id (one debt)')
  if (choice.from_account_id !== undefined && w.account(choice.from_account_id).kind !== 'cash') issues.push(`from_account_id: '${choice.from_account_id}' is not a cash account`)
  if (choice.to_debt_id !== undefined && w.account(choice.to_debt_id).kind === 'cash') issues.push(`to_debt_id: '${choice.to_debt_id}' is not a debt`)
  if (!(Number.isSafeInteger(choice.amount_minor) && choice.amount_minor > 0)) issues.push(`amount_minor: must be a whole number of minor units above 0`)
  if (issues.length > 0) throw new RangeError(issues.join('; '))
  const from = choice.from_account_id ?? null
  const to = choice.to_debt_id ?? null
  // Extra for debts is in its cash account's currency, a payment into one debt in the debt's.
  const money = w.money(choice.amount_minor, from ?? to ?? '')
  const name = to === null ? 'Extra for debts' : `Extra into ${w.account(to).name}`
  const when = choice.every === 'once' ? `on ${w.day(choice.starts_on)}` : `a month from ${w.month(choice.starts_on)}`
  const row: PlanItem = {
    id: choiceId('extra', choice),
    kind: 'transfer',
    name,
    from_account_id: from,
    to_account_id: to,
    category_id: null,
    amount_minor: choice.amount_minor,
    every: choice.every,
    starts_on: choice.starts_on,
    ends_on: null,
    roll: 'none',
    confidence: 'committed',
    stops_with_income: false,
    skip_periods: [],
  }
  return { label: `${to === null ? `${name} from ${w.account(from ?? '').name}` : name}: ${money} ${when}`, patch: { add: [row] } }
}

export interface LoanOfferChoice {
  amount_minor: number
  term_months: number
  // A fraction: 0.01 is 1% a month.
  monthly_rate: number
  draw_month: string
  // Day of the draw month, 1 by default and clamped to the month end; a draw before today lands today.
  draw_day?: number
  // A cash account, or a debt the draw pays down as a planned draw.
  to_account_id: string
  // The card that lends and bills the installments.
  card_id: string
  // The bank's own EMI, when it differs from the add-on formula.
  emi_minor?: number
}

// A planned draw plus an installment on the lending card from the first cut on or after the draw, for the term (spec §7).
export function loanOfferLever(snapshot: Snapshot, choice: LoanOfferChoice): Lever {
  const w = wording(snapshot)
  const card = w.account(choice.card_id)
  const to = w.account(choice.to_account_id)
  const issues: string[] = []
  if (card.kind !== 'credit_card') issues.push(`card_id: '${card.id}' is not a credit card`)
  // The draw and its installments are one loan in one currency.
  if (to.currency !== card.currency) issues.push(`to_account_id: '${to.id}' holds ${to.currency}, but '${card.id}' lends ${card.currency}`)
  if (!(Number.isSafeInteger(choice.amount_minor) && choice.amount_minor > 0)) issues.push('amount_minor: must be a whole number of minor units above 0')
  if (!(Number.isSafeInteger(choice.term_months) && choice.term_months > 0)) issues.push('term_months: must be a whole number of months above 0')
  if (!(choice.monthly_rate >= 0 && choice.monthly_rate < 1)) issues.push('monthly_rate: must be a fraction from 0 to below 1, such as 0.01 for 1% a month')
  if (choice.emi_minor !== undefined && !(Number.isSafeInteger(choice.emi_minor) && choice.emi_minor > 0)) issues.push('emi_minor: must be a whole number of minor units above 0')
  if (issues.length > 0 || card.kind !== 'credit_card') throw new RangeError(issues.join('; '))
  const day = dayInMonth(choice.draw_month, choice.draw_day ?? 1)
  const drawOn = day < snapshot.as_of ? snapshot.as_of : day
  const emi = choice.emi_minor ?? addOnInstallment(choice.amount_minor, choice.monthly_rate, choice.term_months)
  const first = firstOfMonth(cutOnOrAfter(card.terms.cut_day, drawOn))
  const id = choiceId('offer', choice)
  const draw: PlanItem = {
    id: `${id}-draw`,
    kind: 'income',
    name: `Loan offer from ${card.name}`,
    from_account_id: null,
    to_account_id: to.id,
    category_id: null,
    amount_minor: choice.amount_minor,
    every: 'once',
    starts_on: drawOn,
    ends_on: null,
    roll: 'none',
    confidence: 'committed',
    stops_with_income: false,
    skip_periods: [],
  }
  const installment: PlanItem = {
    ...draw,
    id: `${id}-emi`,
    kind: 'installment',
    name: `Loan offer installment`,
    from_account_id: card.id,
    to_account_id: null,
    amount_minor: emi,
    every: 'month',
    starts_on: first,
    ends_on: addMonths(first, choice.term_months - 1),
  }
  const label = `Loan offer ${w.money(choice.amount_minor, card.id)} over ${choice.term_months} months at ${w.percent(choice.monthly_rate)} a month (${w.money(emi, card.id)} a month), into ${to.name} on ${w.day(drawOn)}`
  return { label, patch: { add: [draw, installment] } }
}

// A fraction of the funding currency's value: −0.1 is 10% weaker.
export function fxShiftLever(snapshot: Snapshot, fx_shift_pct: number): Lever {
  const w = wording(snapshot)
  const funding = fundingCurrency(snapshot)
  if (funding === null) throw new RangeError('A one-currency household has no FX to shift')
  return { label: `${funding} ${w.percent(Math.abs(fx_shift_pct))} ${fx_shift_pct < 0 ? 'weaker' : 'stronger'}`, patch: { fx_shift_pct } }
}

export function incomeGapLever(snapshot: Snapshot, gap: NonNullable<Patch['income_gap']>): Lever {
  const w = wording(snapshot)
  const what = gap.item_ids ? gap.item_ids.map((id) => w.item(id).name).join(' and ') : 'Income'
  return { label: `${what} stops for ${gap.months} month${gap.months === 1 ? '' : 's'} from ${w.month(gap.from_month)}`, patch: { income_gap: gap } }
}

export function floorWindowLever(snapshot: Snapshot, accountId: string, floor_windows: readonly FloorWindow[]): Lever {
  const w = wording(snapshot)
  const parts = floor_windows.map((f) => `${w.money(f.amount_minor, accountId)} from ${w.month(f.from_month)}${f.to_month === null ? '' : ` to ${w.month(f.to_month)}`}`)
  return { label: `${w.account(accountId).name} floor: ${parts.length > 0 ? parts.join(', ') : 'none'}`, patch: { accounts: { [accountId]: { floor_windows: [...floor_windows] } } } }
}

// A link holds at most this many levers, so a shared URL never asks for an unbounded run of walks.
export const LINK_MAX_LEVERS = 20

const leverLink = strictKeys({
  v: z.literal(1, 'must be 1'),
  levers: z.array(strictKeys({ label: z.string().min(1, 'must not be empty').max(300, 'must be at most 300 characters'), patch: patchSchema })).max(LINK_MAX_LEVERS, `must hold at most ${LINK_MAX_LEVERS} levers`),
})

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// UTF-8 through the URI escapes every JavaScript engine has.
function utf8(text: string): number[] {
  const escaped = encodeURIComponent(text)
  const bytes: number[] = []
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '%') {
      bytes.push(parseInt(escaped.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(escaped.charCodeAt(i))
  }
  return bytes
}

function toBase64url(bytes: readonly number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    const chars = Math.min(4, bytes.length - i + 1)
    for (let k = 0; k < chars; k++) out += BASE64URL[(n >> (18 - 6 * k)) & 63]
  }
  return out
}

function fromBase64url(text: string): number[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 4) {
    const group = text.slice(i, i + 4)
    let n = 0
    for (let k = 0; k < 4; k++) n = (n << 6) | (k < group.length ? BASE64URL.indexOf(group[k] ?? 'A') : 0)
    const count = group.length - 1
    for (let k = 0; k < count; k++) bytes.push((n >> (16 - 8 * k)) & 255)
  }
  return bytes
}

// Compare's levers as the URL fragment after `#`, which browsers never send to a server.
export function encodeLevers(levers: readonly Lever[]): string {
  const checked = checkInput(leverLink, { v: 1, levers })
  if (!checked.ok) throw new RangeError(`These levers cannot make a link: ${checked.errors.join('; ')}`)
  return toBase64url(utf8(JSON.stringify(checked.value)))
}

// Reads a fragment back, with or without its `#`; every problem is a named error, never an empty lever list.
export function decodeLevers(fragment: string): Checked<Lever[]> {
  const bytes = fromBase64url(fragment.startsWith('#') ? fragment.slice(1) : fragment)
  if (bytes === null) return { ok: false, errors: ['bad_link: the link is not base64url text'] }
  let text: string
  try {
    text = decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''))
  } catch {
    return { ok: false, errors: ['bad_link: the link is not UTF-8 text'] }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`bad_json: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const checked = checkInput(leverLink, value)
  return checked.ok ? { ok: true, value: checked.value.levers } : checked
}
