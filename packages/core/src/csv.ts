import Papa from 'papaparse'
import { z } from 'zod'
import { daysBetween, daysInMonth } from './dates'
import { fnv1a64 } from './hash'
import { parseAmount } from './money'
import { checkInput, strictKeys, type Checked } from './schema/common'

// A bank's CSV file, parsed on the device (spec §9): the header's column names and the rows under it, every cell as text.
export interface CsvTable {
  header: readonly string[]
  rows: readonly (readonly string[])[]
}

export type CsvFile = { ok: true; table: CsvTable } | { ok: false; error: string }

// Blank and repeated header cells get names of their own, since a mapping names its columns.
function headerNames(cells: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return cells.map((cell, i) => {
    const name = cell.trim() || `Column ${i + 1}`
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    return n === 1 ? name : `${name} (${n})`
  })
}

export function readCsv(text: string): CsvFile {
  const parsed = Papa.parse(text.replace(/^\ufeff/, ''), { skipEmptyLines: 'greedy' })
  const broken = parsed.errors.find((e) => e.type === 'Quotes')
  if (broken) return { ok: false, error: `A quotation mark is not closed${broken.row === undefined ? '' : ` near row ${broken.row + 1}`}, so the file does not split into columns.` }
  const [first, ...rows] = parsed.data
  if (!first || first.length < 2) return { ok: false, error: 'The file does not split into columns, so it is not a CSV file of transactions.' }
  if (rows.length === 0) return { ok: false, error: 'The file has a header and no rows under it.' }
  return { ok: true, table: { header: headerNames(first), rows } }
}

export const CSV_DATE_ORDERS = ['ymd', 'dmy', 'mdy'] as const
export type CsvDateOrder = (typeof CSV_DATE_ORDERS)[number]
export const CSV_DECIMALS = ['.', ','] as const
export type CsvDecimal = (typeof CSV_DECIMALS)[number]

const column = z.string().min(1, 'must name a column')

// One account's columns, remembered in accounts.csv_mapping and named by header, so the next file maps itself on any device.
export const csvMapping = strictKeys({
  date: column,
  date_order: z.enum(CSV_DATE_ORDERS),
  // One signed column, or money out and money in in two.
  amount: z.union([strictKeys({ column }), strictKeys({ debit: column, credit: column })]),
  decimal: z.enum(CSV_DECIMALS),
  description: column,
  // A column naming each row alone, such as the bank's transaction id.
  reference: column.nullable().default(null),
}).superRefine((m, ctx) => {
  if ('debit' in m.amount && m.amount.debit === m.amount.credit) ctx.addIssue({ code: 'custom', message: 'money out and money in must be two columns', path: ['amount', 'credit'] })
})

export type CsvMapping = z.output<typeof csvMapping>

// The columns a mapping reads, each once.
export function mappedColumns(mapping: CsvMapping): string[] {
  const amount = 'column' in mapping.amount ? [mapping.amount.column] : [mapping.amount.debit, mapping.amount.credit]
  return [...new Set([mapping.date, ...amount, mapping.description, ...(mapping.reference === null ? [] : [mapping.reference])])]
}

// A saved mapping that still fits this file: every column it names is in the header.
export function savedMapping(saved: unknown, table: CsvTable): CsvMapping | null {
  const checked = checkInput(csvMapping, saved)
  return checked.ok && mappedColumns(checked.value).every((c) => table.header.includes(c)) ? checked.value : null
}

const DATE = /^(\d{1,4})[-/. ](\d{1,2})[-/. ](\d{1,4})(?=$|[T\s,])/
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/

// A day as the bank wrote it, in the mapping's order, with any separator and an optional time after it: 'YYYY-MM-DD', or null.
export function readCsvDay(text: string, order: CsvDateOrder): string | null {
  const s = text.trim()
  const m = (order === 'ymd' ? COMPACT.exec(s) : null) ?? DATE.exec(s)
  if (!m) return null
  const [a = '', b = '', c = ''] = m.slice(1)
  const [y, mo, d] = order === 'ymd' ? [a, b, c] : order === 'dmy' ? [c, b, a] : [c, a, b]
  if ((order === 'ymd' ? y.length !== 4 : y.length !== 4 && y.length !== 2) || mo.length > 2 || d.length > 2) return null
  const year = y.length === 2 ? 2000 + Number(y) : Number(y)
  const [month, day] = [Number(mo), Number(d)]
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null
  const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
  return day > daysInMonth(key) ? null : `${key}-${String(day).padStart(2, '0')}`
}

const GROUPING = /[\s\u00a0\u202f'\u2019]/g
// A locale whose decimal mark is the mapping's and whose grouping mark is the other one, for core's one amount parser.
const DECIMAL_LOCALE: Record<CsvDecimal, string> = { '.': 'en', ',': 'de' }

// An amount cell in minor units, signed as written; brackets and a trailing minus read as negative, as some banks print them. null when it does not read.
export function readCsvAmount(text: string, decimal: CsvDecimal, currency: string): number | null {
  let s = text.trim()
  let negative = false
  const bracketed = /^\((.*)\)$/.exec(s)
  if (bracketed) {
    negative = true
    s = (bracketed[1] ?? '').trim()
  } else if (/^[^-+\u2212].*[-\u2212]$/.test(s)) {
    negative = true
    s = s.slice(0, -1).trim()
  }
  const minor = parseAmount(s.replace(GROUPING, ''), DECIMAL_LOCALE[decimal], currency)
  return minor === null ? null : negative ? -Math.abs(minor) : minor
}

// The longest note a transaction keeps (transactions.description).
export const DESCRIPTION_MAX = 140

function cleanDescription(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length <= DESCRIPTION_MAX ? s : s.slice(0, DESCRIPTION_MAX).replace(/[\ud800-\udbff]$/, '')
}

export interface CsvDraft {
  // The row in the file, the header being row 1, as a spreadsheet numbers it when no line is blank.
  row: number
  posted_on: string
  // Read once here, in the account's currency: money in positive, money out negative.
  amount_minor: number
  // By sign; a person may make money in a refund.
  kind: 'expense' | 'income'
  description: string
  // The reference when no other row in the file shares it, else 'csv:' + fnv1a64 of day|amount|description|n, n being the row's place among identical rows.
  external_id: string
  // The bank's reference as the file prints it, '' when it has none; kept when the file repeats it, so a row an earlier file saved under it can still be found.
  reference: string
}

// Why a row was left out: its date or amount did not read, its amount is 0, or it is dated before the account opens.
export type CsvProblem = 'date' | 'amount' | 'zero' | 'before_opening'

export interface CsvSkip {
  row: number
  problem: CsvProblem
  // The cell as written, for the date and amount problems.
  text: string
}

export interface CsvRead {
  drafts: CsvDraft[]
  skipped: CsvSkip[]
}

export interface CsvAccount {
  currency: string
  opening_date: string
}

type AmountRead = { minor: number } | { problem: 'amount'; text: string }

function rowAmount(cell: (name: string) => string, mapping: CsvMapping, currency: string): AmountRead {
  const read = (name: string): number | null => {
    const text = cell(name)
    return text.trim() === '' ? 0 : readCsvAmount(text, mapping.decimal, currency)
  }
  if ('column' in mapping.amount) {
    const text = cell(mapping.amount.column)
    const minor = text.trim() === '' ? null : readCsvAmount(text, mapping.decimal, currency)
    return minor === null ? { problem: 'amount', text } : { minor }
  }
  const [debit, credit] = [read(mapping.amount.debit), read(mapping.amount.credit)]
  const both = `${cell(mapping.amount.debit)} ${cell(mapping.amount.credit)}`.trim()
  // A bank may print money out with or without its minus sign.
  if (debit === null || credit === null || both === '') return { problem: 'amount', text: both }
  return { minor: Math.abs(credit) - Math.abs(debit) }
}

// Every row of the file as a draft transaction, or why it was left out. Refuses a mapping that names a column the file lacks.
export function csvDrafts(table: CsvTable, mapping: CsvMapping, account: CsvAccount): Checked<CsvRead> {
  const missing = mappedColumns(mapping).filter((c) => !table.header.includes(c))
  if (missing.length > 0) return { ok: false, errors: missing.map((c) => `The file has no column named ${c}.`) }
  const at = new Map(table.header.map((name, i) => [name, i]))
  const references = new Map<string, number>()
  if (mapping.reference !== null) {
    const i = at.get(mapping.reference) ?? -1
    for (const r of table.rows) {
      const ref = (r[i] ?? '').trim()
      if (ref !== '') references.set(ref, (references.get(ref) ?? 0) + 1)
    }
  }
  const identical = new Map<string, number>()
  const draftOf = (row: number, posted: string, minor: number, description: string, ref: string): CsvDraft => {
    let external = ref
    if (ref === '' || (references.get(ref) ?? 0) > 1) {
      const key = `${posted}|${minor}|${description}`
      const n = identical.get(key) ?? 0
      identical.set(key, n + 1)
      external = `csv:${fnv1a64(`${key}|${n}`)}`
    }
    return { row, posted_on: posted, amount_minor: minor, kind: minor < 0 ? 'expense' : 'income', description, external_id: external, reference: ref }
  }
  const drafts: CsvDraft[] = []
  const skipped: CsvSkip[] = []
  for (const [index, r] of table.rows.entries()) {
    const row = index + 2
    const cell = (name: string) => r[at.get(name) ?? -1] ?? ''
    const posted = readCsvDay(cell(mapping.date), mapping.date_order)
    const amount = posted === null ? null : rowAmount(cell, mapping, account.currency)
    if (posted === null || amount === null) skipped.push({ row, problem: 'date', text: cell(mapping.date) })
    else if ('problem' in amount) skipped.push({ row, problem: 'amount', text: amount.text })
    else if (amount.minor === 0) skipped.push({ row, problem: 'zero', text: '' })
    else if (posted < account.opening_date) skipped.push({ row, problem: 'before_opening', text: posted })
    else drafts.push(draftOf(row, posted, amount.minor, cleanDescription(cell(mapping.description)), mapping.reference === null ? '' : cell(mapping.reference).trim()))
  }
  return { ok: true, value: { drafts, skipped } }
}

// A description with its figures and punctuation taken out, so 'Card transaction of 12.40 EUR issued by Corner Bakery' matches the same shop at another amount.
export function descriptionKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[\d.,:;/#*+\-()[\]'"_|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The mapping form before every choice is made.
export interface CsvMappingDraft {
  date: string | null
  date_order: CsvDateOrder | null
  two_columns: boolean
  amount: string | null
  debit: string | null
  credit: string | null
  decimal: CsvDecimal
  description: string | null
  reference: string | null
}

export function csvMappingDraft(mapping: CsvMapping): CsvMappingDraft {
  const two = 'debit' in mapping.amount
  return {
    date: mapping.date,
    date_order: mapping.date_order,
    two_columns: two,
    amount: 'column' in mapping.amount ? mapping.amount.column : null,
    debit: 'debit' in mapping.amount ? mapping.amount.debit : null,
    credit: 'debit' in mapping.amount ? mapping.amount.credit : null,
    decimal: mapping.decimal,
    description: mapping.description,
    reference: mapping.reference,
  }
}

// The draft as a mapping, with an error per field still empty or in conflict.
export function readCsvMappingDraft(draft: CsvMappingDraft): Checked<CsvMapping> {
  return checkInput(csvMapping, {
    date: draft.date ?? '',
    date_order: draft.date_order ?? '',
    amount: draft.two_columns ? { debit: draft.debit ?? '', credit: draft.credit ?? '' } : { column: draft.amount ?? '' },
    decimal: draft.decimal,
    description: draft.description ?? '',
    reference: draft.reference,
  })
}

// Whether the household's own dates put the day or the month first, to settle 07/10 when both read.
function dayFirst(locale: string): boolean {
  const parts = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).formatToParts(Date.UTC(2026, 9, 7))
  return parts.findIndex((p) => p.type === 'day') < parts.findIndex((p) => p.type === 'month')
}

// The days a column's dates cover in one order: a statement spans days or weeks, so 03/10 to 06/10 is four days in October, not four months.
function span(values: readonly string[], order: CsvDateOrder): number {
  const days = values.map((v) => readCsvDay(v, order)).filter((d): d is string => d !== null).sort()
  return days.length === 0 ? 0 : daysBetween(days[0] ?? '', days.at(-1) ?? '')
}

// The order that reads the most dates of the column, so one bad cell does not hide it. Year first wins a tie; between day and month first, the shorter span, then dotted dates and the household's own order.
function likelyOrder(values: readonly string[], locale: string): CsvDateOrder | null {
  const reads = (order: CsvDateOrder) => values.filter((v) => readCsvDay(v, order) !== null).length
  const [ymd, dmy, mdy] = CSV_DATE_ORDERS.map(reads) as [number, number, number]
  const best = Math.max(ymd, dmy, mdy)
  if (best === 0) return null
  if (ymd === best) return 'ymd'
  if (dmy !== mdy) return dmy > mdy ? 'dmy' : 'mdy'
  const [byDay, byMonth] = [span(values, 'dmy'), span(values, 'mdy')]
  if (byDay !== byMonth) return byDay < byMonth ? 'dmy' : 'mdy'
  // Dotted dates such as 07.10.2026 put the day first wherever they are written.
  return dayFirst(locale) || values.some((v) => /^\d{1,2}\.\d{1,2}\./.test(v.trim())) ? 'dmy' : 'mdy'
}

function localeDecimal(locale: string): CsvDecimal {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value === ',' ? ',' : '.'
}

function firstHeader(header: readonly string[], patterns: readonly RegExp[], skip: RegExp | null = null): string | null {
  for (const p of patterns) {
    const found = header.find((h) => p.test(h) && !(skip?.test(h) ?? false))
    if (found) return found
  }
  return null
}

const DATE_HEADERS = [/^date$/i, /date|datum|fecha|buchungstag/i]
const AMOUNT_HEADERS = [/^amount$/i, /amount|betrag|importe|monto|montant|bedrag/i]
const NOT_AMOUNT = /\b(balance|saldo|fees?|exchange|original|total|rate)\b/i
const DEBIT_HEADERS = [/debit|withdrawal|paid out|money out|^out$|outflow/i]
const CREDIT_HEADERS = [/credit|deposit|paid in|money in|^in$|inflow/i]
const DESCRIPTION_HEADERS = [/^description$/i, /description|details|narrative|particulars|memo|merchant|payee|concepto|verwendungszweck|libell/i]
// Only a column named as an id: a free-text 'Reference' such as 'Rent' repeats from month to month and would hide new rows as imported.
const REFERENCE_HEADERS = [/(^|\s)id$/i, /transaction id|reference (no|number)/i]

// A first mapping from the header's names and the values under them; the person checks each choice before it is saved.
export function guessCsvMapping(table: CsvTable, locale: string): CsvMappingDraft {
  const values = (name: string | null) => {
    const i = name === null ? -1 : table.header.indexOf(name)
    return i < 0 ? [] : table.rows.map((r) => r[i] ?? '')
  }
  const date = firstHeader(table.header, DATE_HEADERS, /value|valuta/i) ?? firstHeader(table.header, DATE_HEADERS)
  const order = likelyOrder(values(date), locale)
  const amount = firstHeader(table.header, AMOUNT_HEADERS, NOT_AMOUNT)
  const debit = firstHeader(table.header, DEBIT_HEADERS, NOT_AMOUNT)
  const credit = firstHeader(table.header, CREDIT_HEADERS, NOT_AMOUNT)
  const two = amount === null && debit !== null && credit !== null && debit !== credit
  const figures = two ? [...values(debit), ...values(credit)] : values(amount)
  const commas = figures.filter((v) => /\d,\d{1,2}\)?-?$/.test(v.trim())).length
  const points = figures.filter((v) => /\d\.\d{1,2}\)?-?$/.test(v.trim())).length
  const description = firstHeader(table.header, DESCRIPTION_HEADERS)
  return {
    date,
    date_order: order,
    two_columns: two,
    amount: two ? null : amount,
    debit: two ? debit : null,
    credit: two ? credit : null,
    decimal: commas > points ? ',' : points > commas ? '.' : localeDecimal(locale),
    description,
    reference: firstHeader(table.header, REFERENCE_HEADERS),
  }
}
