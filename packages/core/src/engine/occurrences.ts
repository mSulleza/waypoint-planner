import { addMonths, dayFromNumber, dayNumber, daysBetween, daysInMonth, firstOfMonth, lastDayOfMonth, monthKey, rollDayNumber, type Roll } from '../dates'
import { MONTHS_APART, type Account, type PlanItem, type Transaction } from '../schema/rows'
import { occurrenceId, snapshotIndex, type Snapshot } from '../snapshot'
import { HORIZON_MONTHS, LOOKBACK_MONTHS, type Flow, type Occurrence, type OccurrenceState } from './types'

export function horizonEnd(asOf: string): string {
  return lastDayOfMonth(addMonths(firstOfMonth(asOf), HORIZON_MONTHS))
}

// track_from, or the first of the month LOOKBACK_MONTHS back when that is later.
export function historyFrom(snapshot: Snapshot): string {
  const lookback = addMonths(firstOfMonth(snapshot.as_of), -LOOKBACK_MONTHS)
  const trackFrom = snapshot.doc.household.track_from
  return trackFrom > lookback ? trackFrom : lookback
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

// Every plan item walks the same months, so each YYYY-MM for a month index y × 12 + m − 1 is made once.
const monthTexts = new Map<number, string>()
function monthText(index: number): string {
  let text = monthTexts.get(index)
  if (text === undefined) monthTexts.set(index, (text = `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`))
  return text
}

// Day `day` of a valid YYYY-MM, clamped to the month end; the clamp only parses for days past the 28th.
const dayIn = (ym: string, day: number) => `${ym}-${pad(day <= 28 ? day : Math.min(day, daysInMonth(ym)))}`

// A month's cut, its day clamped to the month end.
export function cutIn(cutDay: number, month: string): string {
  return dayIn(monthKey(month), cutDay)
}

export function cutOnOrAfter(cutDay: number, day: string): string {
  const cut = cutIn(cutDay, day)
  return cut >= day ? cut : cutIn(cutDay, addMonths(firstOfMonth(day), 1))
}

// The cut by cut day nearest to `day`, the earlier on a tie: a printed cut a few days off its cut day stands for that cycle.
export function slotCut(cutDay: number, day: string): string {
  const month = firstOfMonth(day)
  let best = cutIn(cutDay, addMonths(month, -1))
  for (const candidate of [cutIn(cutDay, month), cutIn(cutDay, addMonths(month, 1))]) {
    if (Math.abs(daysBetween(candidate, day)) < Math.abs(daysBetween(best, day))) best = candidate
  }
  return best
}

// The latest entered cut on or before as_of; with none, the opening date, where the opening balance acts as a total-only statement.
export function latestCut(snapshot: Snapshot, accountId: string): string {
  const index = snapshotIndex(snapshot)
  const account = index.accounts.get(accountId)
  if (account?.kind !== 'credit_card') throw new RangeError(`'${accountId}' is not a card in the snapshot`)
  let cut = account.opening_date
  for (const s of index.statementsByAccount.get(accountId) ?? []) if (s.cut_date <= snapshot.as_of) cut = s.cut_date
  return cut
}

// Installments dated on or before this day are on the latest entered statement, including the one for its cut day when it printed early.
export function billedThrough(snapshot: Snapshot, accountId: string): string {
  const index = snapshotIndex(snapshot)
  const account = index.accounts.get(accountId)
  if (account?.kind !== 'credit_card') throw new RangeError(`'${accountId}' is not a card in the snapshot`)
  let through = account.opening_date
  for (const s of index.statementsByAccount.get(accountId) ?? []) {
    if (s.cut_date > snapshot.as_of) break
    const slot = slotCut(account.terms.cut_day, s.cut_date)
    through = slot > s.cut_date ? slot : s.cut_date
  }
  return through
}

function flowOf(item: PlanItem, accounts: ReadonlyMap<string, Account>): Flow {
  const kindOf = (id: string | null) => (id === null ? undefined : accounts.get(id)?.kind)
  switch (item.kind) {
    case 'income':
      return kindOf(item.to_account_id) === 'cash' ? 'income' : 'draw'
    case 'bill':
      return kindOf(item.from_account_id) === 'cash' ? 'bill' : 'card_bill'
    case 'transfer':
      return item.from_account_id === null ? 'debt_transfer' : item.to_account_id === null ? 'extra' : 'transfer'
    default:
      return item.kind
  }
}

// [period, scheduled day] pairs from starts_on with from <= day <= to; counting from starts_on keeps a 31st on each month's last day.
export function itemSchedule(item: PlanItem, cutDay: number | null, from: string, to: string): [string, string][] {
  const out: [string, string][] = []
  const start = item.starts_on
  const last = item.ends_on !== null && item.ends_on < to ? item.ends_on : to
  if (item.every === 'once') {
    if (start >= from && start <= last) out.push([`${start.slice(0, 8)}01`, start])
    return out
  }
  if (item.every === 'week' || item.every === '2weeks') {
    const step = item.every === 'week' ? 7 : 14
    const startDay = dayNumber(start)
    for (let n = Math.max(0, Math.floor(daysBetween(start, from) / step)); ; n++) {
      const day = dayFromNumber(startDay + n * step)
      if (day > last) break
      if (day >= from) out.push([day, day])
    }
    return out
  }
  const months = MONTHS_APART[item.every]
  const first = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1
  const lowest = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1
  const day = Number(start.slice(8, 10))
  for (let n = Math.max(0, Math.floor((lowest - first) / months) - 1); ; n++) {
    const ym = monthText(first + n * months)
    const period = `${ym}-01`
    // An installment bills at its month's cut and ends with its last billed month.
    const scheduled = dayIn(ym, cutDay ?? day)
    if ((cutDay === null ? scheduled : period) > last || scheduled > to) break
    if (scheduled >= from) out.push([period, scheduled])
  }
  return out
}

// States on read (spec §6.3 and §6.6); `cut` is the card's latest cut and `billed` its billedThrough, both null on cash.
function stateOf(o: Occurrence, asOf: string, cut: string | null, billed: string | null): OccurrenceState | null {
  const { flow, date } = o
  if (flow === 'debt_transfer' || flow === 'extra' || (flow === 'allowance' && o.amount_minor < 0)) return null
  if (o.skipped) return 'settled'
  if (flow === 'allowance') {
    if (o.period.slice(0, 7) < asOf.slice(0, 7)) return 'lapsed'
    return cut !== null && lastDayOfMonth(o.period) <= cut ? 'on_statement' : 'due'
  }
  if (flow === 'installment') return billed !== null && date <= billed ? 'on_statement' : 'due'
  if (o.linked_minor >= o.amount_minor) return 'settled'
  if (flow === 'card_bill' && cut !== null && date <= cut) return 'on_statement'
  if (date < asOf && flow === 'income') return 'late'
  if (date < asOf && flow === 'draw') return 'unconfirmed'
  if (date < asOf && (flow === 'bill' || flow === 'transfer')) return 'overdue'
  return o.linked_minor > 0 ? 'partly_settled' : 'due'
}

function openOf(o: Occurrence): number {
  if (o.skipped || o.state === 'settled' || o.state === 'on_statement' || o.state === 'lapsed') return 0
  return Math.max(0, o.amount_minor - o.linked_minor)
}

const NO_LINKS: readonly Transaction[] = Object.freeze([])

// roll() for a day the schedule made, which needs no parse.
function rollScheduled(day: string, rule: Roll): string {
  const n = dayNumber(day)
  const rolled = rollDayNumber(n, rule)
  return rolled === n ? day : dayFromNumber(rolled)
}

const byDateThenId = (a: Occurrence, b: Occurrence) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Every occurrence from history_from to `to` (the horizon end by default), upside items left out, in date order.
export function occurrencesOf(snapshot: Snapshot, to = horizonEnd(snapshot.as_of)): Occurrence[] {
  const index = snapshotIndex(snapshot)
  const asOf = snapshot.as_of
  const from = historyFrom(snapshot)
  // An allowance spends over its whole month, so the month history_from falls in keeps its allowance.
  const allowanceFrom = firstOfMonth(from)
  const cuts = new Map<string, string>()
  const billed = new Map<string, string>()
  for (const a of snapshot.doc.accounts) {
    if (a.kind !== 'credit_card') continue
    cuts.set(a.id, latestCut(snapshot, a.id))
    billed.set(a.id, billedThrough(snapshot, a.id))
  }
  // Late income moves to the first of next month, and on again each month until it is linked or skipped.
  const carriedTo = addMonths(firstOfMonth(asOf), 1)
  const out: Occurrence[] = []
  for (const item of snapshot.doc.plan_items) {
    if (item.confidence === 'upside') continue
    const flow = flowOf(item, index.accounts)
    const accountId = flow === 'income' || flow === 'draw' || flow === 'debt_transfer' ? item.to_account_id : item.from_account_id
    const account = accountId === null ? undefined : index.accounts.get(accountId)
    if (accountId === null || !account) throw new Error(`Plan item '${item.id}' has no ${flow === 'income' || flow === 'draw' || flow === 'debt_transfer' ? 'to' : 'from'} account`)
    const terms = flow === 'installment' && account.kind === 'credit_card' ? account.terms : null
    const skips = new Set(item.skip_periods)
    const cut = cuts.get(accountId) ?? null
    const schedule = itemSchedule(item, terms?.cut_day ?? null, flow === 'allowance' ? allowanceFrom : from, to)
    for (let k = 0; k < schedule.length; k++) {
      const pair = schedule[k] as [string, string]
      const period = pair[0]
      const scheduled = pair[1]
      const id = occurrenceId(item.id, period)
      const links = index.linksByOccurrence.get(id) ?? NO_LINKS
      let linked = 0
      for (const t of links) linked += Math.abs(t.amount_minor)
      const o: Occurrence = {
        id,
        plan_item_id: item.id,
        kind: item.kind,
        flow,
        category_id: item.category_id,
        period,
        scheduled_on: scheduled,
        date: flow === 'installment' || item.roll === 'none' ? scheduled : rollScheduled(scheduled, item.roll),
        account_id: accountId,
        to_account_id: flow === 'transfer' ? item.to_account_id : null,
        amount_minor: item.amount_minor,
        links,
        linked_minor: linked,
        skipped: skips.has(period),
        state: null,
        open_minor: 0,
        carried_to: null,
      }
      o.state = stateOf(o, asOf, cut, billed.get(accountId) ?? null)
      o.open_minor = openOf(o)
      if (o.state === 'late') o.carried_to = carriedTo
      out.push(o)
    }
  }
  return out.sort(byDateThenId)
}
