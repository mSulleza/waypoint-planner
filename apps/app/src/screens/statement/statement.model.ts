import {
  addDays,
  addMonths,
  buildSnapshot,
  checkInput,
  cutIn,
  dueDate,
  firstOfMonth,
  parseAmount,
  slotCut,
  snapshotIndex,
  statementChecks,
  statementGap,
  statementRow,
  WARNING_WORDS,
  type CardAccount,
  type Snapshot,
  type Statement,
} from '@waypoint/core'
import type { StatementRead as PdfStatement } from '../../ai/pdf-read'
import type { DataError } from '../../data/errors'
import { ACCOUNT_VALUES, type AccountValues, type Edit, type SavedStatement } from '../../data/edits'
import { amountText, isDay } from '../../data/field-text'

// Spec §4 statements and §7 Statement: the printed fields in printed order, checked live against previous − payments and credits + charges + installments + interest + fees = total.

export const PARTS = ['previous', 'payments', 'charges', 'installments', 'interest', 'fees'] as const
export type Part = (typeof PARTS)[number]
export type Field = 'cut' | 'due' | Part | 'payments_2' | 'total' | 'minimum' | 'available'

export const LABELS: Readonly<Record<Field, string>> = {
  cut: 'Cut date',
  due: 'Due date',
  previous: 'Previous balance',
  payments: 'Payments and credits',
  payments_2: 'Payments and credits, second line',
  charges: 'Charges',
  installments: 'Installments',
  interest: 'Interest',
  fees: 'Fees',
  total: 'Total due',
  minimum: 'Minimum due',
  available: 'Available credit',
}

const COLUMN = {
  previous: 'previous_balance_minor',
  payments: 'payments_and_credits_minor',
  charges: 'charges_minor',
  installments: 'installments_minor',
  interest: 'interest_minor',
  fees: 'fees_minor',
} as const satisfies Record<Part, keyof Statement>

// Everything as typed; readStatement parses each amount once, in the household locale.
export interface StatementDraft {
  cut: string
  due: string
  // The due date follows the cut by the card's rule until the person types one.
  due_typed: boolean
  total_only: boolean
  previous: string
  payments: string
  // A second printed payments and credits line, summed into the one figure; null while there is one line.
  payments_2: string | null
  charges: string
  installments: string
  interest: string
  fees: string
  total: string
  minimum: string
  available: string
}

export type Opened = { kind: 'no_card' } | { kind: 'no_statement'; card: CardAccount } | { kind: 'ready'; card: CardAccount; editing: Statement | null }

// A day with its year; data/status's shortDay would pull React modules into this pure file.
const dayWithYear = (day: string, locale: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))

const statementsOf = (snapshot: Snapshot, cardId: string) => snapshotIndex(snapshot).statementsByAccount.get(cardId) ?? []

// /statement?account=<card>, and &statement=<id> to edit one already saved.
export function openStatement(snapshot: Snapshot, accountId: string | undefined, statementId: string | undefined): Opened {
  const card = accountId ? snapshotIndex(snapshot).accounts.get(accountId) : undefined
  if (card?.kind !== 'credit_card') return { kind: 'no_card' }
  if (!statementId) return { kind: 'ready', card, editing: null }
  const editing = statementsOf(snapshot, card.id).find((s) => s.id === statementId)
  return editing ? { kind: 'ready', card, editing } : { kind: 'no_statement', card }
}

// The latest cut by the card's cut day on or before a day.
export function cutOnOrBefore(card: CardAccount, day: string): string {
  const now = cutIn(card.terms.cut_day, day)
  return now <= day ? now : cutIn(card.terms.cut_day, addMonths(firstOfMonth(day), -1))
}

// The statement a card holds when it is added: the last cut on or before its opening date. Until a statement is entered, entering this one moves the opening back to its cut.
export function openingCut(snapshot: Snapshot, card: CardAccount): string {
  return statementsOf(snapshot, card.id).length === 0 ? cutOnOrBefore(card, card.opening_date) : card.opening_date
}

// The latest cut by the card's cut day on or before today, the opening cycle's included; null when the card started after it.
export function expectedCut(snapshot: Snapshot, card: CardAccount): string | null {
  const cut = cutOnOrBefore(card, snapshot.as_of)
  return cut >= openingCut(snapshot, card) ? cut : null
}

// The cut chips: the cut due to be entered and the one before it, while the card covers it.
export function cutChoices(snapshot: Snapshot, card: CardAccount): string[] {
  const latest = expectedCut(snapshot, card)
  if (latest === null) return []
  const before = cutOnOrBefore(card, addDays(latest, -1))
  return before >= openingCut(snapshot, card) ? [latest, before] : [latest]
}

const valuesOf = (a: CardAccount): AccountValues => Object.fromEntries(ACCOUNT_VALUES.map((c) => [c, a[c]])) as AccountValues

// Moves the card's opening date back to a cut before it, so the statement the person holds on day one can be entered.
export function openingEdit(card: CardAccount, cut: string): Edit {
  return { kind: 'edit_account', id: card.id, before: valuesOf(card), after: { opening_date: cut } }
}

// A new statement opens on the cut that is due to be entered, or on one already entered for that cycle (which then offers Edit); an edit opens on what is saved.
export function initialDraft(snapshot: Snapshot, card: CardAccount, editing: Statement | null, locale: string): StatementDraft {
  const text = (minor: number | null) => (minor === null ? '' : amountText(minor, card.currency, locale))
  if (editing) {
    return {
      cut: editing.cut_date,
      due: editing.due_date,
      due_typed: true,
      total_only: statementGap(editing) === null,
      previous: text(editing.previous_balance_minor),
      payments: text(editing.payments_and_credits_minor),
      payments_2: null,
      charges: text(editing.charges_minor),
      installments: text(editing.installments_minor),
      interest: text(editing.interest_minor),
      fees: text(editing.fees_minor),
      total: text(editing.total_due_minor),
      minimum: text(editing.minimum_due_minor),
      available: text(editing.available_credit_minor),
    }
  }
  const saved = statementsOf(snapshot, card.id)
  const expected = expectedCut(snapshot, card)
  const entered = expected === null ? undefined : saved.find((s) => slotCut(card.terms.cut_day, s.cut_date) === expected)
  const cut = entered?.cut_date ?? expected ?? ''
  // A bank that printed no breakdown last time likely prints none again.
  const last = saved.filter((s) => s.cut_date <= snapshot.as_of).at(-1)
  return {
    cut,
    due: entered?.due_date ?? (cut ? dueDate(card.terms, cut) : ''),
    due_typed: false,
    total_only: last !== undefined && statementGap(last) === null,
    previous: '',
    payments: '',
    payments_2: null,
    charges: '',
    installments: '',
    interest: '',
    fees: '',
    total: '',
    minimum: '',
    available: '',
  }
}

// Eight digits read as a day, so a phone's number pad can type one: 20260920 is 2026-09-20.
export function readDay(text: string): string {
  const t = text.trim()
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}` : t
}

// A new cut moves the due date with it by the card's rule, until the person has typed a due date.
export function changeCut(card: CardAccount, draft: StatementDraft, cut: string): StatementDraft {
  const day = readDay(cut)
  return { ...draft, cut, due: draft.due_typed || !isDay(day) ? draft.due : dueDate(card.terms, day) }
}

// Why a statement read from its PDF cannot fill this card's sheet: its amounts are in another currency. Null when it can.
export function pdfMismatch(read: PdfStatement, card: CardAccount): string | null {
  return read.currency === card.currency ? null : `This statement is in ${read.currency} and ${card.name} is in ${card.currency}. Choose ${card.name}’s statement.`
}

// Under Filled from: which card the PDF is for, so a wrong file shows at once, and what to check before Save.
export function pdfFilledNote(read: PdfStatement): string {
  const card = [read.issuer, read.last4 ? `ending ${read.last4}` : ''].filter(Boolean).join(' ')
  const pages = read.truncated ? ' Only its first pages were read.' : ''
  const dates = read.cut_date === null ? ' It printed no statement date, so pick the cut date.' : ''
  return `${card ? `${card}. ` : ''}Check each figure against the PDF before you save.${dates}${pages}`
}

// A statement read from its PDF, as if typed: each printed figure written the household's way, its dates as days, and Total only when it printed no parts. A part with no printed line stays blank, which reads as 0; a date it did not print keeps the sheet's own.
export function draftFromPdf(draft: StatementDraft, read: PdfStatement, card: CardAccount, locale: string): StatementDraft {
  const text = (minor: number | null) => (minor === null ? '' : amountText(minor, card.currency, locale))
  const parts = [read.previous_balance_minor, read.payments_and_credits_minor, read.charges_minor, read.installments_minor, read.interest_minor, read.fees_minor]
  const filled = read.cut_date === null ? draft : changeCut(card, draft, read.cut_date)
  return {
    ...filled,
    due: read.due_date ?? filled.due,
    due_typed: read.due_date !== null || filled.due_typed,
    total_only: parts.every((p) => p === null),
    previous: text(read.previous_balance_minor),
    payments: text(read.payments_and_credits_minor),
    payments_2: null,
    charges: text(read.charges_minor),
    installments: text(read.installments_minor),
    interest: text(read.interest_minor),
    fees: text(read.fees_minor),
    total: text(read.total_due_minor),
    minimum: text(read.minimum_due_minor),
    available: text(read.available_credit_minor),
  }
}

// The printed payments and credits lines as one figure; a blank line counts nothing, and null means a line does not read as an amount.
export function paymentsSum(first: string, second: string | null, locale: string, currency: string): number | null {
  let sum = 0
  for (const line of [first, second ?? '']) {
    if (line.trim() === '') continue
    const minor = parseAmount(line, locale, currency)
    if (minor === null) return null
    sum += minor
  }
  return sum
}

// previous − payments and credits + charges + installments + interest + fees.
export function partsSum(parts: Readonly<Record<Part, number>>): number {
  return parts.previous - parts.payments + parts.charges + parts.installments + parts.interest + parts.fees
}

// What the total is off by: total − the parts' sum, 0 when the statement balances.
export function difference(parts: Readonly<Record<Part, number>>, total: number): number {
  const gap = statementGap({
    previous_balance_minor: parts.previous,
    payments_and_credits_minor: parts.payments,
    charges_minor: parts.charges,
    installments_minor: parts.installments,
    interest_minor: parts.interest,
    fees_minor: parts.fees,
    total_due_minor: total,
  })
  if (gap === null) throw new Error('every part is a number, so the gap is too')
  return gap
}

export type Check =
  | { state: 'total_only' }
  // The total is not typed yet, or a part does not read.
  | { state: 'waiting'; reason: 'total' | 'parts' }
  | { state: 'balances'; sum_minor: number }
  | { state: 'off'; difference_minor: number; sum_minor: number; total_minor: number }

export interface StatementRead {
  // Each field that does not read, in plain words; a blank required field is listed in missing instead.
  errors: Partial<Record<Field, string>>
  missing: readonly Field[]
  // The six parts in minor units, a blank part as 0; null for a total-only statement or while one does not read.
  parts: Readonly<Record<Part, number>> | null
  check: Check
  // Another statement on this card with this cut date: Save waits, and Edit opens it.
  duplicate: Statement | null
  // The row to save, once every field reads, it balances and no other statement has this cut date.
  row: Statement | null
  // The opening cycle's cut, before the card's opening date: Save moves the opening back to it first.
  opening: string | null
}

const NOT_AMOUNT = 'Enter the amount as printed.'
const NO_MINUS = 'Enter it without a minus sign.'

export function readStatement(snapshot: Snapshot, card: CardAccount, draft: StatementDraft, options: { id: string; locale: string }): StatementRead {
  const { id, locale } = options
  const currency = card.currency
  const errors: Partial<Record<Field, string>> = {}
  const missing: Field[] = []

  const cut = readDay(draft.cut)
  const due = readDay(draft.due)
  if (cut === '') missing.push('cut')
  else if (!isDay(cut)) errors.cut = 'Pick the cut date.'
  else if (cut > snapshot.as_of) errors.cut = 'This day has not come yet. Enter the statement once it has printed.'
  else if (cut < card.opening_date && slotCut(card.terms.cut_day, cut) !== openingCut(snapshot, card)) errors.cut = `${card.name} starts in Waypoint on ${dayWithYear(card.opening_date, locale)}; enter a statement cut on or after ${dayWithYear(openingCut(snapshot, card), locale)}.`
  const opening = isDay(cut) && !errors.cut && cut < card.opening_date ? cut : null
  if (due === '') missing.push('due')
  else if (!isDay(due)) errors.due = 'Pick the due date.'
  else if (isDay(cut) && due < cut) errors.due = 'The due date cannot be before the cut date.'

  // A blank amount reads as null; text that is not an amount sets the field's error.
  const amount = (field: Field, text: string, signed: boolean): number | null => {
    if (text.trim() === '') return null
    const minor = parseAmount(text, locale, currency)
    if (minor === null) errors[field] = NOT_AMOUNT
    else if (!signed && minor < 0) errors[field] = NO_MINUS
    else return minor
    return null
  }

  let parts: Record<Part, number> | null = null
  if (!draft.total_only) {
    const read = {
      previous: amount('previous', draft.previous, true),
      payments: amount('payments', draft.payments, false),
      payments_2: draft.payments_2 === null ? null : amount('payments_2', draft.payments_2, false),
      charges: amount('charges', draft.charges, false),
      installments: amount('installments', draft.installments, false),
      interest: amount('interest', draft.interest, false),
      fees: amount('fees', draft.fees, false),
    }
    const partErrors = PARTS.some((p) => errors[p]) || errors.payments_2 !== undefined
    if (!partErrors) {
      parts = {
        previous: read.previous ?? 0,
        payments: (read.payments ?? 0) + (read.payments_2 ?? 0),
        charges: read.charges ?? 0,
        installments: read.installments ?? 0,
        interest: read.interest ?? 0,
        fees: read.fees ?? 0,
      }
    }
  }

  const total = amount('total', draft.total, true)
  if (draft.total.trim() === '') missing.push('total')
  const minimum = amount('minimum', draft.minimum, false)
  if (draft.minimum.trim() === '') missing.push('minimum')
  else if (minimum !== null && total !== null && minimum > Math.max(total, 0)) errors.minimum = total > 0 ? 'The minimum cannot be more than the total due.' : 'Nothing is due, so the minimum is 0.'
  const available = amount('available', draft.available, true)

  let check: Check
  if (draft.total_only) check = { state: 'total_only' }
  else if (parts === null) check = { state: 'waiting', reason: 'parts' }
  else if (total === null) check = { state: 'waiting', reason: 'total' }
  else {
    const gap = difference(parts, total)
    const sum = partsSum(parts)
    check = gap === 0 ? { state: 'balances', sum_minor: sum } : { state: 'off', difference_minor: gap, sum_minor: sum, total_minor: total }
  }

  const others = isDay(cut) ? statementsOf(snapshot, card.id).filter((s) => s.id !== id) : []
  const duplicate = others.find((s) => s.cut_date === cut) ?? null

  const ready = Object.keys(errors).length === 0 && missing.length === 0 && duplicate === null && total !== null && minimum !== null && (check.state === 'balances' || check.state === 'total_only')
  let row: Statement | null = null
  if (ready) {
    const part = (p: Part) => (parts ? parts[p] : null)
    const candidate = {
      id,
      account_id: card.id,
      cut_date: cut,
      due_date: due,
      ...(Object.fromEntries(PARTS.map((p) => [COLUMN[p], part(p)])) as Record<(typeof COLUMN)[Part], number | null>),
      total_due_minor: total,
      minimum_due_minor: minimum,
      available_credit_minor: available,
    }
    // Core's own row check, so nothing the database would refuse is sent.
    const checked = checkInput(statementRow, candidate)
    row = checked.ok ? checked.value : null
  }
  return { errors, missing, parts, check, duplicate, row, opening }
}

const listOf = (words: readonly string[]) => (words.length <= 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)

// Why Save is off, in the order a person would fix it; null when it can save.
export function blockedBy(read: StatementRead): string | null {
  if (read.duplicate) return 'A statement for this date exists. Edit it, or change the cut date.'
  if (Object.keys(read.errors).length > 0) return 'Check the fields marked above.'
  if (read.missing.length > 0) return `Enter the ${listOf(read.missing.map((f) => LABELS[f].toLowerCase()))}.`
  if (read.check.state === 'off') return 'Save is off until the parts add up to the total due.'
  return read.row ? null : 'This statement did not pass the checks.'
}

export type WarningKind = 'previous_balance' | 'payments_and_credits' | 'installments'

export interface DraftWarning {
  kind: WarningKind
  word: string
  printed_minor: number
  expected_minor: number
}

// In printed order.
const WARNING_KINDS: readonly WarningKind[] = ['previous_balance', 'payments_and_credits', 'installments']

// Typing the total or the minimum changes nothing the checks read, so the last answer per snapshot is kept.
const LAST_WARNINGS = new WeakMap<Snapshot, { key: string; warnings: DraftWarning[] }>()

// Core's statement checks on this draft as if it were saved (they never stop Save). A part shows its warning once typed, and every part once the statement balances.
export function draftWarnings(snapshot: Snapshot, card: CardAccount, draft: StatementDraft, read: StatementRead, id: string): DraftWarning[] {
  const cut = readDay(draft.cut)
  if (read.parts === null || read.duplicate || read.errors.cut || !isDay(cut)) return []
  const due = readDay(draft.due)
  const parts = read.parts
  // The checks read the parts only, so the trial carries the parts' own total and a 0 minimum while the typed ones are off.
  const trial: Statement = {
    id,
    account_id: card.id,
    cut_date: cut,
    due_date: isDay(due) && due >= cut ? due : cut,
    previous_balance_minor: parts.previous,
    payments_and_credits_minor: parts.payments,
    charges_minor: parts.charges,
    installments_minor: parts.installments,
    interest_minor: parts.interest,
    fees_minor: parts.fees,
    total_due_minor: partsSum(parts),
    minimum_due_minor: 0,
    available_credit_minor: null,
  }
  const balanced = read.check.state === 'balances'
  const typed: Record<WarningKind, boolean> = {
    previous_balance: draft.previous.trim() !== '',
    payments_and_credits: draft.payments.trim() !== '' || (draft.payments_2 ?? '').trim() !== '',
    installments: draft.installments.trim() !== '',
  }
  const key = JSON.stringify([trial, balanced, typed])
  const last = LAST_WARNINGS.get(snapshot)
  if (last?.key === key) return last.warnings
  let checks: ReturnType<typeof statementChecks>
  try {
    const doc = snapshot.doc
    const sandbox = buildSnapshot({ ...doc, statements: [...doc.statements.filter((s) => s.id !== id), trial] }, snapshot.as_of, snapshot.rates)
    checks = statementChecks(sandbox, trial)
  } catch {
    return []
  }
  const warnings = WARNING_KINDS.flatMap((kind) => {
    const found = checks[kind]
    return found && (balanced || typed[kind]) ? [{ kind, word: WARNING_WORDS[kind], printed_minor: found.printed_minor, expected_minor: found.expected_minor }] : []
  })
  LAST_WARNINGS.set(snapshot, { key, warnings })
  return warnings
}

// Save: a new statement is one insert, which a retry from the same sheet repeats harmlessly; an edit changes the row only while it still holds what was loaded.
export function statementEdit(row: Statement, householdId: string, editing: Statement | null): Edit {
  const after: SavedStatement = { ...row, household_id: householdId }
  return editing ? { kind: 'edit_statement', before: { ...editing, household_id: householdId }, after } : { kind: 'add_statement', row: after }
}

// A refused save in plain words. A duplicate cut needs none: the household reloads, and the statement it found shows with Edit.
export function statementProblem(error: DataError): string {
  if (error.code === 'stale') return 'This statement changed elsewhere since it opened, so nothing was saved. Show the latest to see what is saved now.'
  if (error.code === 'statement_exists') return 'A statement for this date was saved elsewhere. It shows above once Waypoint has reloaded.'
  return error.message
}
