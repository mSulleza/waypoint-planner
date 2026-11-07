import { addDays, dayFromNumber, dayNumber, daysInMonth, rollDayNumber } from '../dates'
import { grossFor, netOf, scaleMinor } from '../money'
import type { CardAccount, Statement } from '../schema/rows'
import type { CardTerms } from '../schema/terms'
import { snapshotIndex, type Snapshot } from '../snapshot'
import type { CardModule, Conversion, DebtInput, DebtMove, DebtOutput, ExtraOffer } from './debts'
import { addShares, expandPlan } from './events'
import { slotCut } from './occurrences'
import { cycleItems, paymentBase, paymentFigures, payLeft, type PaymentFigures } from './payments'
import { extraByMonth, payoffOrder, type MonthExtra } from './payoff'
import type { EngineEvent, ExpandedPlan, Occurrence, Walk } from './types'

export type StatementSource = 'entered' | 'opening' | 'simulated'

// One cycle with the printed identity: total = previous − payments and credits + charges + installments + interest + fees.
export interface CycleFigures {
  previous_balance_minor: number
  payments_and_credits_minor: number
  charges_minor: number
  installments_minor: number
  interest_minor: number
  fees_minor: number
  total_due_minor: number
  minimum_due_minor: number
}

export interface CardStatement {
  // The entered statement's id, `<card>:opening` for the opening balance, or `<card>:<cut_date>` for a simulated cut.
  id: string
  account_id: string
  source: StatementSource
  // A simulated cut before as_of: no statement was entered for it.
  provisional: boolean
  cut_date: string
  due_date: string
  total_due_minor: number
  minimum_due_minor: number
  // Billed at this cut: printed on a checked statement, else the plan's.
  installments_minor: number
  // The previous statement's unpaid part at this cut, never below zero; null when no cycle was replayed to it.
  carry_minor: number | null
  // The total minus the installments billed in it.
  revolving_minor: number
  // The previous statement was paid in full by its due date, so the cycle bears no interest; null when no cycle was replayed to it.
  grace: boolean | null
  // The statement this cycle was built from; null for the one the replay starts from.
  previous_id: string | null
  // What the model builds for this cycle, which a simulated statement is. Null for the statement the replay starts from.
  model: CycleFigures | null
  // Modelled minus printed interest; null unless the statement prints its interest and its cycle follows another entered statement.
  interest_variance_minor: number | null
  // The day the walk pays it from the funded-from account; null for history and for a statement a later cut on or before as_of took over.
  pay_on: string | null
  // What that payment put on the card.
  paid_minor: number
  // The payment figures from its pay day, brought up to date by extra offered later in the cycle; null when the walk does not pay it.
  payment: PaymentFigures | null
}

export interface CardReplay {
  account_id: string
  // The latest entered statement on or before as_of, or the opening balance.
  anchor_id: string
  // The latest cut on or before as_of: the anchor, or a provisional cut after it.
  current_id: string
  // Every cut replayed, in cut order: from the entered statement before the anchor, else the anchor, else the opening balance.
  statements: readonly CardStatement[]
  // The current total minus every positive card row after its cut; below zero is a credit the next statement absorbs.
  remaining_due_minor: number
  // Remaining due plus every charge row after the cut.
  owed_minor: number
  moves: readonly DebtMove[]
  // Extra for debts this card did not need, passed on the same day to the next debt in payoff order.
  passed_on: readonly ExtraOffer[]
}

export interface PayContext {
  card: CardAccount
  statement: CardStatement
  pay_on: string
  // Since the statement's cut, through the pay day's spending: card charges, and credits that are not payments.
  charges_minor: number
  credits_minor: number
  // Payments since the cut by their card leg: recorded ones up to the next cut, in transit included, and the model's so far.
  paid_minor: number
  // Transfer items into the card for the cut's month, and its share of extra for debts so far, in the card's currency.
  items_minor: number
  extra_minor: number
}

// What the card should receive on the pay day; 0 pays nothing.
export type CardPayer = (context: PayContext) => number

// Month index y × 12 + m − 1 of a checked date.
const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1

// Day `day` of month index `mi`, clamped to the month end; only days past the 28th parse.
function dayOfMonth(mi: number, day: number): string {
  const ym = `${String(Math.floor(mi / 12)).padStart(4, '0')}-${String((mi % 12) + 1).padStart(2, '0')}`
  return `${ym}-${String(day <= 28 ? day : Math.min(day, daysInMonth(ym))).padStart(2, '0')}`
}

// The first cut by cut day strictly after a checked date.
function cutAfter(cutDay: number, day: string): string {
  const mi = monthIndex(day)
  const cut = dayOfMonth(mi, cutDay)
  return cut > day ? cut : dayOfMonth(mi + 1, cutDay)
}

function dueOn(terms: CardTerms, cut: string): string {
  const c = dayNumber(cut)
  let due: number
  if ('days_after_cut' in terms.due) due = c + terms.due.days_after_cut
  else {
    const mi = monthIndex(cut)
    const same = dayOfMonth(mi, terms.due.day_of_month)
    due = dayNumber(same > cut ? same : dayOfMonth(mi + 1, terms.due.day_of_month))
  }
  return dayFromNumber(Math.max(c, rollDayNumber(due, terms.due_roll)))
}

// The first due day after the cut by the card's due rule, rolled, never before the cut.
export function dueDate(terms: CardTerms, cut: string): string {
  return dueOn(terms, addDays(cut, 0))
}

// max(floor, pct × total + add-ons), rounded by the card's rule, capped at the total, and 0 when nothing is owed.
export function minimumDue(terms: CardTerms, total: number, parts: Pick<CycleFigures, 'installments_minor' | 'interest_minor' | 'fees_minor'>): number {
  if (total <= 0) return 0
  const m = terms.minimum
  const addOns = (m.add_installments ? parts.installments_minor : 0) + (m.add_interest ? parts.interest_minor : 0) + (m.add_fees ? parts.fees_minor : 0)
  return Math.min(total, Math.max(m.floor_minor, scaleMinor(total, m.pct, m.rounding) + addOns))
}

// rate ÷ day_count per day on the summed daily balances, rounded half up once; a monthly rate over 30 days is the 30/360 convention.
export function cycleInterest(interest: CardTerms['interest'], balanceDays: number): number {
  if (balanceDays <= 0) return 0
  const perYear = interest.period === 'month' ? 12 : 1
  return scaleMinor(balanceDays * perYear, interest.rate, 'half_up', interest.day_count === 30 ? 360 : interest.day_count)
}

export interface ReplayOptions {
  // Entered statements in cut order, all on or before as_of for the walk; the last is the anchor.
  entered: readonly Statement[]
  // The last day replayed.
  until: string
  // The card's plan events after the anchor (card bills, allowances, draws); null replays recorded rows and installments only.
  events: readonly EngineEvent[] | null
  // Pays the anchor or the provisional cut after it, then every later cut; null pays nothing.
  payer: CardPayer | null
  // From the funded-from account to the card: transfer items convert at it; the bare amount by default.
  conversion?: Conversion
  // What a payment puts on the card after the walk grosses it up and converts it; by default what `conversion` lands.
  landed?: (amount: number) => number
  // Extra for debts this card may take; none by default.
  extra?: CardExtra
}

export interface CardExtra {
  // The funding account's extra by month, offered on the pay day of the cycle cut in that month when this card comes first in its payoff order.
  months: ReadonlyMap<string, MonthExtra> | null
  // Offers from the debt before it in payoff order.
  offers: readonly ExtraOffer[]
  // Where what this card does not need goes; null leaves it in cash.
  next: string | null
}

interface Slot {
  cut: string
  // The later of the cut and the cut-day cut it stands for: installments dated up to it bill here.
  through: string
  entered: Statement | null
}

// A statement's payment: the parts known at its cut, the extra it has taken and what the model paid in its window.
interface Cycle {
  statement: CardStatement
  base: number
  items: number
  extra: number
  // Items that count, then extra occurrences taken.
  ids: string[]
  // The cycle's month: the cut's, or for the opening balance the month before the first cut after it.
  month: string
  offered: boolean
  // The window as day indexes: its first day and its next cut, which may lie past the replay.
  from: number
  to: number
  // What the model's payments and extra put on the card in the window.
  paid: number
}

interface Pending {
  cycle: Cycle
  at: number
  overdue: boolean
}

const installmentLists = new WeakMap<ExpandedPlan, Map<string, Occurrence[]>>()

// Each card's unskipped installment occurrences in date order, once per plan.
function installmentsOf(plan: ExpandedPlan, cardId: string): readonly Occurrence[] {
  let byCard = installmentLists.get(plan)
  if (!byCard) {
    byCard = new Map()
    for (const o of plan.occurrences) {
      if (o.flow !== 'installment' || o.skipped) continue
      const list = byCard.get(o.account_id)
      if (list) list.push(o)
      else byCard.set(o.account_id, [o])
    }
    installmentLists.set(plan, byCard)
  }
  return byCard.get(cardId) ?? []
}

const monthKeyOf = (mi: number) => `${String(Math.floor(mi / 12)).padStart(4, '0')}-${String((mi % 12) + 1).padStart(2, '0')}`

const isChecked = (s: Statement) => s.previous_balance_minor !== null && s.payments_and_credits_minor !== null && s.installments_minor !== null

const byMove = (a: DebtMove, b: DebtMove) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// Walks one card from the statement before its anchor to `until` (spec §6.4): each cut builds a statement that balances, entered statements replace the model, and the payer pays from the anchor on.
export function replayCard(snapshot: Snapshot, card: CardAccount, options: ReplayOptions): CardReplay {
  const asOf = snapshot.as_of
  const terms = card.terms
  const cutDay = terms.cut_day
  const index = snapshotIndex(snapshot)
  const billing = installmentsOf(expandPlan(snapshot), card.id)
  const { entered, until, payer } = options
  const conversion = options.conversion ?? { rate: 1, feePct: 0 }
  const landed = options.landed ?? ((amount: number) => netOf(grossFor(amount, conversion.rate, conversion.feePct), conversion.rate, conversion.feePct))
  const anchor = entered.at(-1) ?? null
  const anchorCut = anchor?.cut_date ?? card.opening_date

  const planInstallments = (after: string, through: string): number => {
    let sum = 0
    for (const o of billing) if (o.date > after && o.date <= through) sum += o.amount_minor
    return sum
  }
  const fromEntered = (s: Statement, model: CycleFigures | null, carry: number | null, grace: boolean | null, previous: CardStatement | null, planned: number): CardStatement => {
    const installments = s.installments_minor ?? planned
    return {
      id: s.id,
      account_id: card.id,
      source: 'entered',
      provisional: false,
      cut_date: s.cut_date,
      due_date: s.due_date,
      total_due_minor: s.total_due_minor,
      minimum_due_minor: s.minimum_due_minor,
      installments_minor: installments,
      carry_minor: isChecked(s) ? Math.max(0, (s.previous_balance_minor ?? 0) - (s.payments_and_credits_minor ?? 0)) : carry,
      revolving_minor: s.total_due_minor - installments,
      grace,
      previous_id: previous?.id ?? null,
      model,
      // Only a printed previous balance gives the model a real starting point.
      interest_variance_minor: model && s.interest_minor !== null && previous?.source === 'entered' ? model.interest_minor - s.interest_minor : null,
      pay_on: null,
      paid_minor: 0,
      payment: null,
    }
  }

  // The replay starts at the entered statement before the anchor, so the anchor's own cycle is modelled; the opening balance stands in for none.
  const startEntered = entered.length >= 2 ? entered[entered.length - 2] : entered[0]
  let start: CardStatement
  let startSlot: Slot
  let firstDay: string
  if (startEntered) {
    const covers = slotCut(cutDay, startEntered.cut_date)
    startSlot = { cut: startEntered.cut_date, through: covers > startEntered.cut_date ? covers : startEntered.cut_date, entered: startEntered }
    start = fromEntered(startEntered, null, null, null, null, planInstallments(dayOfMonth(monthIndex(covers) - 1, cutDay), covers))
    firstDay = addDays(startEntered.cut_date, 1)
  } else {
    // 0 − rather than a sign flip, so a zero opening balance is not −0.
    const total = 0 - card.opening_balance_minor
    startSlot = { cut: card.opening_date, through: card.opening_date, entered: null }
    start = {
      id: `${card.id}:opening`,
      account_id: card.id,
      source: 'opening',
      provisional: false,
      cut_date: card.opening_date,
      due_date: dueOn(terms, card.opening_date),
      total_due_minor: total,
      minimum_due_minor: minimumDue(terms, total, { installments_minor: 0, interest_minor: 0, fees_minor: 0 }),
      installments_minor: 0,
      carry_minor: null,
      revolving_minor: total,
      grace: null,
      previous_id: null,
      model: null,
      interest_variance_minor: null,
      pay_on: null,
      paid_minor: 0,
      payment: null,
    }
    // A row on the opening day is after the opening balance, as the database counts it.
    firstDay = card.opening_date
  }

  const origin = dayNumber(firstDay)
  const at = (day: string) => dayNumber(day) - origin
  const n = Math.max(0, at(until) + 1)
  const credit = new Float64Array(n)
  const charge = new Float64Array(n)
  const recordedPay = new Float64Array(n)
  for (const t of index.rowsByAccount.get(card.id) ?? []) {
    if (t.posted_on < firstDay) continue
    if (t.posted_on > until) break
    const i = at(t.posted_on)
    if (t.amount_minor > 0) {
      credit[i] = (credit[i] ?? 0) + t.amount_minor
      if (t.kind === 'transfer') recordedPay[i] = (recordedPay[i] ?? 0) + t.amount_minor
    } else charge[i] = (charge[i] ?? 0) - t.amount_minor
  }
  for (const e of options.events ?? []) {
    if (e.account_id !== card.id || e.kind === 'row' || e.kind === 'installment' || e.date < firstDay || e.date > until) continue
    const i = at(e.date)
    if (e.kind === 'allowance') {
      addShares(e, charge, i, -1)
    } else if (e.amount_minor > 0) credit[i] = (credit[i] ?? 0) + e.amount_minor
    else charge[i] = (charge[i] ?? 0) - e.amount_minor
  }
  // Each credit by the day it starts to lower the interest base: the card's lag after its card-leg date.
  const lag = terms.interest.payment_effective_lag_days
  const lowers = new Float64Array(n + lag)
  const installments = billing.filter((o) => o.date > startSlot.through && o.date <= until)
  const paidBefore = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) paidBefore[i + 1] = (paidBefore[i] ?? 0) + (recordedPay[i] ?? 0)
  // Recorded payments in the cycle's whole window, in transit included.
  const recordedIn = (cycle: Cycle) => (paidBefore[Math.min(cycle.to, n - 1) + 1] ?? 0) - (paidBefore[cycle.from] ?? 0)

  let nextEntered = entered.findIndex((s) => s.cut_date > startSlot.cut)
  if (nextEntered < 0) nextEntered = entered.length
  // The next cut: an entered statement standing for the next cut-day cut or an earlier one, else that cut-day cut.
  const follow = (after: Slot): Slot => {
    const candidate = cutAfter(cutDay, after.through)
    const e = entered[nextEntered]
    if (e) {
      const covers = slotCut(cutDay, e.cut_date)
      if (covers <= candidate) {
        nextEntered++
        return { cut: e.cut_date, through: covers > e.cut_date ? covers : e.cut_date, entered: e }
      }
    }
    return { cut: candidate, through: candidate, entered: null }
  }

  const statements: CardStatement[] = [start]
  const moves: DebtMove[] = []
  const passedOn: ExtraOffer[] = []
  const pending: Pending[] = []
  const extra = payer === null ? undefined : options.extra
  // Offers on one day merge into one payment.
  const offers: { at: number; amount_minor: number; occurrence_ids: string[] }[] = []
  for (const o of [...(extra?.offers ?? [])].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    if (o.day < asOf || o.day > until) throw new RangeError(`Extra offered to '${card.id}' on ${o.day}, outside the walk`)
    const last = offers.at(-1)
    if (last?.at === at(o.day)) {
      last.amount_minor += o.amount_minor
      for (const id of o.occurrence_ids) if (!last.occurrence_ids.includes(id)) last.occurrence_ids.push(id)
    } else offers.push({ at: at(o.day), amount_minor: o.amount_minor, occurrence_ids: [...o.occurrence_ids] })
  }
  const cycleOf = (statement: CardStatement, slot: Slot, from: number, to: number): Cycle => {
    const month = monthKeyOf(monthIndex(cutAfter(cutDay, slot.through)) - 1)
    const items = cycleItems(snapshot, card.id, statement.cut_date, month, conversion)
    return { statement, base: paymentBase(terms.pay.mode, statement), items: items.amount_minor, extra: 0, ids: [...items.occurrence_ids], month, offered: false, from, to, paid: 0 }
  }
  // What the payer sees on day i: charges and credits since the cut, and the cycle's recorded and model payments.
  const contextOf = (cycle: Cycle, i: number, charges: number, credits: number): PayContext => ({
    card,
    statement: cycle.statement,
    pay_on: dayFromNumber(origin + i),
    charges_minor: charges,
    credits_minor: credits,
    paid_minor: recordedIn(cycle) + cycle.paid,
    items_minor: cycle.items,
    extra_minor: cycle.extra,
  })
  // The stored figures count recorded payments only, so left to pay is all the model sends in the cycle, whichever day the extra arrives.
  const figuresOf = (cycle: Cycle, context: PayContext) => paymentFigures({ ...context, paid_minor: recordedIn(cycle) })
  // Takes the share of `cash` sent from the funding account that fills the cycle's planned gross up to what it owes, and passes the rest on that day.
  const takeExtra = (cycle: Cycle, cap: number, cash: number, ids: readonly string[], i: number): number => {
    if (!extra || cash <= 0) return 0
    const need = Math.max(0, cap - (cycle.base + cycle.items + cycle.extra))
    const share = Math.min(need, netOf(cash, conversion.rate, conversion.feePct))
    if (share > 0) {
      cycle.extra += share
      for (const id of ids) if (!cycle.ids.includes(id)) cycle.ids.push(id)
    }
    const rest = cash - (share > 0 ? grossFor(share, conversion.rate, conversion.feePct) : 0)
    if (rest > 0 && extra.next !== null && card.funded_from_account_id !== null) {
      passedOn.push({ account_id: extra.next, from_account_id: card.funded_from_account_id, day: dayFromNumber(origin + i), amount_minor: rest, occurrence_ids: ids })
    }
    return share
  }
  const schedule = (cycle: Cycle) => {
    if (payer === null) return
    const statement = cycle.statement
    const raw = terms.pay.on === 'due_date' ? statement.due_date : dayFromNumber(dayNumber(statement.cut_date) + terms.pay.on.days_after_cut)
    // A pay day past the next cut pays on that cut day, before it cuts, so the next cycle never counts this payment; one that passed pays on as_of.
    const i = Math.max(Math.min(at(raw), cycle.to), at(asOf), cycle.from)
    if (i >= n) return
    statement.pay_on = dayFromNumber(origin + i)
    pending.push({ cycle, at: i, overdue: statement.due_date < asOf })
  }
  // A later cut on or before as_of takes over a statement's unpaid part, so only the latest one is paid.
  const payable = (slot: Slot, next: Slot) => slot.cut >= anchorCut && !(next.cut <= asOf && next.cut <= until)

  let prev = start
  let slot = follow(startSlot)
  let slotAt = at(slot.cut)
  let prevCycle = cycleOf(start, startSlot, 0, slotAt)
  if (payable(startSlot, slot)) schedule(prevCycle)
  let [credits, counted, charges, otherCredits, byDue, unpaidDays, balanceDays, nextInstallment, nextOffer] = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  let dueAt = at(prev.due_date)
  for (let i = 0; i < n; i++) {
    let money = credit[i] ?? 0
    const spent = charge[i] ?? 0
    // Credits that are not payments: refunds, drawdowns, adjustments and planned draws.
    const other = money - (recordedPay[i] ?? 0)
    charges += spent
    otherCredits += other
    // A pay day never passes the next cut, so a cycle paid today is the current one, with the running charges and credits since its cut.
    for (let k = 0; k < pending.length; ) {
      const p = pending[k] as Pending
      if (p.at !== i) {
        k++
        continue
      }
      pending.splice(k, 1)
      const { cycle } = p
      const statement = cycle.statement
      // Extra goes out after every base payment: the month's extra fills what the cycle owes beyond its base and items.
      const monthExtra = extra?.months?.get(cycle.month)
      if (monthExtra && !cycle.offered) {
        cycle.offered = true
        takeExtra(cycle, statement.total_due_minor + charges - otherCredits, monthExtra.amount_minor, monthExtra.occurrence_ids, i)
      }
      const context = contextOf(cycle, i, charges, otherCredits)
      statement.payment = figuresOf(cycle, context)
      const amount = payer?.(context) ?? 0
      if (!(Number.isSafeInteger(amount) && amount >= 0)) throw new RangeError(`A card payer must return whole minor units of at least 0, not ${amount}`)
      if (amount === 0) continue
      const got = landed(amount)
      money += got
      cycle.paid += got
      statement.paid_minor = got
      moves.push({ id: `payment:${card.id}:${statement.cut_date}`, kind: 'payment', order: 4, date: context.pay_on, account_id: card.id, from_account_id: card.funded_from_account_id, amount_minor: amount, overdue: p.overdue, occurrence_ids: [...cycle.ids] })
    }
    // Extra the debt before this one did not need lands as a payment since the current cut, after the day's own payments.
    while (offers[nextOffer]?.at === i) {
      const offer = offers[nextOffer++] as (typeof offers)[number]
      const before = paymentFigures(contextOf(prevCycle, i, charges, otherCredits)).left_to_pay_minor
      if (takeExtra(prevCycle, prev.total_due_minor + charges - otherCredits, offer.amount_minor, offer.occurrence_ids, i) === 0) continue
      // Only the rise in left to pay goes out: payments since the cut beyond the base already count toward the share, so the card never passes what it owes.
      const rise = paymentFigures(contextOf(prevCycle, i, charges, otherCredits)).left_to_pay_minor - before
      const day = dayFromNumber(origin + i)
      if (rise > 0) {
        const got = landed(rise)
        money += got
        prevCycle.paid += got
        moves.push({ id: `extra:${card.id}:${day}`, kind: 'payment', order: 4, date: day, account_id: card.id, from_account_id: card.funded_from_account_id, amount_minor: rise, overdue: false, occurrence_ids: offer.occurrence_ids })
      }
      // A statement already paid this cycle shows the extra it took since.
      if (prevCycle.statement.pay_on !== null) prevCycle.statement.payment = figuresOf(prevCycle, contextOf(prevCycle, i, charges, otherCredits))
    }
    credits += money
    lowers[i + lag] = (lowers[i + lag] ?? 0) + money
    counted += lowers[i] ?? 0
    if (i <= dueAt) byDue += money
    const unpaid = prev.total_due_minor - counted
    if (unpaid > 0) unpaidDays += unpaid
    if (unpaid + charges > 0) balanceDays += unpaid + charges
    if (i !== slotAt) continue

    let billed = 0
    while (nextInstallment < installments.length && (installments[nextInstallment]?.date ?? '') <= slot.through) billed += installments[nextInstallment++]?.amount_minor ?? 0
    const previous = prev.total_due_minor
    const grace = previous <= 0 || byDue >= previous
    const interest = grace ? 0 : cycleInterest(terms.interest, terms.interest.method === 'daily_on_unpaid' ? unpaidDays : balanceDays)
    const total = previous - credits + charges + billed + interest
    const model: CycleFigures = {
      previous_balance_minor: previous,
      payments_and_credits_minor: credits,
      charges_minor: charges,
      installments_minor: billed,
      interest_minor: interest,
      fees_minor: 0,
      total_due_minor: total,
      minimum_due_minor: minimumDue(terms, total, { installments_minor: billed, interest_minor: interest, fees_minor: 0 }),
    }
    const carry = Math.max(0, previous - credits)
    const statement: CardStatement = slot.entered
      ? fromEntered(slot.entered, model, carry, grace, prev, billed)
      : {
          id: `${card.id}:${slot.cut}`,
          account_id: card.id,
          source: 'simulated',
          provisional: slot.cut < asOf,
          cut_date: slot.cut,
          due_date: dueOn(terms, slot.cut),
          total_due_minor: total,
          minimum_due_minor: model.minimum_due_minor,
          installments_minor: billed,
          carry_minor: carry,
          revolving_minor: total - billed,
          grace,
          previous_id: prev.id,
          model,
          interest_variance_minor: null,
          pay_on: null,
          paid_minor: 0,
          payment: null,
        }
    statements.push(statement)
    // Interest on a cut before as_of posts on as_of, as the walk does with card events; an entered statement's interest is already in its total.
    if (!slot.entered && slot.cut > anchorCut && interest > 0) {
      moves.push({ id: `interest:${card.id}:${slot.cut}`, kind: 'interest', order: 5, date: slot.cut < asOf ? asOf : slot.cut, account_id: card.id, from_account_id: null, amount_minor: -interest, overdue: false, occurrence_ids: [] })
    }
    const next = follow(slot)
    const nextAt = at(next.cut)
    const cycle = cycleOf(statement, slot, i + 1, nextAt)
    if (payable(slot, next)) schedule(cycle)
    prev = statement
    prevCycle = cycle
    slot = next
    slotAt = nextAt
    dueAt = at(statement.due_date)
    // A credit still waiting at the cut is already in this statement, so it never lowers the next cycle's base.
    lowers.fill(0, i + 1, i + 1 + lag)
    ;[credits, counted, charges, otherCredits, byDue, unpaidDays, balanceDays] = [0, 0, 0, 0, 0, 0, 0]
  }

  let current = start
  for (const s of statements) if (s.cut_date <= asOf) current = s
  let [paidSince, chargedSince] = [0, 0]
  for (const t of index.rowsByAccount.get(card.id) ?? []) {
    if (current.source === 'opening' ? t.posted_on < current.cut_date : t.posted_on <= current.cut_date) continue
    if (t.amount_minor > 0) paidSince += t.amount_minor
    else chargedSince -= t.amount_minor
  }
  for (const s of statements) {
    if (s.model) Object.freeze(s.model)
    if (s.payment) Object.freeze(s.payment)
    Object.freeze(s)
  }
  for (const m of moves) Object.freeze(m)
  return Object.freeze({
    account_id: card.id,
    anchor_id: anchor?.id ?? start.id,
    current_id: current.id,
    statements: Object.freeze(statements),
    remaining_due_minor: current.total_due_minor - paidSince,
    owed_minor: current.total_due_minor - paidSince + chargedSince,
    moves: Object.freeze(moves.sort(byMove)),
    passed_on: Object.freeze(passedOn.map((o) => Object.freeze(o))),
  })
}

const summaries = new WeakSet<object>()

// The card module for the walk; `payer` sizes each payment, left to pay by default. Cards walk in payoff order, so extra a card does not need reaches the next debt.
export function cardModule(payer: CardPayer = payLeft): CardModule {
  return Object.freeze({
    kind: 'credit_card' as const,
    walk(input: DebtInput): DebtOutput {
      const { snapshot } = input
      const asOf = snapshot.as_of
      const index = snapshotIndex(snapshot)
      const until = input.days[input.days.length - 1] ?? asOf
      const eventsOf = new Map<string, EngineEvent[]>()
      for (const e of input.events) {
        const list = eventsOf.get(e.account_id)
        if (list) list.push(e)
        else eventsOf.set(e.account_id, [e])
      }
      const cards = new Map<string, CardAccount>()
      for (const a of input.accounts) if (a.kind === 'credit_card') cards.set(a.id, a)
      const offers = new Map<string, ExtraOffer[]>()
      const offer = (o: ExtraOffer) => offers.set(o.account_id, [...(offers.get(o.account_id) ?? []), o])
      for (const o of input.offers) if (cards.has(o.account_id)) offer(o)

      const replays = new Map<string, CardReplay>()
      const overflow: ExtraOffer[] = []
      const run = (card: CardAccount, months: ReadonlyMap<string, MonthExtra> | null, next: string | null) => {
        const entered = (index.statementsByAccount.get(card.id) ?? []).filter((s) => s.cut_date <= asOf)
        const extra: CardExtra = { months, offers: offers.get(card.id) ?? [], next }
        const replay = replayCard(snapshot, card, { entered, until, events: eventsOf.get(card.id) ?? [], payer, conversion: input.conversion(card.id), landed: (amount) => input.landed(card.id, amount), extra })
        replays.set(card.id, replay)
        for (const o of replay.passed_on) {
          if (cards.has(o.account_id)) offer(o)
          else overflow.push(o)
        }
      }
      // A card only takes from the debts before it, so walking each order front to back settles every offer.
      const extras = extraByMonth(snapshot)
      for (const [funder, order] of payoffOrder(snapshot)) {
        order.forEach((id, k) => {
          const card = cards.get(id)
          if (card) run(card, k === 0 ? (extras.get(funder) ?? null) : null, order[k + 1] ?? null)
        })
      }
      for (const card of cards.values()) if (!replays.has(card.id)) run(card, null, null)

      const out = new Map<string, CardReplay>()
      const moves: DebtMove[] = []
      for (const id of cards.keys()) {
        const replay = replays.get(id) as CardReplay
        out.set(id, replay)
        for (const m of replay.moves) moves.push(m)
      }
      summaries.add(out)
      return { moves, summary: out, overflow }
    },
  })
}

export const CARDS: CardModule = cardModule()

// Each card's replay from a walk that ran a card module made here; null otherwise, never an empty stand-in.
export function cardsOf(walk: Pick<Walk, 'cards'>): ReadonlyMap<string, CardReplay> | null {
  const found = walk.cards
  return typeof found === 'object' && found !== null && summaries.has(found) ? (found as ReadonlyMap<string, CardReplay>) : null
}
