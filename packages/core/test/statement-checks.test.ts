import { describe, expect, it } from 'vitest'
import { abroad, revolvingDaily, type SampleDoc } from '../fixtures'
import type { StatementInput } from '../fixtures/relative'
import { CARDS, cardsOf } from '../src/engine/cards'
import { buildSnapshot, type Snapshot } from '../src/snapshot'
import { statementChecks } from '../src/statement-checks'
import { walked } from './walk-helpers'

const AS_OF = '2026-10-07'

function build(edit?: (doc: SampleDoc) => void, sample = revolvingDaily): Snapshot {
  const { doc, rates } = sample(AS_OF)
  edit?.(doc)
  return buildSnapshot(doc, AS_OF, rates)
}

function enteredOf(doc: SampleDoc, id: string): StatementInput {
  const found = doc.statements.find((s) => s.id === id)
  if (!found) throw new Error(`No statement '${id}'`)
  return found
}

function checksOf(snapshot: Snapshot, id: string) {
  const found = snapshot.doc.statements.find((s) => s.id === id)
  if (!found) throw new Error(`No statement '${id}'`)
  return statementChecks(snapshot, found)
}

describe('statement checks', () => {
  it('reports a difference when logged payments exceed the printed payments and credits', () => {
    const snapshot = build((doc) => {
      doc.transactions.push(
        { id: 'extra-out', account_id: 'cash', posted_on: '2026-09-01', amount_minor: -200000, kind: 'transfer', transfer_id: 'extra' },
        { id: 'extra-in', account_id: 'card', posted_on: '2026-09-01', amount_minor: 200000, kind: 'transfer', transfer_id: 'extra' },
      )
    })
    expect(checksOf(snapshot, 'last').payments_and_credits).toEqual({ check: 'payments_and_credits', printed_minor: 1000000, expected_minor: 1200000, difference_minor: -200000 })
    expect(checksOf(build(), 'last').payments_and_credits).toBeNull()
  })

  it('compares the printed previous balance with the prior entered total, so a gap names a missing cycle', () => {
    expect(checksOf(build(), 'last').previous_balance).toBeNull()
    const gap = build((doc) => {
      doc.statements = doc.statements.filter((s) => s.id !== 'prior')
      doc.statements.push({ id: 'older', account_id: 'card', cut_date: '2026-07-20', due_date: '2026-08-14', total_due_minor: 1900000, minimum_due_minor: 57000 })
    })
    const checks = checksOf(gap, 'last')
    expect(checks.previous_balance).toEqual({ check: 'previous_balance', printed_minor: 2400000, expected_minor: 1900000, difference_minor: 500000 })
    // The cycle before it was never entered, so there is no printed starting point to model interest or payments from.
    expect([checks.interest, checks.payments_and_credits]).toEqual([null, null])
  })

  it('compares the printed installments with the plan installments billed at that cut, and the plan amount keeps billing', () => {
    const snapshot = build((doc) => {
      Object.assign(enteredOf(doc, 'last'), { installments_minor: 160000, total_due_minor: 3010000 })
    })
    expect(checksOf(snapshot, 'last').installments).toEqual({ check: 'installments', printed_minor: 160000, expected_minor: 150000, difference_minor: 10000 })
    const next = cardsOf(walked(snapshot, { cards: CARDS }))?.get('card')?.statements.find((s) => s.cut_date === '2026-10-20')
    expect(next?.installments_minor).toBe(150000)
  })

  it('reports printed against modelled interest and never plugs it into the statement', () => {
    const snapshot = build()
    expect(checksOf(snapshot, 'last').interest).toEqual({ check: 'interest', printed_minor: 50000, expected_minor: 53400, difference_minor: -3400 })
    const replay = cardsOf(walked(snapshot, { cards: CARDS }))?.get('card')
    const last = replay?.statements.find((s) => s.id === 'last')
    expect([last?.total_due_minor, last?.interest_variance_minor, replay?.moves.filter((m) => m.kind === 'interest' && m.date < '2026-10-20')]).toEqual([3000000, 3400, []])
  })

  it('checks nothing on a total-only statement, and only the installments on a first statement', () => {
    const snapshot = build()
    expect(checksOf(snapshot, 'prior')).toEqual({ statement_id: 'prior', previous_balance: null, installments: null, interest: null, payments_and_credits: null })
    // No entered statement comes before it, so nothing gives a printed starting point for its interest or payments.
    const first = (edit?: (doc: SampleDoc) => void) => checksOf(build(edit, abroad), 'rewards-last')
    expect(first()).toEqual({ statement_id: 'rewards-last', previous_balance: null, installments: null, interest: null, payments_and_credits: null })
    const misprinted = first((doc) => Object.assign(enteredOf(doc, 'rewards-last'), { installments_minor: 450000, total_due_minor: 6950000 }))
    expect([misprinted.installments?.difference_minor, misprinted.interest, misprinted.payments_and_credits]).toEqual([-50000, null, null])
  })

  it('refuses a statement that is not one of the snapshot cards', () => {
    const snapshot = build()
    const stray = { ...snapshot.doc.statements[0], id: 'stray' } as (typeof snapshot.doc.statements)[number]
    expect(() => statementChecks(snapshot, stray)).toThrow(RangeError)
  })
})
