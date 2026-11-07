import { buildSnapshot, runEngine, type CardAccount, type Snapshot, type Statement } from '@waypoint/core'
import { abroad, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import type { StatementRead as PdfStatement } from '../../ai/pdf-read'
import { DataError } from '../../data/errors'
import { CHIPS, debtDetail } from '../debts/debts.model'
import {
  blockedBy,
  changeCut,
  cutChoices,
  difference,
  draftFromPdf,
  draftWarnings,
  expectedCut,
  initialDraft,
  openingCut,
  openingEdit,
  openStatement,
  paymentsSum,
  partsSum,
  pdfFilledNote,
  pdfMismatch,
  readDay,
  readStatement,
  statementEdit,
  statementProblem,
  type StatementDraft,
} from './statement.model'

// The day after the rewards card's 20 October cut, which has no statement entered yet.
const AS_OF = '2026-10-21'
const LOCALE = 'en-PH'
const ID = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b'

function snapshotOf(edit?: (doc: SampleDoc) => void, asOf = AS_OF): Snapshot {
  const { doc, rates } = abroad(asOf)
  edit?.(doc)
  return buildSnapshot(doc, asOf, rates)
}

function cardOf(snapshot: Snapshot, id = 'rewards-card'): CardAccount {
  const opened = openStatement(snapshot, id, undefined)
  if (opened.kind !== 'ready') throw new Error(`no card '${id}'`)
  return opened.card
}

// The 20 October statement as the bank prints it: 70,000.00 − 25,000.00 + 2,000.00 + 5,000.00 + 1,525.00 + 0 = 53,525.00.
const PRINTED = { previous: '70,000.00', payments: '25,000.00', charges: '2,000.00', installments: '5,000.00', interest: '1,525.00', fees: '0', total: '53,525.00', minimum: '1,605.75' }

function draftOf(snapshot: Snapshot, patch: Partial<StatementDraft> = {}): StatementDraft {
  return { ...initialDraft(snapshot, cardOf(snapshot), null, LOCALE), ...PRINTED, ...patch }
}

const read = (snapshot: Snapshot, draft: StatementDraft, card = 'rewards-card') => readStatement(snapshot, cardOf(snapshot, card), draft, { id: ID, locale: LOCALE })

describe('the balance check', () => {
  it('is the total minus previous − payments and credits + charges + installments + interest + fees', () => {
    const parts = { previous: 7000000, payments: 2500000, charges: 200000, installments: 500000, interest: 152500, fees: 0 }
    expect(partsSum(parts)).toBe(5352500)
    expect(difference(parts, 5352500)).toBe(0)
    expect(difference(parts, 5452500)).toBe(100000)
    expect(difference(parts, 5352499)).toBe(-1)
    // A credit balance carried in lowers the sum.
    expect(difference({ ...parts, previous: -100000 }, -1747500)).toBe(0)
  })

  it('sums two printed payments and credits lines into one figure, a blank line as nothing', () => {
    expect(paymentsSum('20,000.00', '5,000.00', LOCALE, 'PHP')).toBe(2500000)
    expect(paymentsSum('20000', '5000.5', LOCALE, 'PHP')).toBe(2500050)
    expect(paymentsSum('25,000.00', null, LOCALE, 'PHP')).toBe(2500000)
    expect(paymentsSum('25,000.00', '', LOCALE, 'PHP')).toBe(2500000)
    expect(paymentsSum('', '', LOCALE, 'PHP')).toBe(0)
    expect(paymentsSum('25,000.00', 'five', LOCALE, 'PHP')).toBeNull()
    expect(paymentsSum('12.34', '1', 'en-US', 'JPY')).toBeNull()
  })

  it('shows the exact difference while the parts do not add up, and keeps Save off', () => {
    const snapshot = snapshotOf()
    const off = read(snapshot, draftOf(snapshot, { total: '54,525.00' }))
    expect(off.check).toEqual({ state: 'off', difference_minor: 100000, sum_minor: 5352500, total_minor: 5452500 })
    expect(off.row).toBeNull()
    expect(blockedBy(off)).toBe('Save is off until the parts add up to the total due.')
    expect(read(snapshot, draftOf(snapshot, { interest: '1,524.99' })).check).toEqual({ state: 'off', difference_minor: 1, sum_minor: 5352499, total_minor: 5352500 })
  })

  it('reads a statement that balances as the row to save, with the two payments lines as one figure', () => {
    const snapshot = snapshotOf()
    const r = read(snapshot, draftOf(snapshot, { payments: '20,000.00', payments_2: '5,000.00', available: '-1,250.00' }))
    expect(r.check).toEqual({ state: 'balances', sum_minor: 5352500 })
    expect(blockedBy(r)).toBeNull()
    expect(r.row).toEqual({
      id: ID,
      account_id: 'rewards-card',
      cut_date: '2026-10-20',
      due_date: '2026-11-16',
      previous_balance_minor: 7000000,
      payments_and_credits_minor: 2500000,
      charges_minor: 200000,
      installments_minor: 500000,
      interest_minor: 152500,
      fees_minor: 0,
      total_due_minor: 5352500,
      minimum_due_minor: 160575,
      available_credit_minor: -125000,
    })
  })

  it('counts a blank part as 0, so a forgotten part shows as the difference', () => {
    const snapshot = snapshotOf()
    const r = read(snapshot, draftOf(snapshot, { interest: '' }))
    expect(r.check).toEqual({ state: 'off', difference_minor: 152500, sum_minor: 5200000, total_minor: 5352500 })
    expect(read(snapshot, draftOf(snapshot, { interest: '', total: '52,000.00', minimum: '1,560.00' })).row?.interest_minor).toBe(0)
  })

  it('saves a total-only statement with all six parts empty, whatever the hidden fields hold', () => {
    const snapshot = snapshotOf()
    const r = read(snapshot, draftOf(snapshot, { total_only: true, previous: 'not read', total: '53,000.00', minimum: '1,590.00' }))
    expect(r.check).toEqual({ state: 'total_only' })
    expect(r.parts).toBeNull()
    expect(r.errors).toEqual({})
    expect(r.row).toMatchObject({ previous_balance_minor: null, payments_and_credits_minor: null, charges_minor: null, installments_minor: null, interest_minor: null, fees_minor: null, total_due_minor: 5300000, minimum_due_minor: 159000 })
  })
})

describe('the fields', () => {
  it('waits for the total and the minimum, and says which are missing', () => {
    const snapshot = snapshotOf()
    const r = read(snapshot, draftOf(snapshot, { total: '', minimum: '' }))
    expect(r.check).toEqual({ state: 'waiting', reason: 'total' })
    expect(r.missing).toEqual(['total', 'minimum'])
    expect(blockedBy(r)).toBe('Enter the total due and minimum due.')
  })

  it('refuses a cut not yet come, one before the card starts, a due date before the cut and a minimum above the total', () => {
    const snapshot = snapshotOf()
    expect(read(snapshot, draftOf(snapshot, { cut: '2026-10-22', due: '2026-11-16' })).errors.cut).toBe('This day has not come yet. Enter the statement once it has printed.')
    expect(read(snapshot, draftOf(snapshot, { cut: '2026-08-20', due: '2026-09-16' })).errors.cut).toBe('Rewards card starts in Waypoint on Sep 1, 2026; enter a statement cut on or after Sep 1, 2026.')
    expect(read(snapshot, draftOf(snapshot, { cut: '2026-10-20', due: '2026-10-19' })).errors.due).toBe('The due date cannot be before the cut date.')
    expect(read(snapshot, draftOf(snapshot, { cut: '2026-10-32' })).errors.cut).toBe('Pick the cut date.')
    expect(read(snapshot, draftOf(snapshot, { minimum: '53,525.01' })).errors.minimum).toBe('The minimum cannot be more than the total due.')
    const credit = read(snapshot, draftOf(snapshot, { previous: '-1,000.00', payments: '0', charges: '0', installments: '0', interest: '0', total: '-1,000.00', minimum: '5.00' }))
    expect(credit.errors.minimum).toBe('Nothing is due, so the minimum is 0.')
    const r = read(snapshot, draftOf(snapshot, { charges: '-2,000.00', fees: 'ten' }))
    expect(r.errors).toEqual({ charges: 'Enter it without a minus sign.', fees: 'Enter the amount as printed.' })
    expect(r.check).toEqual({ state: 'waiting', reason: 'parts' })
    expect(blockedBy(r)).toBe('Check the fields marked above.')
  })

  it('takes the statement a new card holds on its first day, cut before it opened, and moves the opening back to that cut', () => {
    // A card added today, 9 October, cutting on the 25th, with no statement yet.
    const fresh = (doc: SampleDoc) => {
      const card = doc.accounts.find((a) => a.id === 'rewards-card')
      if (!card || card.kind !== 'credit_card') throw new Error('no rewards card')
      card.opening_date = '2026-10-09'
      card.terms = { ...card.terms, cut_day: 25 }
      doc.statements = doc.statements.filter((t) => t.account_id !== 'rewards-card')
      doc.transactions = doc.transactions.filter((t) => t.account_id !== 'rewards-card' && !doc.transactions.some((o) => o.transfer_id !== null && o.transfer_id === t.transfer_id && o.account_id === 'rewards-card'))
      doc.plan_items = doc.plan_items.filter((i) => i.from_account_id !== 'rewards-card' && i.to_account_id !== 'rewards-card')
    }
    const snapshot = snapshotOf(fresh, '2026-10-09')
    const card = cardOf(snapshot)
    expect(openingCut(snapshot, card)).toBe('2026-09-25')
    expect(expectedCut(snapshot, card)).toBe('2026-09-25')
    expect(cutChoices(snapshot, card)).toEqual(['2026-09-25'])
    expect(initialDraft(snapshot, card, null, LOCALE)).toMatchObject({ cut: '2026-09-25' })
    const taken = readStatement(snapshot, card, { ...initialDraft(snapshot, card, null, LOCALE), total_only: true, total: '85,000.00', minimum: '2,975.00' }, { id: ID, locale: LOCALE })
    expect(taken.errors).toEqual({})
    expect(taken.opening).toBe('2026-09-25')
    expect(taken.row?.cut_date).toBe('2026-09-25')
    expect(openingEdit(card, '2026-09-25')).toMatchObject({ kind: 'edit_account', id: 'rewards-card', before: { opening_date: '2026-10-09' }, after: { opening_date: '2026-09-25' } })
    const earlier = readStatement(snapshot, card, { ...initialDraft(snapshot, card, null, LOCALE), cut: '2026-08-25', total_only: true, total: '85,000.00', minimum: '2,975.00' }, { id: ID, locale: LOCALE })
    expect(earlier.errors.cut).toBe('Rewards card starts in Waypoint on Oct 9, 2026; enter a statement cut on or after Sep 25, 2026.')
    expect(earlier.opening).toBeNull()
  })

  it('reads eight digits as a day, so a number pad can type one', () => {
    expect(readDay('20261020')).toBe('2026-10-20')
    expect(readDay(' 2026-10-20 ')).toBe('2026-10-20')
    const snapshot = snapshotOf()
    expect(read(snapshot, draftOf(snapshot, { cut: '20261020', due: '20261116' })).row?.cut_date).toBe('2026-10-20')
  })

  it('opens on the cut to enter, with the due date by the card’s rule, which follows the cut until typed', () => {
    const snapshot = snapshotOf()
    const card = cardOf(snapshot)
    expect(expectedCut(snapshot, card)).toBe('2026-10-20')
    const before = snapshotOf(undefined, '2026-10-19')
    expect(expectedCut(before, cardOf(before))).toBe('2026-09-20')
    expect(cutChoices(snapshot, card)).toEqual(['2026-10-20', '2026-09-20'])
    const draft = initialDraft(snapshot, card, null, LOCALE)
    expect(draft).toMatchObject({ cut: '2026-10-20', due: '2026-11-16', due_typed: false, total_only: false, previous: '', total: '' })
    const moved = changeCut(card, draft, '2026-09-20')
    expect(moved.due).toBe('2026-10-16')
    expect(changeCut(card, { ...moved, due: '2026-10-15', due_typed: true }, '2026-10-20').due).toBe('2026-10-15')
    // A cut half typed leaves the due date as it was.
    expect(changeCut(card, draft, '2026-09').due).toBe('2026-11-16')
  })

  it('opens a card whose last statement printed no breakdown as Total only, on the cycle already entered', () => {
    const snapshot = snapshotOf()
    // The shopping card's 25 September statement is the latest cut on or before 21 October, and it is entered.
    const draft = initialDraft(snapshot, cardOf(snapshot, 'shopping-card'), null, LOCALE)
    expect(draft).toMatchObject({ cut: '2026-09-25', due: '2026-10-16', total_only: true })
    expect(read(snapshot, draft, 'shopping-card').duplicate?.id).toBe('shopping-last')
  })

  it('opens a saved statement with its printed figures', () => {
    const snapshot = snapshotOf()
    const opened = openStatement(snapshot, 'rewards-card', 'rewards-last')
    if (opened.kind !== 'ready' || !opened.editing) throw new Error('not opened')
    expect(initialDraft(snapshot, opened.card, opened.editing, LOCALE)).toEqual({
      cut: '2026-09-20',
      due: '2026-10-16',
      due_typed: true,
      total_only: false,
      previous: '38000.00',
      payments: '38000.00',
      payments_2: null,
      charges: '65000.00',
      installments: '5000.00',
      interest: '0.00',
      fees: '0.00',
      total: '70000.00',
      minimum: '2100.00',
      available: '30000.00',
    })
    expect(openStatement(snapshot, 'rewards-card', 'gone')).toMatchObject({ kind: 'no_statement' })
    expect(openStatement(snapshot, 'rewards-card', 'shopping-last')).toMatchObject({ kind: 'no_statement' })
    expect(openStatement(snapshot, 'main', undefined)).toEqual({ kind: 'no_card' })
  })
})

describe('a statement already saved for the date', () => {
  it('blocks Save and names the one to edit; editing that statement is no duplicate', () => {
    const snapshot = snapshotOf()
    const r = read(snapshot, draftOf(snapshot, { cut: '2026-09-20', due: '2026-10-16' }))
    expect(r.duplicate?.id).toBe('rewards-last')
    expect(r.row).toBeNull()
    expect(blockedBy(r)).toBe('A statement for this date exists. Edit it, or change the cut date.')
    const opened = openStatement(snapshot, 'rewards-card', 'rewards-last')
    if (opened.kind !== 'ready' || !opened.editing) throw new Error('not opened')
    const editing = readStatement(snapshot, opened.card, initialDraft(snapshot, opened.card, opened.editing, LOCALE), { id: 'rewards-last', locale: LOCALE })
    expect([editing.duplicate, editing.check.state, editing.row?.total_due_minor]).toEqual([null, 'balances', 7000000])
  })
})

describe('warnings', () => {
  it('says when logged payments are larger than the printed figure, with both figures', () => {
    const snapshot = snapshotOf()
    const draft = draftOf(snapshot, { payments: '20,000.00', total: '58,525.00', minimum: '1,755.75' })
    const r = read(snapshot, draft)
    expect(r.check.state).toBe('balances')
    expect(draftWarnings(snapshot, cardOf(snapshot), draft, r, ID)).toEqual([{ kind: 'payments_and_credits', word: 'Payments and credits differ from what you logged', printed_minor: 2000000, expected_minor: 2500000 }])
    // As printed, nothing differs.
    const exact = draftOf(snapshot)
    expect(draftWarnings(snapshot, cardOf(snapshot), exact, read(snapshot, exact), ID)).toEqual([])
  })

  it('compares the previous balance with the last statement and the installments with the plan, in printed order', () => {
    const snapshot = snapshotOf()
    const draft = draftOf(snapshot, { previous: '71,000.00', installments: '5,500.00', total: '55,025.00' })
    expect(draftWarnings(snapshot, cardOf(snapshot), draft, read(snapshot, draft), ID).map((w) => [w.word, w.printed_minor, w.expected_minor])).toEqual([
      ['Previous balance differs from the last statement', 7100000, 7000000],
      ['Installments differ from your plan', 550000, 500000],
    ])
  })

  it('shows a part’s warning once it is typed, and every part’s once the statement balances, even off balance', () => {
    const snapshot = snapshotOf()
    const typing = { ...initialDraft(snapshot, cardOf(snapshot), null, LOCALE), previous: '71,000.00' }
    // Payments and installments are still blank, so their gaps from the logged rows and the plan are not shown yet.
    expect(draftWarnings(snapshot, cardOf(snapshot), typing, read(snapshot, typing), ID).map((w) => w.kind)).toEqual(['previous_balance'])
    const off = draftOf(snapshot, { payments: '20,000.00', total: '1.00' })
    expect(draftWarnings(snapshot, cardOf(snapshot), off, read(snapshot, off), ID).map((w) => w.kind)).toEqual(['payments_and_credits'])
    expect(draftWarnings(snapshot, cardOf(snapshot), { ...off, total_only: true }, read(snapshot, { ...off, total_only: true }), ID)).toEqual([])
  })

  it('checks an edit against the other statements, not the saved copy of itself', () => {
    const snapshot = snapshotOf((doc) => doc.statements.push({ id: 'oct', account_id: 'rewards-card', cut_date: '2026-10-20', due_date: '2026-11-16', total_due_minor: 5352500, minimum_due_minor: 160575 }))
    const opened = openStatement(snapshot, 'rewards-card', 'oct')
    if (opened.kind !== 'ready' || !opened.editing) throw new Error('not opened')
    const draft = { ...initialDraft(snapshot, opened.card, opened.editing, LOCALE), ...PRINTED, total_only: false, payments: '24,000.00', total: '54,525.00' }
    const r = readStatement(snapshot, opened.card, draft, { id: 'oct', locale: LOCALE })
    expect([r.duplicate, r.check.state]).toEqual([null, 'balances'])
    expect(draftWarnings(snapshot, opened.card, draft, r, 'oct').map((w) => [w.kind, w.printed_minor, w.expected_minor])).toEqual([['payments_and_credits', 2400000, 2500000]])
  })
})

describe('saving', () => {
  const row = (snapshot: Snapshot): Statement => {
    const r = read(snapshot, draftOf(snapshot))
    if (!r.row) throw new Error('does not balance')
    return r.row
  }

  it('adds a new statement, and edits a saved one only while it holds what was loaded', () => {
    const snapshot = snapshotOf()
    const added = row(snapshot)
    expect(statementEdit(added, 'user-1', null)).toEqual({ kind: 'add_statement', row: { ...added, household_id: 'user-1' } })
    const saved = snapshot.doc.statements.find((s) => s.id === 'rewards-last')
    if (!saved) throw new Error('no statement')
    expect(statementEdit({ ...saved, minimum_due_minor: 200000 }, 'user-1', saved)).toEqual({
      kind: 'edit_statement',
      before: { ...saved, household_id: 'user-1' },
      after: { ...saved, minimum_due_minor: 200000, household_id: 'user-1' },
    })
  })

  it('re-anchors the card at once: Debt detail reads Checked with the new remaining due', () => {
    const before = snapshotOf()
    const run = (snapshot: Snapshot) => {
      const r = runEngine(snapshot)
      if (!r.ok) throw new Error('the engine did not run')
      const detail = debtDetail(snapshot, r.walk, 'rewards-card')
      if (detail?.kind !== 'credit_card') throw new Error('no card detail')
      return detail.statement
    }
    expect(run(before)).toMatchObject({ chip: CHIPS.provisional, provisional: true })
    // The bank printed 30.00 more interest than the model.
    const r = read(before, draftOf(before, { interest: '1,555.00', total: '53,555.00' }))
    if (!r.row) throw new Error('does not balance')
    const after = snapshotOf((doc) => doc.statements.push(r.row as never))
    expect(run(after)).toMatchObject({ id: ID, chip: CHIPS.checked, provisional: false, cut_date: '2026-10-20', total_minor: 5355500, remaining_minor: 5355500 })
    const totalOnly = read(before, draftOf(before, { total_only: true, total: '53,000.00', minimum: '1,590.00' }))
    expect(run(snapshotOf((doc) => doc.statements.push(totalOnly.row as never)))).toMatchObject({ chip: CHIPS.total_only, remaining_minor: 5300000 })
  })

  it('words a refusal: a stale edit asks to show the latest', () => {
    expect(statementProblem(new DataError('rejected', 'stale', { code: 'stale' }))).toBe('This statement changed elsewhere since it opened, so nothing was saved. Show the latest to see what is saved now.')
    expect(statementProblem(new DataError('network', 'Waypoint could not reach the server.'))).toBe('Waypoint could not reach the server.')
  })
})

describe('filling from the statement PDF', () => {
  const pdf = (over: Partial<PdfStatement> = {}): PdfStatement => ({
    kind: 'statement',
    currency: 'PHP',
    issuer: 'Sample Bank Rewards',
    last4: '7890',
    cut_date: '2026-10-20',
    due_date: '2026-11-08',
    previous_balance_minor: 1000000,
    payments_and_credits_minor: 1000000,
    charges_minor: 200000,
    installments_minor: 50000,
    interest_minor: null,
    fees_minor: null,
    total_due_minor: 250000,
    minimum_due_minor: 50000,
    available_credit_minor: 4750000,
    off_by_minor: null,
    truncated: false,
    ...over,
  })

  it('fills every printed figure as if typed, so the live check balances and the row saves', () => {
    const snapshot = snapshotOf()
    const card = cardOf(snapshot)
    const draft = draftFromPdf(initialDraft(snapshot, card, null, LOCALE), pdf(), card, LOCALE)
    expect(draft).toMatchObject({ cut: '2026-10-20', due: '2026-11-08', due_typed: true, total_only: false, payments_2: null, interest: '', fees: '' })
    const read = readStatement(snapshot, card, draft, { id: ID, locale: LOCALE })
    expect(read.check.state).toBe('balances')
    expect(read.row).toMatchObject({ cut_date: '2026-10-20', due_date: '2026-11-08', previous_balance_minor: 1000000, charges_minor: 200000, installments_minor: 50000, interest_minor: 0, total_due_minor: 250000, minimum_due_minor: 50000, available_credit_minor: 4750000 })
  })

  it('keeps the sheet’s dates when none printed, saves Total only when no parts printed, and fills nothing in another currency', () => {
    const snapshot = snapshotOf()
    const card = cardOf(snapshot)
    const start = initialDraft(snapshot, card, null, LOCALE)
    const bare = draftFromPdf(start, pdf({ cut_date: null, due_date: null, previous_balance_minor: null, payments_and_credits_minor: null, charges_minor: null, installments_minor: null }), card, LOCALE)
    expect(bare).toMatchObject({ cut: start.cut, due: start.due, due_typed: false, total_only: true })
    expect(readStatement(snapshot, card, bare, { id: ID, locale: LOCALE }).check.state).toBe('total_only')
    expect([pdfMismatch(pdf(), card), pdfMismatch(pdf({ currency: 'USD' }), card)]).toEqual([null, `This statement is in USD and ${card.name} is in PHP. Choose ${card.name}’s statement.`])
    expect(pdfFilledNote(pdf({ cut_date: null, truncated: true }))).toBe('Sample Bank Rewards ending 7890. Check each figure against the PDF before you save. It printed no statement date, so pick the cut date. Only its first pages were read.')
  })
})
