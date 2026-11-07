import { replayCard } from './engine/cards'
import { expandPlan } from './engine/events'
import { slotCut } from './engine/occurrences'
import { statementGap, type Statement } from './schema/rows'
import { snapshotIndex, type Snapshot } from './snapshot'

export type StatementCheckKind = 'previous_balance' | 'installments' | 'interest' | 'payments_and_credits'

export interface StatementDifference {
  check: StatementCheckKind
  printed_minor: number
  expected_minor: number
  // printed − expected
  difference_minor: number
}

// Each printed part against what the data says; null when they agree or nothing can be compared.
export interface StatementChecks {
  statement_id: string
  // Against the prior entered statement's total: a gap means a missing cycle.
  previous_balance: StatementDifference | null
  // Against the plan's installment occurrences billed at this cut.
  installments: StatementDifference | null
  // Against the interest the card's own method gives on the replayed cycle; never plugged.
  interest: StatementDifference | null
  // Against the positive card rows posted in the cycle; the printed line is never read as cash.
  payments_and_credits: StatementDifference | null
}

function differs(check: StatementCheckKind, printed: number | null, expected: number | null): StatementDifference | null {
  if (printed === null || expected === null || printed === expected) return null
  return { check, printed_minor: printed, expected_minor: expected, difference_minor: printed - expected }
}

// Statement warnings, computed on read from one checked statement of the snapshot; a total-only statement has no parts to check.
export function statementChecks(snapshot: Snapshot, statement: Statement): StatementChecks {
  const index = snapshotIndex(snapshot)
  const card = index.accounts.get(statement.account_id)
  if (card?.kind !== 'credit_card') throw new RangeError(`Statement '${statement.id}' is not on a card in the snapshot`)
  const statements = index.statementsByAccount.get(card.id) ?? []
  const at = statements.findIndex((s) => s.id === statement.id)
  if (at < 0) throw new RangeError(`Statement '${statement.id}' is not in the snapshot`)
  const checks: StatementChecks = { statement_id: statement.id, previous_balance: null, installments: null, interest: null, payments_and_credits: null }
  if (statementGap(statement) === null) return Object.freeze(checks)

  const prior = statements.slice(0, at)
  const before = prior.at(-1)
  checks.previous_balance = differs('previous_balance', statement.previous_balance_minor, before?.total_due_minor ?? null)

  const plan = expandPlan(snapshot)
  const slot = slotCut(card.terms.cut_day, statement.cut_date)
  if (slot >= plan.history_from) {
    let planned = 0
    for (const o of plan.occurrences) if (o.flow === 'installment' && o.account_id === card.id && !o.skipped && o.date === slot) planned += o.amount_minor
    checks.installments = differs('installments', statement.installments_minor, planned)
  }

  // The cycle is replayed from the entered statement before it; only a cut right after that one has a printed starting point.
  const replay = replayCard(snapshot, card, { entered: [...prior, statement], until: statement.cut_date, events: null, payer: null })
  const replayed = replay.statements.find((s) => s.id === statement.id)
  if (replayed?.model && before !== undefined && replayed.previous_id === before.id) {
    checks.interest = differs('interest', statement.interest_minor, replayed.model.interest_minor)
    checks.payments_and_credits = differs('payments_and_credits', statement.payments_and_credits_minor, replayed.model.payments_and_credits_minor)
  }
  return Object.freeze(checks)
}
