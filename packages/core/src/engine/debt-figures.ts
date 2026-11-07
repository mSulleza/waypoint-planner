import { addMonths, monthKey } from '../dates'
import { netsByCurrency, type Money } from '../money'
import type { CardAccount } from '../schema/rows'
import { snapshotIndex, type Snapshot } from '../snapshot'
import { cardsOf, type CardStatement } from './cards'
import { loansOf } from './loans'
import { cutIn, slotCut } from './occurrences'
import type { PaymentFigures } from './payments'
import type { Walk } from './types'

export interface CardDebtFigures {
  account_id: string
  currency: string
  // The latest cut on or before as_of, entered or provisional.
  statement_id: string
  remaining_due_minor: number
  owed_minor: number
  // EMI × months left for every installment not yet billed.
  unbilled_installments_minor: number
  // Owed plus unbilled installments.
  total_debt_minor: number
  // The current cycle's payment, read from the walk; null when the walk does not pay it.
  pay_on: string | null
  payment: PaymentFigures | null
  // The latest entered statement's available credit is below zero; there is no limit field, so nothing else decides it.
  over_limit: boolean
  available_credit_minor: number | null
}

export interface LoanDebtFigures {
  account_id: string
  currency: string
  // The live balance from the loan schedule: opening walked through monthly interest and every row up to as_of.
  owed_minor: number
  total_debt_minor: number
}

export interface DebtFigures {
  cards: readonly CardDebtFigures[]
  loans: readonly LoanDebtFigures[]
  // Owed on every card, unbilled installments and loan balances, one figure per currency.
  total_debt: readonly Money[]
}

// A milestone is the month after the last month something is owed: the final clear, never the first zero.
export interface Milestone {
  // null while the last month owed is not known (carry in the horizon's last month, or a loan the payoff cap does not clear), or when nothing was owed from the current cycle on.
  month: string | null
  last_owed_month: string | null
  // The month falls after the horizon end, or is not known.
  after_horizon: boolean
}

export interface DebtMilestones {
  // No statement carries an unpaid part of the one before it: no more revolving interest.
  revolving_cleared: Milestone
  // No carry, no installment and no loan balance; installments usually run past revolving cleared.
  debt_free: Milestone
}

function replays(walk: Walk) {
  const found = cardsOf(walk)
  if (!found) throw new RangeError('Debt figures need a walk that ran the card module')
  return found
}

function schedules(walk: Walk) {
  const found = loansOf(walk)
  if (!found) throw new RangeError('Debt figures need a walk that ran the loan module')
  return found
}

const currentOf = (statements: readonly CardStatement[], id: string): CardStatement => {
  const found = statements.find((s) => s.id === id)
  if (!found) throw new Error(`The card replay lost its current statement '${id}'`)
  return found
}

// Installments dated on or before this day are on the statement: its cut, the cut-day cut it stands for, or the opening day.
const billedThrough = (card: CardAccount, s: CardStatement): string => {
  if (s.source === 'opening') return s.cut_date
  const slot = slotCut(card.terms.cut_day, s.cut_date)
  return slot > s.cut_date ? slot : s.cut_date
}

export interface InstallmentProgress {
  plan_item_id: string
  // What it bills each month, in the card's currency.
  amount_minor: number
  // Months billed through the card's current statement, of every month it bills; a skipped month counts in neither.
  billed: number
  total: number
  first_month: string
  last_month: string
  // The amount times the months not yet billed.
  unbilled_minor: number
}

function installmentsOf(snapshot: Snapshot, card: CardAccount, through: string): InstallmentProgress[] {
  const out: InstallmentProgress[] = []
  for (const item of snapshot.doc.plan_items) {
    if (item.kind !== 'installment' || item.from_account_id !== card.id || item.confidence === 'upside' || item.ends_on === null) continue
    const skipped = new Set(item.skip_periods)
    let billed = 0
    let total = 0
    for (let month = item.starts_on; month <= item.ends_on; month = addMonths(month, 1)) {
      if (skipped.has(month)) continue
      total++
      if (cutIn(card.terms.cut_day, month) <= through) billed++
    }
    out.push({ plan_item_id: item.id, amount_minor: item.amount_minor, billed, total, first_month: monthKey(item.starts_on), last_month: monthKey(item.ends_on), unbilled_minor: (total - billed) * item.amount_minor })
  }
  return out
}

const unbilledInstallments = (snapshot: Snapshot, card: CardAccount, through: string) => installmentsOf(snapshot, card, through).reduce((sum, i) => sum + i.unbilled_minor, 0)

// A card's installments as n of N against its current statement: those still to bill and those whose last month that statement billed, by first month.
export function installmentProgress(snapshot: Snapshot, walk: Walk, cardId: string): InstallmentProgress[] {
  const card = snapshotIndex(snapshot).accounts.get(cardId)
  if (card?.kind !== 'credit_card') throw new RangeError(`'${cardId}' is not a card in the snapshot`)
  const replay = replays(walk).get(cardId)
  if (!replay) throw new Error(`The walk has no replay for card '${cardId}'`)
  const current = currentOf(replay.statements, replay.current_id)
  const month = current.source === 'opening' ? monthKey(current.cut_date) : monthKey(slotCut(card.terms.cut_day, current.cut_date))
  return installmentsOf(snapshot, card, billedThrough(card, current))
    .filter((i) => i.last_month >= month)
    .sort((a, b) => (a.first_month < b.first_month ? -1 : a.first_month > b.first_month ? 1 : a.plan_item_id < b.plan_item_id ? -1 : 1))
}

// Remaining due, owed, unbilled installments, total debt and the over-limit flag per debt, from one walk with the card and loan modules.
export function debtFigures(snapshot: Snapshot, walk: Walk): DebtFigures {
  const index = snapshotIndex(snapshot)
  const cards: CardDebtFigures[] = []
  const loans: LoanDebtFigures[] = []
  const found = snapshot.doc.accounts.some((a) => a.kind === 'credit_card') ? replays(walk) : null
  const loanSchedules = snapshot.doc.accounts.some((a) => a.kind === 'loan') ? schedules(walk) : null
  for (const account of snapshot.doc.accounts) {
    if (account.kind === 'loan') {
      const schedule = loanSchedules?.get(account.id)
      if (!schedule) throw new Error(`The walk has no schedule for loan '${account.id}'`)
      loans.push({ account_id: account.id, currency: account.currency, owed_minor: schedule.owed_minor, total_debt_minor: schedule.owed_minor })
    }
    if (account.kind !== 'credit_card') continue
    const replay = found?.get(account.id)
    if (!replay) throw new Error(`The walk has no replay for card '${account.id}'`)
    const current = currentOf(replay.statements, replay.current_id)
    const unbilled = unbilledInstallments(snapshot, account, billedThrough(account, current))
    const latest = (index.statementsByAccount.get(account.id) ?? []).filter((s) => s.cut_date <= snapshot.as_of).at(-1)
    const available = latest?.available_credit_minor ?? null
    cards.push({
      account_id: account.id,
      currency: account.currency,
      statement_id: current.id,
      remaining_due_minor: replay.remaining_due_minor,
      owed_minor: replay.owed_minor,
      unbilled_installments_minor: unbilled,
      total_debt_minor: replay.owed_minor + unbilled,
      pay_on: current.pay_on,
      payment: current.payment,
      over_limit: available !== null && available < 0,
      available_credit_minor: available,
    })
  }
  // A closed account is left out of totals (schema note on archived_at), though the walk still carries it.
  const open = new Set(snapshot.doc.accounts.filter((a) => a.archived_at === null).map((a) => a.id))
  const total = netsByCurrency([...cards, ...loans].filter((d) => open.has(d.account_id)).map((d) => ({ minor: d.total_debt_minor, currency: d.currency })))
  return { cards, loans, total_debt: total }
}

const later = (a: string | null, b: string | null) => (a === null || (b !== null && b > a) ? b : a)

function milestone(owed: ReadonlySet<string>, known: string | null, unknown: boolean, lastWalked: string): Milestone {
  const last = later([...owed].sort().at(-1) ?? null, known)
  if (unknown) return { month: null, last_owed_month: last, after_horizon: true }
  if (last === null) return { month: null, last_owed_month: null, after_horizon: false }
  const month = monthKey(addMonths(`${last}-01`, 1))
  return { month, last_owed_month: last, after_horizon: month > lastWalked }
}

// What one debt owes month by month from its current cycle on.
interface Owing {
  // Months whose cut carries an unpaid part of the statement before it.
  carried: Set<string>
  // Months with carry, an installment billed, or a loan owed at the month's last walked day.
  owed: Set<string>
  // The last month owed when it falls past the walked months: an installment's last month, or the month before a loan's payoff.
  known: string | null
  // Owed at the horizon end with no known end.
  unknown: boolean
}

function owings(snapshot: Snapshot, walk: Walk, lastWalked: string): Map<string, Owing> {
  const out = new Map<string, Owing>()
  const found = snapshot.doc.accounts.some((a) => a.kind === 'credit_card') ? replays(walk) : null
  const loanSchedules = loansOf(walk)
  for (const account of snapshot.doc.accounts) {
    // A closed debt is left out, as total debt leaves it out, so no milestone names a month its rows do not explain.
    if (account.archived_at !== null) continue
    const o: Owing = { carried: new Set(), owed: new Set(), known: null, unknown: false }
    if (account.kind === 'credit_card') {
      const replay = found?.get(account.id)
      if (!replay) throw new Error(`The walk has no replay for card '${account.id}'`)
      const from = currentOf(replay.statements, replay.current_id).cut_date
      for (const s of replay.statements) {
        if (s.cut_date < from) continue
        const month = monthKey(s.cut_date)
        if ((s.carry_minor ?? 0) > 0) o.carried.add(month)
        if ((s.carry_minor ?? 0) > 0 || s.installments_minor > 0) o.owed.add(month)
      }
      for (const item of snapshot.doc.plan_items) {
        const last = item.kind === 'installment' && item.from_account_id === account.id && item.confidence !== 'upside' && item.ends_on !== null ? monthKey(item.ends_on) : null
        if (last !== null && last > lastWalked) o.known = later(o.known, last)
      }
      o.unknown = o.carried.has(lastWalked)
    } else if (account.kind === 'loan') {
      const balances = walk.balances.get(account.id)
      if (!balances) throw new Error(`The walk has no balances for loan '${account.id}'`)
      // A month is owed when its last walked day ends with the loan below zero.
      walk.days.forEach((day, i) => {
        const next = walk.days[i + 1]
        if ((next === undefined || next.slice(0, 7) !== day.slice(0, 7)) && (balances[i] ?? 0) < 0) o.owed.add(day.slice(0, 7))
      })
      // Inside the horizon the walked balances are the schedule; past it, the payoff says when the loan clears.
      const payoff = loanSchedules?.get(account.id)?.payoff
      if (!payoff) o.unknown = o.owed.has(lastWalked)
      else if (payoff.after_horizon) {
        if (payoff.month === null) o.unknown = true
        else o.known = monthKey(addMonths(`${payoff.month}-01`, -1))
      }
    } else continue
    out.set(account.id, o)
  }
  return out
}

const lastWalkedOf = (walk: Walk) => walk.months[walk.months.length - 1] ?? monthKey(walk.as_of)

// Revolving cleared and debt-free from one walk, both the month after the last month owed, so a zero that comes back is never the clear; past the horizon, installments end with their last month and a loan with its payoff.
export function debtMilestones(snapshot: Snapshot, walk: Walk): DebtMilestones {
  const lastWalked = lastWalkedOf(walk)
  const carried = new Set<string>()
  const owed = new Set<string>()
  let known: string | null = null
  let unknown = false
  for (const o of owings(snapshot, walk, lastWalked).values()) {
    for (const month of o.carried) carried.add(month)
    for (const month of o.owed) owed.add(month)
    known = later(known, o.known)
    unknown ||= o.unknown
  }
  return {
    revolving_cleared: milestone(carried, null, carried.has(lastWalked), lastWalked),
    debt_free: milestone(owed, known, unknown, lastWalked),
  }
}

// Each debt's payoff month by debt-free's own rule, so the latest of them is the household's debt-free month: null with after_horizon false when the debt carries nothing from its current cycle on.
export function debtPayoffs(snapshot: Snapshot, walk: Walk): ReadonlyMap<string, Milestone> {
  const lastWalked = lastWalkedOf(walk)
  const out = new Map<string, Milestone>()
  for (const [id, o] of owings(snapshot, walk, lastWalked)) out.set(id, milestone(o.owed, o.known, o.unknown, lastWalked))
  return out
}

export interface HorizonDebt {
  account_id: string
  currency: string
  // A card's last statement in the walk, less what posted on the card after its cut; a loan's walked balance. Positive while owed.
  owed_minor: number
  // A card's installments for months after the walk.
  unbilled_installments_minor: number
  total_debt_minor: number
}

// What every debt owes at the end of the horizon's last day, from the statement model and the loan schedule rather than the card's balance array.
export function horizonDebt(snapshot: Snapshot, walk: Walk): HorizonDebt[] {
  return debtOn(snapshot, walk, walk.days.length - 1)
}

// What every debt owes at the end of walked day i: a card's latest statement by then less what posted after its cut, plus installments still to bill; a loan's walked balance.
export function debtOn(snapshot: Snapshot, walk: Walk, i: number): HorizonDebt[] {
  if (i < 0 || i >= walk.days.length) throw new RangeError(`Day ${i} is outside the walk's ${walk.days.length} days`)
  const day = walk.days[i] ?? walk.as_of
  const out: HorizonDebt[] = []
  const found = snapshot.doc.accounts.some((a) => a.kind === 'credit_card') ? replays(walk) : null
  // A loan's balance array holds its interest only when the walk ran the loan module.
  if (snapshot.doc.accounts.some((a) => a.kind === 'loan')) schedules(walk)
  for (const account of snapshot.doc.accounts) {
    if (account.kind === 'cash') continue
    const balances = walk.balances.get(account.id)
    if (!balances) throw new Error(`The walk has no balances for '${account.id}'`)
    if (account.kind === 'loan') {
      const owed = 0 - (balances[i] ?? 0)
      out.push({ account_id: account.id, currency: account.currency, owed_minor: owed, unbilled_installments_minor: 0, total_debt_minor: owed })
      continue
    }
    const replay = found?.get(account.id)
    if (!replay) throw new Error(`The walk has no replay for card '${account.id}'`)
    const last = replay.statements.filter((s) => s.cut_date <= day).at(-1)
    const cut = last ? walk.days.indexOf(last.cut_date) : -1
    // Everything after the cut is in the card's balance array exactly as the replay counts it, so only the statement is taken from the model; a cut before today counts from today's owed.
    const statement = last && cut >= 0 ? last : currentOf(replay.statements, replay.current_id)
    const owed = last && cut >= 0 ? last.total_due_minor - ((balances[i] ?? 0) - (balances[cut] ?? 0)) : replay.owed_minor - ((balances[i] ?? 0) - (balances[0] ?? 0))
    const unbilled = unbilledInstallments(snapshot, account, billedThrough(account, statement))
    out.push({ account_id: account.id, currency: account.currency, owed_minor: owed, unbilled_installments_minor: unbilled, total_debt_minor: owed + unbilled })
  }
  return out
}
