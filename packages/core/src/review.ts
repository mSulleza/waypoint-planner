import { moneyPart, textPart, type Copy, type Route } from './copy'
import { monthKey } from './dates'
import { cardsOf } from './engine/cards'
import { expandPlan } from './engine/events'
import { loansOf } from './engine/loans'
import type { Occurrence, Walk } from './engine/types'
import type { Money } from './money'
import type { Statement, Transaction } from './schema/rows'
import { snapshotIndex, type Snapshot } from './snapshot'
import { statementChecks, type StatementCheckKind, type StatementDifference } from './statement-checks'

// Anything that needs a person (spec §6.6); transfer items into a debt and extra for debts never are. An unconfirmed_inflow is late income or an unconfirmed draw.
export type ReviewKind = 'unconfirmed_inflow' | 'suggestion' | 'overdue_outflow' | 'statement_to_enter' | 'statement_warning'

export interface ReviewItem {
  // `<kind>:<occurrence, suggestion, loan payment or statement key>`: it never depends on a name, so renaming leaves it alone.
  id: string
  kind: ReviewKind
  // The account it is about: where the money lands or leaves, or the card or loan.
  account_id: string
  // The period's month, or the statement's cut month.
  month: string
  occurrence_id: string | null
  row_id: string | null
  // An entered statement's id, or a provisional cut's `<card>:<cut_date>`.
  statement_id: string | null
  amount: Money | null
  // When it happened or should have: the occurrence's date, the payment day or the cut.
  date: string
  // The day to act by: the occurrence's date, the payment day or the statement's due date.
  act_by: string
  title: string
  body: Copy
  route: Route
}

// Imperative, no digits, at most 50 characters; amounts and names go in the body as tokens.
export const REVIEW_TITLES = Object.freeze({
  unconfirmed_inflow: 'Check whether expected money arrived',
  suggestion: 'Check whether a transaction settles an item',
  overdue_bill: 'Pay or skip an overdue bill',
  overdue_transfer: 'Make or skip an overdue transfer',
  overdue_loan_payment: 'Pay an overdue loan payment',
  statement_to_enter: 'Enter a card statement',
  statement_warning: 'Check a card statement',
})

// The Statement sheet's wording for each part that differs (spec §7); interest has its own alert.
export const WARNING_WORDS: Readonly<Record<Exclude<StatementCheckKind, 'interest'>, string>> = Object.freeze({
  previous_balance: 'Previous balance differs from the last statement',
  installments: 'Installments differ from your plan',
  payments_and_credits: 'Payments and credits differ from what you logged',
})

const KIND_ORDER: Readonly<Record<ReviewKind, number>> = { overdue_outflow: 0, unconfirmed_inflow: 1, suggestion: 2, statement_to_enter: 3, statement_warning: 4 }

const byReview = (a: ReviewItem, b: ReviewItem) => (a.act_by < b.act_by ? -1 : a.act_by > b.act_by ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const todo = (month: string, accountId: string): Route => ({ tab: 'months', month, account_id: accountId, segment: 'todo' })

// The latest entered statement on or before as_of: only its warnings stand, so a newer statement retires the older one's.
export function anchorStatement(snapshot: Snapshot, cardId: string): Statement | null {
  return (snapshotIndex(snapshot).statementsByAccount.get(cardId) ?? []).filter((s) => s.cut_date <= snapshot.as_of).at(-1) ?? null
}

// One review list per walk, in act-by order: overdue cash outflows, late income and unconfirmed draws, suggestions, statements to enter and statement warnings. The walk must have run the card and loan modules when the household has those debts.
export function reviewList(snapshot: Snapshot, walk: Walk): readonly ReviewItem[] {
  if (walk.as_of !== snapshot.as_of) throw new RangeError(`The walk is for ${walk.as_of}, not the snapshot's day ${snapshot.as_of}`)
  const index = snapshotIndex(snapshot)
  const plan = expandPlan(snapshot)
  const currencyOf = (accountId: string) => index.accounts.get(accountId)?.currency ?? snapshot.doc.household.base_currency
  const amountOf = (o: Occurrence): Money => ({ minor: o.open_minor, currency: currencyOf(o.account_id) })
  const items: ReviewItem[] = []

  // An open occurrence a row may settle shows once, as that suggestion.
  const suggested = new Set(plan.suggestions.map((s) => s.occurrence_id))
  const rows = plan.suggestions.length > 0 ? new Map<string, Transaction>(snapshot.doc.transactions.map((t) => [t.id, t])) : new Map<string, Transaction>()
  for (const s of plan.suggestions) {
    const o = plan.byId.get(s.occurrence_id)
    const row = rows.get(s.row_id)
    if (!o || !row) throw new Error(`Suggestion '${s.id}' names a row or occurrence the snapshot lacks`)
    items.push({
      id: `suggestion:${s.id}`,
      kind: 'suggestion',
      account_id: s.account_id,
      month: o.period.slice(0, 7),
      occurrence_id: o.id,
      row_id: row.id,
      statement_id: null,
      amount: amountOf(o),
      date: o.date,
      act_by: o.date,
      title: REVIEW_TITLES.suggestion,
      body: [textPart('A transaction of '), moneyPart(Math.abs(row.amount_minor), currencyOf(row.account_id)), textPart(' on '), { date: row.posted_on }, textPart(' may settle '), { item: o.plan_item_id }, textPart(', '), moneyPart(o.open_minor, currencyOf(o.account_id)), textPart(' due '), { date: o.date }, textPart('.')],
      route: todo(o.period.slice(0, 7), s.account_id),
    })
  }

  for (const o of plan.occurrences) {
    if (suggested.has(o.id)) continue
    const month = o.period.slice(0, 7)
    if (o.state === 'late' || o.state === 'unconfirmed') {
      items.push({
        id: `unconfirmed_inflow:${o.id}`,
        kind: 'unconfirmed_inflow',
        account_id: o.account_id,
        month,
        occurrence_id: o.id,
        row_id: null,
        statement_id: null,
        amount: amountOf(o),
        date: o.date,
        act_by: o.date,
        title: REVIEW_TITLES.unconfirmed_inflow,
        body:
          o.carried_to === null
            ? [{ item: o.plan_item_id }, textPart(': '), moneyPart(o.open_minor, currencyOf(o.account_id)), textPart(' into '), { account: o.account_id }, textPart(' on '), { date: o.date }, textPart(' has no linked transaction.')]
            : [{ item: o.plan_item_id }, textPart(': '), moneyPart(o.open_minor, currencyOf(o.account_id)), textPart(' into '), { account: o.account_id }, textPart(' was expected on '), { date: o.date }, textPart(' and has no linked transaction, so it now counts on '), { date: o.carried_to }, textPart('.')],
        route: todo(month, o.account_id),
      })
    } else if (o.state === 'overdue' && (o.flow === 'bill' || o.flow === 'transfer')) {
      items.push({
        id: `overdue_outflow:${o.id}`,
        kind: 'overdue_outflow',
        account_id: o.account_id,
        month,
        occurrence_id: o.id,
        row_id: null,
        statement_id: null,
        amount: amountOf(o),
        date: o.date,
        act_by: o.date,
        title: o.flow === 'bill' ? REVIEW_TITLES.overdue_bill : REVIEW_TITLES.overdue_transfer,
        body: [{ item: o.plan_item_id }, textPart(': '), moneyPart(o.open_minor, currencyOf(o.account_id)), textPart(' from '), { account: o.account_id }, textPart(' was due on '), { date: o.date }, textPart('.')],
        route: todo(month, o.account_id),
      })
    }
  }

  const hasLoans = snapshot.doc.accounts.some((a) => a.kind === 'loan')
  const hasCards = snapshot.doc.accounts.some((a) => a.kind === 'credit_card')
  const schedules = loansOf(walk)
  const replays = cardsOf(walk)
  if (hasLoans && !schedules) throw new RangeError('The review needs a walk that ran the loan module')
  if (hasCards && !replays) throw new RangeError('The review needs a walk that ran the card module')
  for (const [loanId, schedule] of schedules ?? []) {
    for (const p of schedule.payments) {
      if (!p.overdue) continue
      const month = monthKey(p.on)
      items.push({
        id: `overdue_outflow:payment:${loanId}:${p.on}`,
        kind: 'overdue_outflow',
        account_id: loanId,
        month,
        occurrence_id: null,
        row_id: null,
        statement_id: null,
        amount: { minor: p.model_minor, currency: currencyOf(loanId) },
        date: p.on,
        act_by: p.on,
        title: REVIEW_TITLES.overdue_loan_payment,
        body: [{ account: loanId }, textPart(': '), moneyPart(p.model_minor, currencyOf(loanId)), textPart(' was due on '), { date: p.on }, textPart('.')],
        route: todo(month, loanId),
      })
    }
  }

  for (const [cardId, replay] of replays ?? []) {
    // Only the latest cut asks for its statement: entering it makes it the anchor, and an earlier missing cycle then shows as a previous-balance warning.
    const s = replay.statements.find((x) => x.id === replay.current_id)
    if (!s) throw new Error(`The replay of '${cardId}' lost its current statement '${replay.current_id}'`)
    if (s.provisional) {
      items.push({
        id: `statement_to_enter:${s.id}`,
        kind: 'statement_to_enter',
        account_id: cardId,
        month: monthKey(s.cut_date),
        occurrence_id: null,
        row_id: null,
        statement_id: s.id,
        amount: null,
        date: s.cut_date,
        act_by: s.due_date,
        title: REVIEW_TITLES.statement_to_enter,
        body: [{ account: cardId }, textPart(' cut on '), { date: s.cut_date }, textPart('; enter its statement before paying the bill due '), { date: s.due_date }, textPart('.')],
        route: { tab: 'debts', account_id: cardId, sheet: 'statement' },
      })
    }
    const entered = anchorStatement(snapshot, cardId)
    if (!entered) continue
    const checks = statementChecks(snapshot, entered)
    for (const kind of ['previous_balance', 'installments', 'payments_and_credits'] as const) {
      const found: StatementDifference | null = checks[kind]
      if (!found) continue
      items.push({
        id: `statement_warning:${entered.id}:${kind}`,
        kind: 'statement_warning',
        account_id: cardId,
        month: monthKey(entered.cut_date),
        occurrence_id: null,
        row_id: null,
        statement_id: entered.id,
        amount: { minor: found.difference_minor, currency: currencyOf(cardId) },
        date: entered.cut_date,
        act_by: entered.due_date,
        title: REVIEW_TITLES.statement_warning,
        body: [{ account: cardId }, textPart(`: ${WARNING_WORDS[kind]}; printed `), moneyPart(found.printed_minor, currencyOf(cardId)), textPart(', expected '), moneyPart(found.expected_minor, currencyOf(cardId)), textPart('.')],
        route: { tab: 'debts', account_id: cardId },
      })
    }
  }

  items.sort(byReview)
  for (const item of items) Object.freeze(item)
  return Object.freeze(items)
}
