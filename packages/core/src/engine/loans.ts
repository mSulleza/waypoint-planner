import { dayFromNumber, dayNumber, daysInMonth, roll } from '../dates'
import { grossFor, netOf, scaleMinor } from '../money'
import type { LoanAccount, Transaction } from '../schema/rows'
import { occurrenceId, snapshotIndex, type Snapshot } from '../snapshot'
import type { Conversion, DebtInput, DebtMove, DebtOutput, ExtraOffer, LoanModule } from './debts'
import { expandPlan } from './events'
import { itemSchedule } from './occurrences'
import { extraByMonth, payoffOrder, type MonthExtra } from './payoff'
import type { EngineEvent, Walk } from './types'

// The payoff walks on past the horizon for at most 50 years from this month.
export const PAYOFF_CAP_MONTHS = 600
// A payment posted in the 7 days up to and including a payment day counts toward it (spec §6.5).
export const PAYMENT_WINDOW_DAYS = 7

// One payment day of the annuity schedule.
export interface LoanPayment {
  // payment_day of its month, clamped to the month end.
  on: string
  // Balance × annual_rate ÷ 12, rounded half up, on what was owed at the start of the day with the payments counted toward it added back.
  interest_minor: number
  // The scheduled payment, capped at balance plus interest.
  due_minor: number
  // Recorded payments counted toward it: those in its window, and while it is short those after it before the next window opens.
  paid_minor: number
  // What the model pays for it: on the day, or on as_of for a day this month that passed short; 0 for history.
  model_minor: number
  overdue: boolean
  // Owed at the end of the day, after every posting on it.
  owed_after_minor: number
  after_horizon: boolean
}

// A move the loan makes; one after the horizon stays out of the walk and only places the payoff.
export interface LoanMove extends DebtMove {
  after_horizon: boolean
}

export interface LoanPayoff {
  // The day the loan clears for good; null when nothing is owed from as_of on, or when 50 years of payments do not clear it.
  on: string | null
  month: string | null
  // Cleared after the horizon end, or not cleared within the cap.
  after_horizon: boolean
}

export interface LoanSchedule {
  account_id: string
  // The live balance, positive while owed: opening walked through monthly interest and every row up to as_of.
  owed_minor: number
  // Interest on payment days from as_of to the horizon end, and after it to the payoff.
  interest_minor: number
  interest_after_horizon_minor: number
  // Every payment day from the opening date to the payoff that charged, owed or took anything.
  payments: readonly LoanPayment[]
  // Interest, scheduled payments, transfer items as principal and extra, from as_of to the payoff; history interest posts on as_of.
  moves: readonly LoanMove[]
  payoff: LoanPayoff
  // Extra for debts this loan did not need, passed on the same day to the next debt in payoff order.
  passed_on: readonly ExtraOffer[]
}

export interface LoanExtra {
  // The funding account's extra by month, offered on the loan's payment day in that month when it comes first in its payoff order.
  months: ReadonlyMap<string, MonthExtra> | null
  // Offers from the debt before it in payoff order.
  offers: readonly ExtraOffer[]
  // Where what this loan does not need goes; null leaves it in cash.
  next: string | null
}

export interface LoanOptions {
  // The horizon end: moves after it are flagged after_horizon.
  until: string
  // The loan's planned draws from the walk's events.
  draws?: readonly EngineEvent[]
  // From the funded-from account to the loan; the bare amount by default.
  conversion?: Conversion
  // What a payment puts on the loan once the walk grosses it up and converts it; by default what `conversion` lands.
  landed?: (amount: number) => number
  extra?: LoanExtra
}

interface Sending {
  amount_minor: number
  occurrence_ids: string[]
}

const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1

// Day `day` of month index `mi`, clamped to the month end; only days past the 28th parse.
function dayOfMonth(mi: number, day: number): string {
  const ym = `${String(Math.floor(mi / 12)).padStart(4, '0')}-${String((mi % 12) + 1).padStart(2, '0')}`
  return `${ym}-${String(day <= 28 ? day : Math.min(day, daysInMonth(ym))).padStart(2, '0')}`
}

const byMove = (a: DebtMove, b: DebtMove) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// Past the horizon, a balance this large cannot be scaled safely, and a loan that grew to it never clears.
const LARGEST_OWED = Number.MAX_SAFE_INTEGER / 64

// Walks one loan's annuity schedule from its opening date (spec §6.5): the walk's moves to the horizon end, then on to the payoff or the cap.
export function scheduleLoan(snapshot: Snapshot, loan: LoanAccount, options: LoanOptions): LoanSchedule {
  const asOf = snapshot.as_of
  const index = snapshotIndex(snapshot)
  const { annual_rate: rate, payment_minor: scheduled, payment_day: payDay } = loan.terms
  const conversion = options.conversion ?? { rate: 1, feePct: 0 }
  const landed = options.landed ?? ((amount: number) => netOf(grossFor(amount, conversion.rate, conversion.feePct), conversion.rate, conversion.feePct))
  const extra = options.extra ?? null
  const funder = loan.funded_from_account_id
  const funderCurrency = index.accounts.get(funder)?.currency
  const today = dayNumber(asOf)
  const end = dayNumber(options.until)
  const thisMonth = monthIndex(asOf)
  const capMonth = thisMonth + PAYOFF_CAP_MONTHS

  const opened = dayNumber(loan.opening_date)
  const dueDays: number[] = []
  for (let mi = monthIndex(loan.opening_date); mi <= capMonth; mi++) {
    const day = dayNumber(dayOfMonth(mi, payDay))
    if (day >= opened) dueDays.push(day)
  }

  // A payment counts toward the first payment day whose window holds it; a payment linked to a transfer item into the loan is that item's principal.
  const isPayment = (t: Transaction) => {
    if (t.kind !== 'transfer' || t.amount_minor <= 0 || t.transfer_id === null) return false
    const out = index.transfers.get(t.transfer_id)?.find((leg) => leg.id !== t.id)
    return out === undefined || out.plan_item_id === null
  }
  const credits: { at: number; amount: number }[] = []
  const counted = new Float64Array(dueDays.length)
  const early = new Float64Array(dueDays.length)
  const late = new Float64Array(dueDays.length)
  let j = 0
  for (const t of index.rowsByAccount.get(loan.id) ?? []) {
    const at = dayNumber(t.posted_on)
    credits.push({ at, amount: t.amount_minor })
    if (!isPayment(t)) continue
    while (j < dueDays.length && (dueDays[j] ?? 0) < at) j++
    const due = dueDays[j]
    if (due !== undefined && due - at < PAYMENT_WINDOW_DAYS) {
      counted[j] = (counted[j] ?? 0) + t.amount_minor
      if (at < due) early[j] = (early[j] ?? 0) + t.amount_minor
    } else if (j > 0) late[j - 1] = (late[j - 1] ?? 0) + t.amount_minor
  }
  for (const e of options.draws ?? []) if (e.kind === 'draw' && e.account_id === loan.id) credits.push({ at: dayNumber(e.date), amount: e.amount_minor })
  credits.sort((a, b) => a.at - b.at)

  const send = (into: Map<number, Sending>, at: number, amount: number, ids: readonly string[]) => {
    const found = into.get(at)
    if (!found) into.set(at, { amount_minor: amount, occurrence_ids: [...ids] })
    else {
      found.amount_minor += amount
      for (const id of ids) if (!found.occurrence_ids.includes(id)) found.occurrence_ids.push(id)
    }
  }
  // Transfer items into the loan, in the funding account's currency, less the payments linked to them.
  const items = new Map<number, Sending>()
  for (const o of expandPlan(snapshot).occurrences) {
    if (o.flow !== 'debt_transfer' || o.account_id !== loan.id || o.skipped) continue
    let open = o.amount_minor
    for (const link of o.links) {
      const leg = link.transfer_id === null ? undefined : index.transfers.get(link.transfer_id)?.find((t) => t.account_id === loan.id)
      if (!leg) continue
      open -= index.accounts.get(link.account_id)?.currency === funderCurrency ? 0 - link.amount_minor : grossFor(leg.amount_minor, conversion.rate, conversion.feePct)
    }
    if (open <= 0) continue
    // One this month whose day passed still goes, on as_of; earlier months are history.
    const at = dayNumber(o.date)
    if (at >= today) send(items, at, open, [o.id])
    else if (monthIndex(o.date) === thisMonth) send(items, today, open, [o.id])
  }
  // Past the horizon only recurring transfer items keep paying it down.
  const after = dayFromNumber(end + 1)
  const capDay = dayOfMonth(capMonth, 31)
  for (const item of snapshot.doc.plan_items) {
    if (item.kind !== 'transfer' || item.from_account_id !== null || item.to_account_id !== loan.id || item.confidence === 'upside') continue
    const skipped = new Set(item.skip_periods)
    for (const [period, day] of itemSchedule(item, null, after, capDay)) {
      if (!skipped.has(period)) send(items, dayNumber(item.roll === 'none' ? day : roll(day, item.roll)), item.amount_minor, [occurrenceId(item.id, period)])
    }
  }

  const offers = new Map<number, Sending>()
  for (const o of extra?.offers ?? []) {
    const at = dayNumber(o.day)
    if (at < today || at > end) throw new RangeError(`Extra offered to '${loan.id}' on ${o.day}, outside the walk`)
    send(offers, at, o.amount_minor, o.occurrence_ids)
  }
  for (const [month, found] of extra?.months ?? []) {
    const mi = monthIndex(month)
    const at = Math.max(dayNumber(dayOfMonth(mi, payDay)), today)
    if (mi >= thisMonth && at <= end) send(offers, at, found.amount_minor, found.occurrence_ids)
  }

  const days = [...new Set([today, ...dueDays, ...credits.map((c) => c.at), ...items.keys(), ...offers.keys()])].sort((a, b) => a - b)
  const payments: LoanPayment[] = []
  const moves: LoanMove[] = []
  const passedOn: ExtraOffer[] = []
  const short: { row: LoanPayment; left: number }[] = []
  let bal = loan.opening_balance_minor
  let [c, d, owedToday, interestIn, interestAfter] = [0, 0, 0, 0, 0]
  let [started, owing] = [false, false]
  let clearedOn: number | null = null
  const post = (id: string, kind: LoanMove['kind'], date: string, amount: number, overdue: boolean, ids: readonly string[], afterHorizon: boolean) => {
    moves.push({ id, kind, order: 4, date, account_id: loan.id, from_account_id: kind === 'interest' ? null : funder, amount_minor: amount, overdue, occurrence_ids: ids, after_horizon: afterHorizon })
  }
  // A model payment, never past what is owed at that point of the day.
  const pay = (id: string, date: string, wanted: number, overdue: boolean, ids: readonly string[], afterHorizon: boolean): number => {
    const amount = Math.min(wanted, Math.max(0, 0 - bal))
    if (amount <= 0) return 0
    bal += landed(amount)
    post(id, 'payment', date, amount, overdue, ids, afterHorizon)
    return amount
  }

  for (const t of days) {
    if (!started && t >= today) [started, owing] = [true, bal < 0]
    if (t > end && (!owing || 0 - bal > LARGEST_OWED)) break
    const day = dayFromNumber(t)
    const walked = t <= end
    let row: LoanPayment | null = null
    let left = 0
    // Interest first, on what was owed when the day began, so a payment made early in its window changes nothing.
    if (dueDays[d] === t) {
      const base = 0 - bal + (early[d] ?? 0)
      const interest = base > 0 ? scaleMinor(base, rate, 'half_up', 12) : 0
      bal -= interest
      const due = Math.max(0, Math.min(scheduled, base + interest))
      const paid = (counted[d] ?? 0) + ((counted[d] ?? 0) < due ? (late[d] ?? 0) : 0)
      left = Math.max(0, due - paid)
      row = { on: day, interest_minor: interest, due_minor: due, paid_minor: paid, model_minor: 0, overdue: false, owed_after_minor: 0, after_horizon: !walked }
      if (interest > 0) post(`interest:${loan.id}:${day}`, 'interest', t < today ? asOf : day, -interest, false, [], !walked)
      if (t >= today && walked) interestIn += interest
      if (!walked) interestAfter += interest
      // A payment day this month that passed short is paid on as_of, overdue; earlier months are history.
      if (t < today && left > 0 && monthIndex(day) === thisMonth) short.push({ row, left })
      d++
    }
    while (c < credits.length && credits[c]?.at === t) bal += credits[c++]?.amount ?? 0
    if (t === today) {
      owedToday = 0 - bal
      for (const s of short) {
        s.row.model_minor = pay(`payment:${loan.id}:${s.row.on}`, asOf, s.left, true, [], false)
        s.row.overdue = s.row.model_minor > 0
      }
    }
    if (row && t >= today && left > 0) row.model_minor = pay(`payment:${loan.id}:${day}`, day, left, false, [], !walked)
    const item = items.get(t)
    if (item) pay(`principal:${loan.id}:${day}`, day, netOf(item.amount_minor, conversion.rate, conversion.feePct), false, item.occurrence_ids, !walked)
    // Extra goes out after every payment that day; what the loan does not need goes on to the next debt.
    const offer = offers.get(t)
    if (offer) {
      const share = pay(`extra:${loan.id}:${day}`, day, netOf(offer.amount_minor, conversion.rate, conversion.feePct), false, offer.occurrence_ids, false)
      const rest = offer.amount_minor - (share > 0 ? grossFor(share, conversion.rate, conversion.feePct) : 0)
      if (rest > 0 && extra?.next) passedOn.push({ account_id: extra.next, from_account_id: funder, day, amount_minor: rest, occurrence_ids: offer.occurrence_ids })
    }
    if (row) {
      row.owed_after_minor = 0 - bal
      if (row.interest_minor > 0 || row.due_minor > 0 || row.paid_minor > 0) payments.push(row)
    }
    if (!started) continue
    if (bal < 0) [owing, clearedOn] = [true, null]
    else if (owing) [owing, clearedOn] = [false, t]
  }

  const payoff: LoanPayoff =
    bal < 0 ? { on: null, month: null, after_horizon: true } : clearedOn === null ? { on: null, month: null, after_horizon: false } : { on: dayFromNumber(clearedOn), month: dayFromNumber(clearedOn).slice(0, 7), after_horizon: clearedOn > end }
  for (const p of payments) Object.freeze(p)
  for (const m of moves) Object.freeze(m)
  return Object.freeze({
    account_id: loan.id,
    owed_minor: owedToday,
    interest_minor: interestIn,
    interest_after_horizon_minor: interestAfter,
    payments: Object.freeze(payments),
    moves: Object.freeze(moves.sort(byMove)),
    payoff: Object.freeze(payoff),
    passed_on: Object.freeze(passedOn.map((o) => Object.freeze(o))),
  })
}

const summaries = new WeakSet<object>()

// The loan module for the walk: each loan's annuity schedule, with extra a loan does not need passed down its payoff order.
export const LOANS: LoanModule = Object.freeze({
  kind: 'loan' as const,
  walk(input: DebtInput): DebtOutput {
    const { snapshot } = input
    const until = input.days[input.days.length - 1] ?? snapshot.as_of
    const loans = new Map<string, LoanAccount>()
    for (const a of input.accounts) if (a.kind === 'loan') loans.set(a.id, a)
    const draws = new Map<string, EngineEvent[]>()
    for (const e of input.events) if (e.kind === 'draw') draws.set(e.account_id, [...(draws.get(e.account_id) ?? []), e])
    const offers = new Map<string, ExtraOffer[]>()
    const offer = (o: ExtraOffer) => offers.set(o.account_id, [...(offers.get(o.account_id) ?? []), o])
    for (const o of input.offers) if (loans.has(o.account_id)) offer(o)

    const schedules = new Map<string, LoanSchedule>()
    const overflow: ExtraOffer[] = []
    const run = (loan: LoanAccount, months: ReadonlyMap<string, MonthExtra> | null, next: string | null) => {
      const extra: LoanExtra = { months, offers: offers.get(loan.id) ?? [], next }
      const schedule = scheduleLoan(snapshot, loan, { until, draws: draws.get(loan.id) ?? [], conversion: input.conversion(loan.id), landed: (amount) => input.landed(loan.id, amount), extra })
      schedules.set(loan.id, schedule)
      for (const o of schedule.passed_on) {
        if (loans.has(o.account_id)) offer(o)
        else overflow.push(o)
      }
    }
    // A loan only takes from the debts before it, so walking each order front to back settles every offer between loans.
    const extras = extraByMonth(snapshot)
    for (const [funder, order] of payoffOrder(snapshot)) {
      order.forEach((id, k) => {
        const loan = loans.get(id)
        if (loan) run(loan, k === 0 ? (extras.get(funder) ?? null) : null, order[k + 1] ?? null)
      })
    }
    for (const loan of loans.values()) if (!schedules.has(loan.id)) run(loan, null, null)

    const out = new Map<string, LoanSchedule>()
    const moves: DebtMove[] = []
    for (const id of loans.keys()) {
      const schedule = schedules.get(id) as LoanSchedule
      out.set(id, schedule)
      for (const m of schedule.moves) if (!m.after_horizon) moves.push(m)
    }
    summaries.add(out)
    return { moves, summary: out, overflow }
  },
})

// Each loan's schedule from a walk that ran LOANS; null otherwise, never an empty stand-in.
export function loansOf(walk: Pick<Walk, 'loans'>): ReadonlyMap<string, LoanSchedule> | null {
  const found = walk.loans
  return typeof found === 'object' && found !== null && summaries.has(found) ? (found as ReadonlyMap<string, LoanSchedule>) : null
}

export interface NextLoanPayment extends LoanPayment {
  // The scheduled payment less what was counted toward it, so the Debts row and the Pay sheet show one figure.
  left_minor: number
}

// The scheduled payment still to make in full: an overdue one, else the first on or after as_of; null when none is left in the horizon.
export function nextLoanPayment(schedule: LoanSchedule, asOf: string): NextLoanPayment | null {
  const next = schedule.payments.find((p) => !p.after_horizon && p.paid_minor < p.due_minor && (p.overdue || p.on >= asOf))
  return next ? { ...next, left_minor: next.due_minor - next.paid_minor } : null
}
