import { checkInput, snapshotIndex, statementChecks, statementGap, statementRow, type Statement, type StatementDifference } from '@waypoint/core'
import { addStatementInput, type AddStatementInput } from '@waypoint/core/agent'
import { randomUUID } from 'node:crypto'
import { Refusal } from '../../errors'
import { accountOf, amount, AMOUNTS, DATA_TEXT, link } from '../read/shape'
import { afterWrite, minorOf, ownerOf, refusal, WRITES, type WriteTool } from './shape'

// The printed figures as decimal text, and the statement columns they fill.
const PRINTED = [
  ['previous_balance', 'previous_balance_minor'],
  ['payments_and_credits', 'payments_and_credits_minor'],
  ['charges', 'charges_minor'],
  ['installments', 'installments_minor'],
  ['interest', 'interest_minor'],
  ['fees', 'fees_minor'],
  ['total_due', 'total_due_minor'],
  ['minimum_due', 'minimum_due_minor'],
  ['available_credit', 'available_credit_minor'],
] as const

const SAME = ['account_id', 'cut_date', 'due_date', ...PRINTED.map(([, column]) => column)] as const

const sameFigures = (a: Statement, b: Statement) => SAME.every((c) => a[c] === b[c])

export function statementOf(card: { id: string; currency: string }, args: AddStatementInput, id: string): Statement {
  const figures = Object.fromEntries(PRINTED.map(([field, column]) => [column, args[field] == null ? null : minorOf(args[field], card.currency, field)]))
  const row = { id, account_id: card.id, cut_date: args.cut_date, due_date: args.due_date, ...figures }
  const result = checkInput(statementRow, row)
  if (result.ok) return result.value
  // The sum check in the agent's own decimals rather than minor units.
  const gap = statementGap(row as Statement)
  const sum = (e: string) => (gap !== null && e.startsWith('total_due_minor: previous') ? `total_due: the parts add up to ${amount((figures.total_due_minor ?? 0) - gap, card.currency).amount}, but total_due is ${args.total_due}: off by ${amount(gap, card.currency).amount}` : e.replace(/_minor\b/g, ''))
  throw new Refusal('bad_input', `Nothing was saved: ${result.errors.map(sum).join('; ')}`, { issues: result.errors })
}

export const addStatement: WriteTool<typeof addStatementInput> = {
  name: 'add_statement',
  description: [
    'Enters a card statement as printed: cut and due dates, total and minimum due, and the six parts (previous balance, payments and credits, charges, installments, interest, fees) together or none of them, each a decimal string in the card’s currency, zero or more.',
    'A payment is measured from the latest entered statement, so enter the statement before paying a cycle get_debt calls provisional. One statement per cut: the same figures again answer already_applied; other figures for an entered cut are refused.',
    'The answer gives core’s statement checks: each part that differs from what the data expects (the previous statement’s total, the plan’s installments billed at this cut, the card’s own interest, the payments recorded in the cycle), printed and expected; null when it agrees or cannot be compared.',
    WRITES,
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: addStatementInput,
  destructive: false,
  idempotent: true,
  async run(io, args) {
    const { snapshot } = io.before
    const card = accountOf(snapshot, args.account_id)
    if (card.kind !== 'credit_card') throw new Refusal('bad_input', `Nothing was saved: '${card.id}' is a ${card.kind === 'loan' ? 'loan' : 'cash account'}; statements are for cards.`, { field: 'account_id' })
    const entered = snapshotIndex(snapshot).statementsByAccount.get(card.id) ?? []
    const atCut = entered.find((s) => s.cut_date === args.cut_date)
    const statement = statementOf(card, args, args.id ?? atCut?.id ?? randomUUID())
    const taken = snapshot.doc.statements.find((s) => s.id === statement.id && s.cut_date !== statement.cut_date)
    if (taken) throw new Refusal('id_conflict', `Nothing was saved: statement ${taken.id} is the one cut ${taken.cut_date}. Leave id out for a new statement.`, { statement_id: taken.id })
    let status = 'added'
    if (atCut) {
      if (atCut.id !== statement.id || !sameFigures(atCut, statement)) {
        throw new Refusal('statement_exists', `Nothing was saved: statement ${atCut.id} is entered for the cut ${atCut.cut_date} with other figures, and a card has one statement per cut. get_debt shows it.`, { statement_id: atCut.id })
      }
      status = 'already_applied'
    } else {
      const reply = await io.send(async (db) => db.from('statements').insert({ ...statement, household_id: await ownerOf(db) }).select('id'))
      if (reply.error) throw refusal(reply.error, io.before)
    }
    const after = await afterWrite(io)
    const saved = after?.snapshot.doc.statements.find((s) => s.id === statement.id)
    const checks = after && saved ? statementChecks(after.snapshot, saved) : null
    const difference = (d: StatementDifference | null) => d && { printed: amount(d.printed_minor, card.currency), expected: amount(d.expected_minor, card.currency), difference: amount(d.difference_minor, card.currency) }
    return {
      status,
      batch_id: null,
      statement_id: statement.id,
      checks: checks && {
        previous_balance: difference(checks.previous_balance),
        installments: difference(checks.installments),
        interest: difference(checks.interest),
        payments_and_credits: difference(checks.payments_and_credits),
      },
      link: link(io.before, `/debts/${encodeURIComponent(card.id)}`),
    }
  },
}
