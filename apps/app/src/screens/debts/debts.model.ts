import {
  addMonths,
  anchorStatement,
  cardsOf,
  convert,
  debtFigures,
  debtMilestones,
  debtOn,
  debtPayoffs,
  firstOfMonth,
  installmentProgress,
  loansOf,
  minorDigits,
  monthKey,
  nextLoanPayment,
  snapshotIndex,
  statementChecks,
  statementGap,
  textPart,
  toRatesPerEur,
  WARNING_WORDS,
  type Account,
  type CardDebtFigures,
  type CardReplay,
  type CardStatement,
  type Copy,
  type DebtFigures,
  type LoanAccount,
  type Milestone,
  type Money,
  type Snapshot,
  type Walk,
} from '@waypoint/core'
import { encodeLevers, extraPaymentLever, registry } from '@waypoint/core/compare'
import { NEW_ACCOUNT_ID } from '../../shell/url.model'
import { identityIndex, identityOf } from '../../ui/identity'
import { RECORD_PAYMENT, type TodayLink } from '../today/today.model'

// Spec §7 Debts and Debt detail: every figure is read from one walk with the card and loan modules (core runEngine); nothing here subtracts again.

// Compare's levers ride in the fragment, so its address is a string: an href object would put '#' in the query.
export type DebtLink = TodayLink | `/plan/compare#l=${string}` | { pathname: '/settings/account/[id]'; params: { id: string; kind: 'credit_card' } }

// The account editor on a new card; its kind picker also offers a loan.
export const ADD_DEBT: DebtLink = { pathname: '/settings/account/[id]', params: { id: NEW_ACCOUNT_ID, kind: 'credit_card' } }

export const REVOLVING_NOTE = 'Card balances paid in full'

// Try extra payments starts Compare at what the paying account has left over in its leanest month of the next year; with nothing left over, a tenth of the debts' minimum payments (an estimate the person changes there).
export const EXTRA_SHARE = 0.1
export const SPARE_MONTHS = 12

export const NEXT_CYCLES = 6

// A word with the status tone that colours its icon; null reads in text-2.
export interface Chip {
  text: 'Checked' | 'Total only' | 'Provisional' | 'Over limit'
  tone: 'positive' | 'caution' | 'negative' | null
}

export const CHIPS = {
  checked: { text: 'Checked', tone: 'positive' },
  total_only: { text: 'Total only', tone: null },
  provisional: { text: 'Provisional', tone: 'caution' },
  over_limit: { text: 'Over limit', tone: 'negative' },
} as const satisfies Record<string, Chip>

export interface StateWord {
  text: 'Paid' | 'Nothing due' | 'Overdue'
  tone: 'positive' | 'negative' | null
}

export interface Headline {
  // 'Debt-free by' before a month, 'Debt-free' before anything else.
  label: string
  value: Copy
  note: Copy | null
}

export interface NextPayment {
  // 'Next payment', or what an amount worked out from the opening balance stands for until a statement is entered.
  label: 'Next payment' | EstimateLabel
  minor: number
  currency: string
  // A card's due date or a loan's payment day.
  on: string
  overdue: boolean
  // A card's remaining due, shown beside left to pay when the two differ.
  remaining_minor: number | null
  // The current cycle needs nothing more, so this is a later statement's payment, as the plan makes it.
  after_cut: string | null
}

export interface DebtAction {
  label: typeof RECORD_PAYMENT | 'Enter statement'
  link: DebtLink
}

export interface DebtRow {
  account_id: string
  // The account's place in the account order, which picks its tile's colour on every screen.
  colour: number
  kind: 'credit_card' | 'loan'
  currency: string
  // Positive while owed; below zero is a credit.
  owed_minor: number
  chips: readonly Chip[]
  // A card's current statement: the latest cut on or before today.
  statement_cut: string | null
  // A loan's annual rate as a fraction: 0.0425 is 4.25%.
  annual_rate: number | null
  // The current cycle's state when it needs nothing more, and the due date of the payment it names.
  state: StateWord | null
  state_due: string | null
  next: NextPayment | null
  payoff: Copy
  // The latest entered statement's parts that differ, in the Statement sheet's words.
  warnings: readonly string[]
  action: DebtAction | null
  detail: DebtLink
}

export interface DebtsModel {
  headline: Headline
  // Only with a card.
  revolving: { value: Copy; note: Copy } | null
  total: readonly Money[]
  // A card has installments still to bill, which total debt counts and no row's owed shows.
  total_includes_installments: boolean
  // The cut dates the cards' figures stand on, oldest first.
  statement_cuts: readonly string[]
  debts: readonly DebtRow[]
  try_extra: DebtLink | null
}

const isDebt = (a: Account) => a.kind !== 'cash' && a.archived_at === null
const bySortOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The month after the last month owed; past the horizon it says so, and an unknown end says the projection ends first.
export function headline(m: Milestone, horizonMonth: string): Headline {
  if (m.month !== null) return { label: 'Debt-free by', value: [{ month: m.month }], note: m.after_horizon ? [textPart('After the projection, which ends in '), { month: horizonMonth }] : null }
  if (m.after_horizon) return { label: 'Debt-free', value: [textPart('Not by '), { month: horizonMonth }], note: [textPart('A balance is still owed when the projection ends.')] }
  return { label: 'Debt-free', value: [textPart('Now')], note: [textPart('No balance is carried, and no installment or loan is left.')] }
}

// Revolving cleared: its month, or this month while a payment that clears it is still open, since Now would read as done.
function revolving(m: Milestone, horizonMonth: string, asOf: string, open: readonly string[]): NonNullable<DebtsModel['revolving']> {
  const note: Copy = [textPart(REVOLVING_NOTE)]
  if (m.month !== null) return { value: [{ month: m.month }], note }
  if (m.after_horizon) return { value: [textPart('Not by '), { month: horizonMonth }], note }
  const last = [...open].sort().at(-1)
  if (last) return { value: [{ month: monthKey(asOf) }], note: [textPart(`${REVOLVING_NOTE} after the `), { date: last }, textPart(' payment')] }
  return { value: [textPart('Now')], note }
}

// The hero's headline on Debts and Plan alike: the debt-free month, with why it falls after the projection, or else how far off it is.
export function heroHeadline(m: Milestone, horizonMonth: string, minimum: Copy | null, snapshot: Snapshot): Headline {
  const debtFree = headline(m, horizonMonth)
  if (minimum) return { ...debtFree, note: minimum }
  const detail = debtFree.note === null ? debtFreeDetail(m, snapshot.as_of, snapshot.doc.household.payoff_order) : null
  return detail ? { ...debtFree, note: detail } : debtFree
}

// '17 months from now, costliest debt first': how far off the debt-free month is, and the order extra payments take.
export function debtFreeDetail(m: Milestone, asOf: string, order: 'avalanche' | 'list'): Copy | null {
  if (m.month === null || m.after_horizon) return null
  const [y0, m0] = [Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7))]
  const n = (Number(m.month.slice(0, 4)) - y0) * 12 + Number(m.month.slice(5, 7)) - m0
  const when = n <= 0 ? 'This month' : n === 1 ? 'Next month' : `${n} months from now`
  return [textPart(`${when}, ${order === 'avalanche' ? 'costliest debt first' : 'in the order of your list'}`)]
}

// One debt's payoff month by the household debt-free rule; a card that carries nothing is paid in full each cycle.
export function payoffCopy(m: Milestone, kind: 'credit_card' | 'loan', horizonMonth: string): Copy {
  if (m.month !== null) return m.after_horizon ? [textPart('Paid off by '), { month: m.month }, textPart(', after the projection')] : [textPart('Paid off by '), { month: m.month }]
  if (m.after_horizon) return [textPart('Not paid off by '), { month: horizonMonth }]
  return [textPart(kind === 'loan' ? 'Paid off' : 'Paid in full each cycle')]
}

export type EstimateLabel = 'Estimated minimum' | 'Estimated payment'

// A card with no statement yet pays from its opening balance by its preset's rules, so the amount is an estimate, not a printed figure.
export function estimateLabel(snapshot: Snapshot, s: CardStatement): EstimateLabel | null {
  if (s.source !== 'opening') return null
  const card = snapshotIndex(snapshot).accounts.get(s.account_id)
  const planned = (s.payment?.items_minor ?? 0) + (s.payment?.extra_minor ?? 0)
  return card?.kind === 'credit_card' && card.terms.pay.mode !== 'in_full' && planned === 0 ? 'Estimated minimum' : 'Estimated payment'
}

const currentOf = (replay: CardReplay): CardStatement => {
  const found = replay.statements.find((s) => s.id === replay.current_id)
  if (!found) throw new Error(`The replay of '${replay.account_id}' lost its current statement`)
  return found
}

// Checked or Total only for an entered statement, Total only for the opening balance, Provisional for a cut passed with none entered.
function statementChip(snapshot: Snapshot, s: CardStatement): Chip | null {
  if (s.source === 'opening') return CHIPS.total_only
  if (s.source === 'simulated') return s.provisional ? CHIPS.provisional : null
  const row = (snapshotIndex(snapshot).statementsByAccount.get(s.account_id) ?? []).find((r) => r.id === s.id)
  return row && statementGap(row) !== null ? CHIPS.checked : CHIPS.total_only
}

// The latest entered statement's parts that differ from the data, interest apart (it has its own line on Debt detail).
export function statementWarnings(snapshot: Snapshot, cardId: string) {
  const entered = anchorStatement(snapshot, cardId)
  if (!entered) return []
  const checks = statementChecks(snapshot, entered)
  return (['previous_balance', 'installments', 'payments_and_credits'] as const).flatMap((kind) => {
    const found = checks[kind]
    return found ? [{ kind, word: WARNING_WORDS[kind], statement_id: entered.id, cut_date: entered.cut_date, printed_minor: found.printed_minor, expected_minor: found.expected_minor, difference_minor: found.difference_minor }] : []
  })
}

const detailLink = (id: string): DebtLink => ({ pathname: '/debts/[accountId]', params: { accountId: id } })
const payLink = (id: string): DebtLink => ({ pathname: '/add', params: { mode: 'move', to: id } })
const statementLink = (id: string): DebtLink => ({ pathname: '/statement', params: { account: id } })

function cardRow(snapshot: Snapshot, figures: CardDebtFigures, replay: CardReplay, payoff: Milestone, horizonMonth: string): Omit<DebtRow, 'colour'> {
  const asOf = snapshot.as_of
  const current = currentOf(replay)
  const chips: Chip[] = []
  const chip = statementChip(snapshot, current)
  if (chip) chips.push(chip)
  if (figures.over_limit) chips.push(CHIPS.over_limit)
  const pay = figures.payment
  let next: NextPayment | null = null
  let state: StateWord | null = null
  let action: DebtAction | null = null
  if (current.provisional) action = { label: 'Enter statement', link: statementLink(figures.account_id) }
  else if (pay?.state === 'to_pay') {
    // Left to pay, never the remaining due: the walk sends it on the pay day (spec §6.4).
    const overdue = current.due_date < asOf
    next = { label: estimateLabel(snapshot, current) ?? 'Next payment', minor: pay.left_to_pay_minor, currency: figures.currency, on: current.due_date, overdue, remaining_minor: figures.remaining_due_minor !== pay.left_to_pay_minor ? figures.remaining_due_minor : null, after_cut: null }
    if (overdue) state = { text: 'Overdue', tone: 'negative' }
    action = { label: RECORD_PAYMENT, link: payLink(figures.account_id) }
  } else {
    state = pay?.state === 'paid' ? { text: 'Paid', tone: 'positive' } : { text: 'Nothing due', tone: null }
    const later = replay.statements.find((s) => s.cut_date > current.cut_date && s.payment?.state === 'to_pay')
    if (later?.payment) next = { label: 'Next payment', minor: later.payment.left_to_pay_minor, currency: figures.currency, on: later.due_date, overdue: false, remaining_minor: null, after_cut: later.cut_date }
  }
  return {
    account_id: figures.account_id,
    kind: 'credit_card',
    currency: figures.currency,
    owed_minor: figures.owed_minor,
    chips,
    statement_cut: current.cut_date,
    annual_rate: null,
    state,
    state_due: state?.text === 'Paid' ? current.due_date : null,
    next,
    payoff: payoffCopy(payoff, 'credit_card', horizonMonth),
    warnings: statementWarnings(snapshot, figures.account_id).map((w) => w.word),
    action,
    detail: detailLink(figures.account_id),
  }
}

function loanRow(snapshot: Snapshot, walk: Walk, loan: LoanAccount, owed: number, payoff: Milestone, horizonMonth: string): Omit<DebtRow, 'colour'> {
  const schedule = loansOf(walk)?.get(loan.id)
  const due = schedule ? nextLoanPayment(schedule, snapshot.as_of) : null
  return {
    account_id: loan.id,
    kind: 'loan',
    currency: loan.currency,
    owed_minor: owed,
    chips: [],
    statement_cut: null,
    annual_rate: loan.terms.annual_rate,
    state: due?.overdue ? { text: 'Overdue', tone: 'negative' } : null,
    state_due: null,
    next: due ? { label: 'Next payment', minor: due.left_minor, currency: loan.currency, on: due.on, overdue: due.overdue, remaining_minor: null, after_cut: null } : null,
    payoff: payoffCopy(payoff, 'loan', horizonMonth),
    warnings: [],
    action: owed > 0 ? { label: RECORD_PAYMENT, link: payLink(loan.id) } : null,
    detail: detailLink(loan.id),
  }
}

interface Rows {
  figures: DebtFigures
  payoffs: ReadonlyMap<string, Milestone>
  horizonMonth: string
  identity: ReadonlyMap<string, number>
}

function rowsOf(snapshot: Snapshot, walk: Walk): Rows {
  return { figures: debtFigures(snapshot, walk), payoffs: debtPayoffs(snapshot, walk), horizonMonth: monthKey(walk.horizon_end), identity: identityIndex(snapshot.doc.accounts) }
}

function debtRow(snapshot: Snapshot, walk: Walk, account: Account, rows: Rows): DebtRow | null {
  const row = rowOf(snapshot, walk, account, rows)
  return row ? { ...row, colour: identityOf(rows.identity, account.id) } : null
}

function rowOf(snapshot: Snapshot, walk: Walk, account: Account, { figures, payoffs, horizonMonth }: Rows): Omit<DebtRow, 'colour'> | null {
  const payoff = payoffs.get(account.id)
  if (!payoff) return null
  if (account.kind === 'credit_card') {
    const f = figures.cards.find((c) => c.account_id === account.id)
    const replay = cardsOf(walk)?.get(account.id)
    return f && replay ? cardRow(snapshot, f, replay, payoff, horizonMonth) : null
  }
  if (account.kind !== 'loan') return null
  const owed = figures.loans.find((l) => l.account_id === account.id)?.owed_minor
  return owed === undefined ? null : loanRow(snapshot, walk, account, owed, payoff, horizonMonth)
}

// Rounds down to 1, 2 or 5 times a power of ten, so the amount reads as a round figure in any currency.
export function roundFigure(minor: number): number {
  if (minor <= 0) return 0
  let power = 1
  while (power * 10 <= minor) power *= 10
  const lead = minor / power
  return (lead >= 5 ? 5 : lead >= 2 ? 2 : 1) * power
}

// Rounds down to two significant figures, so a spare 1,758.00 tries 1,700.00.
export function roundSpare(minor: number): number {
  if (minor <= 0) return 0
  let power = 1
  while (power * 100 <= minor) power *= 10
  return Math.floor(minor / power) * power
}

// The least a cash account gains in any of the next SPARE_MONTHS full months, after everything the plan already pays from it; 0 when a month loses.
export function spareMonthly(walk: Walk, accountId: string): number {
  const months = walk.figures.get(accountId)?.slice(1, SPARE_MONTHS + 1) ?? []
  if (months.length === 0) return 0
  return Math.max(0, Math.min(...months.map((m) => m.closing_minor - m.opening_minor)))
}

// Compare with one monthly extra for debts from next month, out of the first cash account that pays debts: what it has spare each month, rounded, or a tenth of the minimum payments it makes; at least one whole unit.
export function tryExtraLink(snapshot: Snapshot, walk: Walk, figures: DebtFigures = debtFigures(snapshot, walk)): DebtLink | null {
  const funder = registry(snapshot).extra_payment?.from_account_ids[0]
  const index = snapshotIndex(snapshot)
  const from = funder === undefined ? undefined : index.accounts.get(funder)
  if (!from) return null
  const rates = toRatesPerEur(snapshot.rates)
  const replays = cardsOf(walk)
  let minimums = 0
  for (const a of snapshot.doc.accounts) {
    if (!isDebt(a) || a.funded_from_account_id !== from.id) continue
    const owedNow = (a.kind === 'loan' ? figures.loans : figures.cards).find((d) => d.account_id === a.id)?.total_debt_minor ?? 0
    if (owedNow <= 0) continue
    const replay = replays?.get(a.id)
    const minimum = a.kind === 'loan' ? a.terms.payment_minor : replay ? currentOf(replay).minimum_due_minor : 0
    minimums += convert(minimum, a.currency, from.currency, rates) ?? 0
  }
  if (minimums <= 0) return null
  const spare = roundSpare(spareMonthly(walk, from.id))
  const amount = Math.max(10 ** minorDigits(from.currency), spare > 0 ? spare : roundFigure(Math.round(minimums * EXTRA_SHARE)))
  const lever = extraPaymentLever(snapshot, { amount_minor: amount, every: 'month', starts_on: addMonths(firstOfMonth(snapshot.as_of), 1), from_account_id: from.id })
  return `/plan/compare#l=${encodeLevers([lever])}`
}

// The cards the plan pays only the minimum on, still owed when the projection ends: not paid in full, with nothing planned into them and no extra for debts from the account that pays them.
export function minimumOnly(snapshot: Snapshot, walk: Walk, payoffs: ReadonlyMap<string, Milestone> = debtPayoffs(snapshot, walk)): string[] {
  const live = snapshot.doc.plan_items.filter((i) => i.kind === 'transfer' && i.confidence !== 'upside' && (i.ends_on === null || i.ends_on >= snapshot.as_of))
  return snapshot.doc.accounts
    .filter((a) => a.kind === 'credit_card' && a.archived_at === null && a.terms.pay.mode !== 'in_full')
    .filter((a) => payoffs.get(a.id)?.after_horizon === true)
    .filter((a) => !live.some((i) => i.to_account_id === a.id || (i.to_account_id === null && i.from_account_id === a.funded_from_account_id)))
    .sort(bySortOrder)
    .map((a) => a.id)
}

// 'Your plan pays only the minimum on Credit card.', when that is why a debt outlasts the projection.
export function minimumNote(cards: readonly string[]): Copy | null {
  if (cards.length === 0) return null
  const names: Copy = cards.flatMap((id, i) => [...(i === 0 ? [] : [textPart(i === cards.length - 1 ? ' and ' : ', ')]), { account: id }])
  return [textPart('Your plan pays only the minimum on '), ...names, textPart('.')]
}

// The Debts tab, or null when the household has no open card or loan.
export function debtsModel(snapshot: Snapshot, walk: Walk): DebtsModel | null {
  const open = snapshot.doc.accounts.filter(isDebt).sort(bySortOrder)
  if (open.length === 0) return null
  const rows = rowsOf(snapshot, walk)
  const milestones = debtMilestones(snapshot, walk)
  const debts = open.flatMap((a) => debtRow(snapshot, walk, a, rows) ?? [])
  const cards = debts.filter((d) => d.kind === 'credit_card')
  const minimum = milestones.debt_free.after_horizon ? minimumNote(minimumOnly(snapshot, walk, rows.payoffs)) : null
  // A card's current cycle still to pay, by its due day: what clears revolving balances this month.
  const due = cards.flatMap((d) => (d.next && d.next.after_cut === null && d.action?.label === RECORD_PAYMENT ? [d.next.on] : []))
  return {
    headline: heroHeadline(milestones.debt_free, rows.horizonMonth, minimum, snapshot),
    revolving: cards.length > 0 ? revolving(milestones.revolving_cleared, rows.horizonMonth, snapshot.as_of, due) : null,
    total: rows.figures.total_debt,
    total_includes_installments: rows.figures.cards.some((c) => c.unbilled_installments_minor > 0 && cards.some((d) => d.account_id === c.account_id)),
    statement_cuts: [...new Set(cards.flatMap((d) => (d.statement_cut ? [d.statement_cut] : [])))].sort(),
    debts,
    try_extra: tryExtraLink(snapshot, walk, rows.figures),
  }
}

export interface DebtSeries {
  account_id: string
  // The account's place in the account order, which picks its colour as on its card.
  colour: number
  // Total debt now, then at each month end, installments still to bill included, never below zero; a credit owes nothing.
  owed: readonly number[]
  // The point of its payoff month (the debt-free rule, as its card says 'Paid off by'), or null when that falls outside the chart.
  clears_at: number | null
}

export interface DebtPane {
  currency: string
  // Today, then the last walked day of each month, to the pane's debt-free month or the projection's end.
  days: readonly string[]
  // Stacked bottom to top: the debt paid off last sits at the bottom, so the stack falls away from the top.
  series: readonly DebtSeries[]
  // The month every debt in the pane is paid off, when the projection reaches it.
  free_month: string | null
  // The point of the month revolving balances clear, when it falls in the chart.
  revolving_at: number | null
}

// Spec §8 charts: what each card and loan owes month by month, one pane per currency, by core's debtOn; it runs to the month the debts' own payoff months say they clear.
export function debtPanes(snapshot: Snapshot, walk: Walk): DebtPane[] {
  const identity = identityIndex(snapshot.doc.accounts)
  const payoffs = debtPayoffs(snapshot, walk)
  const open = snapshot.doc.accounts.filter(isDebt).sort(bySortOrder)
  const ends: number[] = [0]
  walk.days.forEach((day, i) => {
    const next = walk.days[i + 1]
    if (i > 0 && (next === undefined || next.slice(0, 7) !== day.slice(0, 7))) ends.push(i)
  })
  const allDays = ends.map((i) => walk.days[i] ?? walk.as_of)
  const pointOf = (month: string) => allDays.findIndex((d, k) => k > 0 && d.slice(0, 7) === month)
  const cleared = debtMilestones(snapshot, walk).revolving_cleared.month
  const owedAt = ends.map((i) => new Map(debtOn(snapshot, walk, i).map((d) => [d.account_id, Math.max(0, d.total_debt_minor)])))
  const panes: DebtPane[] = []
  for (const currency of [...new Set(open.map((a) => a.currency))]) {
    const accounts = open.filter((a) => a.currency === currency)
    const months = accounts.map((a) => payoffs.get(a.id))
    // Every debt's payoff month is known and inside the projection; a debt that never carries counts as clear now.
    const known = months.every((m) => m !== undefined && !m.after_horizon)
    const free = known ? (months.flatMap((m) => (m?.month ? [m.month] : [])).sort().at(-1) ?? null) : null
    const last = free === null ? -1 : pointOf(free)
    const length = last < 0 ? allDays.length : Math.max(2, last + 1)
    const series = accounts.map((a) => {
      const month = payoffs.get(a.id)?.month ?? null
      const at = month === null ? -1 : pointOf(month)
      return { account_id: a.id, colour: identityOf(identity, a.id), owed: owedAt.slice(0, length).map((m) => m.get(a.id) ?? 0), clears_at: at < 0 || at >= length ? null : at }
    })
    if (series.every((x) => x.owed.every((v) => v === 0))) continue
    series.sort((x, y) => (y.clears_at ?? length) - (x.clears_at ?? length) || x.colour - y.colour)
    const at = cleared === null ? -1 : pointOf(cleared)
    panes.push({ currency, days: allDays.slice(0, length), series, free_month: last < 0 ? null : free, revolving_at: at < 0 || at >= length ? null : at })
  }
  return panes
}

export interface LatestStatement {
  id: string
  chip: Chip | null
  provisional: boolean
  cut_date: string
  due_date: string
  total_minor: number
  minimum_minor: number
  // Payments recorded since the cut, by their card leg; in transit included.
  paid_minor: number
  remaining_minor: number
  left_minor: number
}

export interface CycleLine {
  cut_date: string
  due_date: string
  total_minor: number
  minimum_minor: number
  // What the plan pays for this statement in all, recorded payments included.
  payment_minor: number
  interest_minor: number
}

export interface InstallmentLine {
  plan_item_id: string
  amount_minor: number
  billed: number
  total: number
  last_month: string
}

export interface InterestCheck {
  cut_date: string
  printed_minor: number
  modelled_minor: number
  // Modelled minus printed (spec §6.4).
  variance_minor: number
}

export interface CardDetail {
  kind: 'credit_card'
  row: DebtRow
  statement: LatestStatement
  installments: readonly InstallmentLine[]
  cycles: readonly CycleLine[]
  interest: InterestCheck | null
  warnings: ReturnType<typeof statementWarnings>
  // How far the latest statement's available credit is below zero.
  over_limit_minor: number | null
  links: { edit: DebtLink; transactions: DebtLink }
}

export interface LoanDetail {
  kind: 'loan'
  // Its owed is the balance, its payoff the payoff month.
  row: DebtRow
  payment_minor: number
  payment_day: number
  links: { edit: DebtLink; transactions: DebtLink }
}

// One debt's page, or null when the household has no open debt with this id.
export function debtDetail(snapshot: Snapshot, walk: Walk, accountId: string): CardDetail | LoanDetail | null {
  const account = snapshotIndex(snapshot).accounts.get(accountId)
  if (!account || !isDebt(account)) return null
  const rows = rowsOf(snapshot, walk)
  const row = debtRow(snapshot, walk, account, rows)
  if (!row) return null
  const links = { edit: { pathname: '/settings/account/[id]', params: { id: accountId } } as DebtLink, transactions: { pathname: '/money/[accountId]', params: { accountId } } as DebtLink }
  if (account.kind === 'loan') return { kind: 'loan', row, payment_minor: account.terms.payment_minor, payment_day: account.terms.payment_day, links }
  const replay = cardsOf(walk)?.get(accountId)
  const figures = rows.figures.cards.find((c) => c.account_id === accountId)
  if (!replay || !figures) return null
  const current = currentOf(replay)
  const entered = anchorStatement(snapshot, accountId)
  const anchored = entered ? replay.statements.find((s) => s.id === entered.id) : undefined
  return {
    kind: 'credit_card',
    row,
    statement: {
      id: current.id,
      chip: statementChip(snapshot, current),
      provisional: current.provisional,
      cut_date: current.cut_date,
      due_date: current.due_date,
      total_minor: current.total_due_minor,
      minimum_minor: current.minimum_due_minor,
      paid_minor: figures.payment?.paid_minor ?? 0,
      remaining_minor: figures.remaining_due_minor,
      left_minor: figures.payment?.left_to_pay_minor ?? 0,
    },
    installments: installmentProgress(snapshot, walk, accountId).map((i) => ({ plan_item_id: i.plan_item_id, amount_minor: i.amount_minor, billed: i.billed, total: i.total, last_month: i.last_month })),
    cycles: replay.statements
      .filter((s) => s.cut_date > current.cut_date)
      .slice(0, NEXT_CYCLES)
      .map((s) => ({ cut_date: s.cut_date, due_date: s.due_date, total_minor: s.total_due_minor, minimum_minor: s.minimum_due_minor, payment_minor: s.payment?.planned_gross_minor ?? 0, interest_minor: s.model?.interest_minor ?? 0 })),
    interest:
      entered && anchored?.model && anchored.interest_variance_minor !== null && entered.interest_minor !== null
        ? { cut_date: entered.cut_date, printed_minor: entered.interest_minor, modelled_minor: anchored.model.interest_minor, variance_minor: anchored.interest_variance_minor }
        : null,
    warnings: statementWarnings(snapshot, accountId),
    over_limit_minor: figures.over_limit && figures.available_credit_minor !== null ? 0 - figures.available_credit_minor : null,
    links,
  }
}
