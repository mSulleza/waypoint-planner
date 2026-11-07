import type { BudgetRow } from './budget'
import { moneyPart, sameSubject, textPart, type Copy, type Route, type Subject } from './copy'
import { daysBetween, monthKey } from './dates'
import { debtFigures } from './engine/debt-figures'
import type { FxBreakeven } from './engine/fx-breakeven'
import { fundingCurrency } from './engine/fx'
import type { MonthFigures, Walk } from './engine/types'
import { exceedsScaled } from './money'
import type { NextAction } from './next-action'
import { missingRates } from './rates'
import { anchorStatement, type ReviewItem, type ReviewKind } from './review'
import type { Snapshot } from './snapshot'
import { statementChecks } from './statement-checks'
import { THRESHOLDS } from './thresholds'

export type Severity = 'critical' | 'warning' | 'info'

export type AlertKind = ReviewKind | 'below_floor' | 'below_target' | 'unfixable_gap' | 'rate_independent' | 'interest_variance' | 'over_limit' | 'missing_rate' | 'spending_fast'

export interface Alert {
  // A review item's own id, or `<kind>:<account, statement, category or currency>[:<YYYY-MM>]`.
  id: string
  kind: AlertKind
  subject: Subject
  severity: Severity
  // Imperative, no digits, at most 50 characters.
  title: string
  body: Copy
  route: Route
  act_by: string
}

// Everything the alerts read, all loaded: the breakeven is null only in a one-currency household.
export interface AlertInputs {
  snapshot: Snapshot
  walk: Walk
  review: readonly ReviewItem[]
  breakeven: FxBreakeven | null
  budgets: readonly BudgetRow[]
}

export const ALERT_TITLES = Object.freeze({
  below_floor: 'Find money for a short month',
  below_target: 'Watch a month that dips under target',
  unfixable_gap: 'Cover a shortfall no top-up can fix',
  rate_independent: 'Cover a shortfall at any exchange rate',
  interest_variance: 'Check the interest on a statement',
  over_limit: 'Bring a card back under its limit',
  missing_rate: 'Refresh the exchange rates',
  spending_fast: 'Slow down spending in a budget',
})

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 0, warning: 1, info: 2 }

const REVIEW_SEVERITY: Readonly<Record<ReviewKind, Severity>> = {
  overdue_outflow: 'critical',
  unconfirmed_inflow: 'warning',
  statement_to_enter: 'warning',
  statement_warning: 'warning',
  suggestion: 'info',
}

const byAlert = (a: Alert, b: Alert) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.act_by < b.act_by ? -1 : a.act_by > b.act_by ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Nothing is advised from a partial picture (rule 172): the walk must be this snapshot's day, and a two-currency household needs its breakeven.
function checkLoaded(inputs: AlertInputs): void {
  const { snapshot, walk, breakeven } = inputs
  if (walk.as_of !== snapshot.as_of) throw new RangeError(`The walk is for ${walk.as_of}, not the snapshot's day ${snapshot.as_of}`)
  if (breakeven === undefined) throw new RangeError('The FX breakeven has not loaded; pass null in a one-currency household')
  if (breakeven === null && fundingCurrency(snapshot) !== null) throw new RangeError('The FX breakeven has not loaded for this two-currency household')
  if (inputs.review === undefined || inputs.budgets === undefined) throw new RangeError('The review list and budget rows must load before alerts')
}

// The first walked day of a month that ends below `limit`.
function firstBelow(walk: Walk, accountId: string, m: MonthFigures, limit: number): string {
  const balances = walk.balances.get(accountId)
  if (!balances) throw new Error(`The walk has no days for '${accountId}'`)
  const [from, to] = [daysBetween(walk.as_of, m.first_day), daysBetween(walk.as_of, m.last_day)]
  for (let i = from; i <= to; i++) if ((balances[i] ?? 0) < limit) return walk.days[i] ?? m.first_day
  return m.lowest_on
}

// Per cash account, the first month of each condition, a milder one only when it comes before every worse one, so one shortfall never fires three times.
function balanceAlerts(snapshot: Snapshot, walk: Walk): Alert[] {
  const out: Alert[] = []
  const accounts = snapshot.doc.accounts.filter((a) => a.kind === 'cash').sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1))
  for (const account of accounts) {
    const figures = walk.figures.get(account.id)
    if (!figures) throw new Error(`The walk has no month figures for '${account.id}'`)
    const cur = account.currency
    const gap = figures.findIndex((m) => m.unfixable_gap_minor > 0)
    const floor = figures.findIndex((m) => m.days_under_floor > 0 && m.unfixable_gap_minor === 0)
    const target = figures.findIndex((m) => m.days_under_target > 0 && m.days_under_floor === 0)
    const before = (at: number, ...worse: number[]) => at >= 0 && worse.every((w) => w < 0 || at < w)
    const subject = (m: MonthFigures) => ({ account_id: account.id, month: m.month })
    const route = (m: MonthFigures): Route => ({ tab: 'months', month: m.month, account_id: account.id, segment: 'chart' })
    const floorWords = (m: MonthFigures): Copy => (m.floor_minor === 0 ? [textPart(' goes below zero on ')] : [textPart(' goes below its floor of '), moneyPart(m.floor_minor, cur), textPart(' on ')])
    const lowest = (m: MonthFigures): Copy => [textPart('; lowest '), moneyPart(m.lowest_minor, cur), textPart(' on '), { date: m.lowest_on }, textPart('.')]
    if (gap >= 0) {
      const m = figures[gap] as MonthFigures
      out.push({
        id: `unfixable_gap:${account.id}:${m.month}`,
        kind: 'unfixable_gap',
        subject: subject(m),
        severity: 'critical',
        title: ALERT_TITLES.unfixable_gap,
        body: [{ account: account.id }, textPart(' is short '), moneyPart(m.unfixable_gap_minor, cur), textPart(' in '), { month: m.month }, textPart(' that no top-up covers'), ...lowest(m)],
        route: route(m),
        act_by: firstBelow(walk, account.id, m, m.floor_minor),
      })
    }
    if (before(floor, gap)) {
      const m = figures[floor] as MonthFigures
      const on = firstBelow(walk, account.id, m, m.floor_minor)
      out.push({
        id: `below_floor:${account.id}:${m.month}`,
        kind: 'below_floor',
        subject: subject(m),
        severity: 'critical',
        title: ALERT_TITLES.below_floor,
        body: [{ account: account.id }, ...floorWords(m), { date: on }, ...lowest(m)],
        route: route(m),
        act_by: on,
      })
    }
    if (before(target, gap, floor)) {
      const m = figures[target] as MonthFigures
      const on = firstBelow(walk, account.id, m, m.target_minor)
      out.push({
        id: `below_target:${account.id}:${m.month}`,
        kind: 'below_target',
        subject: subject(m),
        severity: 'warning',
        title: ALERT_TITLES.below_target,
        body: [{ account: account.id }, textPart(' dips under its target of '), moneyPart(m.target_minor, cur), textPart(' on '), { date: on }, ...lowest(m)],
        route: route(m),
        act_by: on,
      })
    }
  }
  return out
}

// Review items, the walk's shortfalls, the FX breakeven's rate-independent days, card checks, missing rates and fast budgets, worst first: severity, then act-by day, then id.
export function alerts(inputs: AlertInputs): readonly Alert[] {
  checkLoaded(inputs)
  const { snapshot, walk, review, breakeven, budgets } = inputs
  const asOf = snapshot.as_of
  const thisMonth = monthKey(asOf)
  const out: Alert[] = review.map((r) => ({ id: r.id, kind: r.kind, subject: { review_id: r.id }, severity: REVIEW_SEVERITY[r.kind], title: r.title, body: r.body, route: r.route, act_by: r.act_by }))
  out.push(...balanceAlerts(snapshot, walk))

  for (const r of breakeven?.rate_independent ?? []) {
    const month = monthKey(r.date)
    out.push({
      id: `rate_independent:${r.account_id}:${month}`,
      kind: 'rate_independent',
      subject: { account_id: r.account_id, month },
      severity: 'critical',
      title: ALERT_TITLES.rate_independent,
      body: [{ account: r.account_id }, textPart(' goes below zero on '), { date: r.date }, textPart(' at any rate.')],
      route: { tab: 'plan', account_id: r.account_id },
      act_by: r.date,
    })
  }

  const hasDebts = snapshot.doc.accounts.some((a) => a.kind !== 'cash')
  const debts = hasDebts ? debtFigures(snapshot, walk) : null
  for (const card of debts?.cards ?? []) {
    const entered = anchorStatement(snapshot, card.account_id)
    const interest = entered ? statementChecks(snapshot, entered).interest : null
    if (entered && interest && exceedsScaled(Math.abs(interest.difference_minor), THRESHOLDS.interest_variance.share, interest.printed_minor)) {
      out.push({
        id: `interest_variance:${entered.id}`,
        kind: 'interest_variance',
        subject: { account_id: card.account_id, month: monthKey(entered.cut_date) },
        severity: 'warning',
        title: ALERT_TITLES.interest_variance,
        body: [{ account: card.account_id }, textPart(`: ${THRESHOLDS.interest_variance.word}; printed `), moneyPart(interest.printed_minor, card.currency), textPart(', the card terms give '), moneyPart(interest.expected_minor, card.currency), textPart('.')],
        route: { tab: 'debts', account_id: card.account_id },
        act_by: entered.due_date,
      })
    }
    if (card.over_limit && card.available_credit_minor !== null) {
      out.push({
        id: `over_limit:${card.account_id}:${thisMonth}`,
        kind: 'over_limit',
        subject: { account_id: card.account_id, month: thisMonth },
        severity: 'warning',
        title: ALERT_TITLES.over_limit,
        body: [{ account: card.account_id }, textPart(' is '), moneyPart(0 - card.available_credit_minor, card.currency), textPart(' over its limit.')],
        route: { tab: 'debts', account_id: card.account_id },
        act_by: asOf,
      })
    }
  }

  const ordered = [...snapshot.doc.accounts].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1))
  const base = snapshot.doc.household.base_currency
  for (const code of missingRates([base, ...ordered.map((a) => a.currency)], snapshot.rates).sort()) {
    const holder = ordered.find((a) => a.currency === code) ?? ordered[0]
    if (!holder) continue
    out.push({
      id: `missing_rate:${code}`,
      kind: 'missing_rate',
      subject: { account_id: holder.id, month: thisMonth },
      severity: 'warning',
      title: ALERT_TITLES.missing_rate,
      body: [textPart(`No reference rate for ${code}, so totals that need it are not shown.`)],
      route: { tab: 'money' },
      act_by: asOf,
    })
  }

  for (const b of budgets) {
    if (b.word !== THRESHOLDS.spending_fast.word) continue
    out.push({
      id: `spending_fast:${b.category_id}:${b.month}`,
      kind: 'spending_fast',
      subject: { account_id: b.account_id, month: b.month },
      severity: 'warning',
      title: ALERT_TITLES.spending_fast,
      body: [{ category: b.category_id }, textPart(': '), moneyPart(b.spent_minor, b.currency), textPart(' spent of '), moneyPart(b.budget_minor, b.currency), textPart(', '), moneyPart(b.rate_so_far_minor, b.currency), textPart(' a day against '), moneyPart(b.planned_rate_minor, b.currency), textPart(' planned.')],
      route: { tab: 'months', month: b.month, segment: 'breakdown' },
      act_by: asOf,
    })
  }

  out.sort(byAlert)
  for (const a of out) Object.freeze(a)
  return Object.freeze(out)
}

// Leaves out the alerts about what the next action already says: its account and month, or its review item.
export function dropSameSubject(list: readonly Alert[], next: NextAction): readonly Alert[] {
  const subject = next.subject
  return subject === null ? list : list.filter((a) => !sameSubject(a.subject, subject))
}

