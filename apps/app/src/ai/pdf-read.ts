import { askDeepSeek, caller, fail, type AiEnv, type Fail } from './deepseek'

// The server side of Fill from PDF: a card statement or a receipt read by DeepSeek from the PDF's text. The text is taken from the PDF on the server, card and account numbers are masked, and every figure DeepSeek gives back is checked and turned into minor units here. Nothing is saved: the app fills the Statement or Add sheet, whose own checks run before Save. Plain TypeScript with no imports at run time but the shared DeepSeek call, so the reading library stays in the function that passes it in.

// Under Vercel's 4.5 MB request limit once the file is base64.
export const MAX_PDF_BYTES = 3_000_000
// The text DeepSeek reads; a statement's summary sits on its first pages.
export const MAX_TEXT = 60_000
const PASSWORD_MAX = 128
const CATEGORIES_MAX = 300
const ISSUER_MAX = 60
const MERCHANT_MAX = 60
const SUMMARY_MAX = 100
// A text layer with fewer letters and figures than this is a scan, which DeepSeek cannot read.
const MIN_TEXT = 40

export type PdfTask = 'statement' | 'receipt'

export interface PdfRequest {
  task: PdfTask
  // The file as base64.
  pdf: string
  password: string | null
  // A statement: the card's currency. A receipt: the account's, used when the receipt names none.
  currency: string
  // A receipt: the household's open categories, one of which DeepSeek may suggest.
  categories: { id: string; name: string }[]
}

export type PdfReadRequest = { task: 'status' } | PdfRequest

// What the reading library gives back: each page's text, or why there is none.
export type PdfText = { ok: true; pages: string[]; more: boolean } | { ok: false; error: 'needs_password' | 'wrong_password' | 'not_pdf' }
export type ExtractText = (bytes: Uint8Array, password: string | null) => Promise<PdfText>

// The printed figures of one card statement, in minor units of its currency; null where the statement prints none.
export interface StatementRead {
  kind: 'statement'
  currency: string
  // The bank and card as printed, and the card number's last four digits.
  issuer: string
  last4: string | null
  cut_date: string | null
  due_date: string | null
  previous_balance_minor: number | null
  payments_and_credits_minor: number | null
  charges_minor: number | null
  installments_minor: number | null
  interest_minor: number | null
  fees_minor: number | null
  total_due_minor: number
  minimum_due_minor: number | null
  available_credit_minor: number | null
  // Previous − payments and credits + charges + installments + interest + fees − total; null while a part is missing.
  off_by_minor: number | null
  // Pages past the ones read, or text past MAX_TEXT, were left out.
  truncated: boolean
}

export interface ReceiptRead {
  kind: 'receipt'
  currency: string
  merchant: string
  date: string | null
  // What was paid, tax included; positive.
  total_minor: number
  category_id: string | null
  // What was bought, in a few words.
  summary: string
  truncated: boolean
}

export type PdfReply = { enabled: boolean } | StatementRead | ReceiptRead

const isCurrency = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v)
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function readPdfRequest(body: unknown): PdfReadRequest | Fail {
  const b = body as Record<string, unknown> | null
  if (b?.task === 'status') return { task: 'status' }
  if ((b?.task !== 'statement' && b?.task !== 'receipt') || typeof b.pdf !== 'string' || !isCurrency(b.currency)) return fail(400, 'bad_request')
  const pdf = b.pdf.replace(/\s+/g, '')
  if (pdf.length === 0 || pdf.length % 4 !== 0 || !BASE64.test(pdf)) return fail(400, 'bad_request')
  if ((pdf.length / 4) * 3 > MAX_PDF_BYTES + 2) return fail(413, 'too_large')
  const password = typeof b.password === 'string' && b.password !== '' ? b.password : null
  if (password !== null && password.length > PASSWORD_MAX) return fail(400, 'bad_request')
  const categories: { id: string; name: string }[] = []
  if (b.task === 'receipt' && Array.isArray(b.categories)) {
    for (const c of b.categories.slice(0, CATEGORIES_MAX)) {
      const { id, name } = (c ?? {}) as Record<string, unknown>
      if (typeof id === 'string' && id !== '' && id.length <= 64 && typeof name === 'string' && name.trim() !== '') categories.push({ id, name: name.trim().slice(0, 40) })
    }
  }
  return { task: b.task, pdf, password, currency: b.currency, categories }
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// A PDF starts with %PDF- within its first kilobyte.
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, 1024))
  return head.includes('%PDF-')
}

// One text item as pdf.js gives it: the string, its transform (x and y are [4] and [5]) and its width.
export interface TextItem {
  str: string
  transform: readonly number[]
  width: number
}

// The page's text row by row, top to bottom: items whose baselines are within ROW_GAP points share a row, read left to right, with three spaces where a column gap falls. A bank prints a label and its figure as two items on one baseline, which a plain join tears apart.
const ROW_GAP = 2.5
const COLUMN_GAP = 12
export function pageRows(items: readonly TextItem[]): string {
  const rows: { y: number; cells: { x: number; end: number; s: string }[] }[] = []
  for (const it of items) {
    const s = it.str.trim()
    if (s === '') continue
    const x = it.transform[4] ?? 0
    const y = it.transform[5] ?? 0
    let row = rows.find((r) => Math.abs(r.y - y) < ROW_GAP)
    if (!row) rows.push((row = { y, cells: [] }))
    row.cells.push({ x, end: x + it.width, s })
  }
  rows.sort((a, b) => b.y - a.y)
  return rows
    .map((r) => {
      r.cells.sort((a, b) => a.x - b.x)
      let line = ''
      let end: number | null = null
      for (const c of r.cells) {
        if (end !== null) line += c.x - end > COLUMN_GAP ? '   ' : c.x - end > 1.5 ? ' ' : ''
        line += c.s
        end = c.end
      }
      return line
    })
    .join('\n')
}

// Card and account numbers keep their last four digits, and email addresses go, before any text leaves for DeepSeek. A run of ten or more digits, single spaces or dashes allowed between them, is a number to mask; an amount's comma or decimal point ends a run.
export function maskNumbers(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]').replace(/\d(?:[ -]?\d){9,}/g, (run) => `••••${run.replace(/\D/g, '').slice(-4)}`)
}

// The pages as DeepSeek reads them, masked and cut to MAX_TEXT.
export function promptText(pages: readonly string[]): { text: string; clipped: boolean } {
  const all = maskNumbers(pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join('\n'))
  return all.length <= MAX_TEXT ? { text: all, clipped: false } : { text: all.slice(0, MAX_TEXT), clipped: true }
}

// Digits after the decimal point in a currency, from the platform's own table: 2 for PHP and EUR, 0 for JPY.
export function decimalsOf(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

const LIMIT = 1e12
// A figure as DeepSeek gives it, a number or the text as printed (1,234.56, 1.234,56, 1,234.56 CR, (12.00), -12), in minor units; null when it is not one.
export function minorOf(value: unknown, currency: string): number | null {
  const d = decimalsOf(currency)
  let n: number | null = null
  if (typeof value === 'number') n = Number.isFinite(value) ? value : null
  else if (typeof value === 'string') {
    let s = value.trim()
    let negative = false
    if (/^\(.*\)$/.test(s)) {
      negative = true
      s = s.slice(1, -1)
    }
    if (/\bCR\.?$/i.test(s) || /-$/.test(s)) {
      negative = true
      s = s.replace(/\s*(?:CR\.?|-)$/i, '')
    }
    s = s.replace(/[^\d.,\-−]/g, '').replace('−', '-')
    if (s.startsWith('-')) {
      negative = !negative
      s = s.slice(1)
    }
    // The last of a comma or a point that has one or two digits after it is the decimal mark; every other is grouping.
    const mark = /[.,]\d{1,2}$/.exec(s)
    const whole = mark ? s.slice(0, mark.index) : s
    const fraction = mark ? s.slice(mark.index + 1) : ''
    const digits = whole.replace(/[.,]/g, '')
    if (/^\d+$/.test(digits) || (digits === '' && fraction !== '')) n = Number(`${digits || '0'}.${fraction || '0'}`) * (negative ? -1 : 1)
  }
  if (n === null || Math.abs(n) >= LIMIT) return null
  return Math.round(n * 10 ** d)
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

const STATEMENT_EXAMPLE = {
  issuer: 'Bank and card name',
  last4: '1234',
  currency: 'PHP',
  cut_date: 'YYYY-MM-DD',
  due_date: 'YYYY-MM-DD',
  previous_balance: 0,
  payments_and_credits: 0,
  charges: 0,
  installments: 0,
  interest: 0,
  fees: 0,
  total_due: 0,
  minimum_due: 0,
  available_credit: 0,
}

export const STATEMENT_PROMPT = [
  'You read one credit card statement. The user message is its text, taken from the PDF row by row.',
  'Three spaces separate columns, and a label may sit in the row above its figure. Card and account numbers are masked.',
  'Give the figures of the account summary for the statement period.',
  'currency is the ISO code of the amounts (PHP for ₱ or P).',
  'cut_date is the statement date, also called closing or cut-off date. due_date is the payment due date. Write dates as YYYY-MM-DD.',
  'Amounts are plain numbers in that currency, without grouping.',
  'previous_balance is the previous or beginning balance, below zero when printed as a credit.',
  'payments_and_credits is everything the statement takes off the balance: payments, credits, refunds and reversals, added together, as a positive number.',
  'charges is purchases, debits and cash advances.',
  'installments is installment amortizations billed this period: INSTL lines, installment plans, balance conversions and balance transfers.',
  'interest is finance charges and interest. fees is late, annual and other fees and charges.',
  'If the summary puts installments, interest or fees inside one purchases figure, take them out of charges using the itemized lines.',
  'Some statements print the summary figures with no labels: a column of amounts, each followed by the currency code.',
  'One such column runs: previous balance; payments and credits, with a minus; an unnamed figure; purchases with installments included; an unnamed figure;',
  'installments; fees; finance charge; an unnamed figure; total amount due, beside the due date; minimum amount due.',
  'For that layout, charges is the purchases figure less installments; the amounts to its left are the card’s last four digits, credit limit and cash limit.',
  'total_due is the total amount due, also called total statement balance or new balance.',
  'minimum_due is the minimum amount due. available_credit is the available credit limit.',
  'Use null for a figure the statement does not print.',
  'previous_balance − payments_and_credits + charges + installments + interest + fees should equal total_due.',
  'If it does not, read the summary again, but never change total_due to make it balance.',
  'issuer is the bank and card name as printed, and last4 the last four digits of the card number, or null.',
  'If the text is not a credit card statement, reply {"not_statement": true}.',
  `Reply with json only, shaped like: ${JSON.stringify(STATEMENT_EXAMPLE)}`,
].join(' ')

export function statementPrompt(textOfPdf: string, currency: string): string {
  return `The card's currency is ${currency}.\n\n${textOfPdf}`
}

// DeepSeek's statement with every figure read, every date a real day and the identity worked out again; a part printed below zero is a credit, so it moves to payments and credits, which keeps the identity.
export function readStatement(raw: unknown, currency: string, truncated: boolean): StatementRead | Fail {
  const a = (raw ?? {}) as Record<string, unknown>
  if (a.not_statement === true) return fail(422, 'not_statement')
  const cur = isCurrency(a.currency) ? a.currency : currency
  const m = (v: unknown) => minorOf(v, cur)
  const total = m(a.total_due)
  if (total === null) return fail(422, 'not_statement')
  let payments = m(a.payments_and_credits)
  if (payments !== null) payments = Math.abs(payments)
  const part = (v: unknown) => {
    const x = m(v)
    if (x === null || x >= 0) return x
    payments = (payments ?? 0) - x
    return 0
  }
  const charges = part(a.charges)
  const installments = part(a.installments)
  const interest = part(a.interest)
  const fees = part(a.fees)
  const previous = m(a.previous_balance)
  const minimum = m(a.minimum_due)
  const parts = [previous, payments, charges, installments, interest, fees]
  const off = parts.every((x) => x !== null) ? (previous as number) - (payments as number) + (charges as number) + (installments as number) + (interest as number) + (fees as number) - total : null
  const last4 = typeof a.last4 === 'string' && /^\d{4}$/.test(a.last4.trim()) ? a.last4.trim() : null
  return {
    kind: 'statement',
    currency: cur,
    issuer: text(a.issuer, ISSUER_MAX),
    last4,
    cut_date: isDay(a.cut_date) ? a.cut_date : null,
    due_date: isDay(a.due_date) ? a.due_date : null,
    previous_balance_minor: previous,
    payments_and_credits_minor: payments,
    charges_minor: charges,
    installments_minor: installments,
    interest_minor: interest,
    fees_minor: fees,
    total_due_minor: total,
    minimum_due_minor: minimum === null ? null : Math.abs(minimum),
    available_credit_minor: m(a.available_credit),
    off_by_minor: off,
    truncated,
  }
}

const RECEIPT_EXAMPLE = { merchant: 'Shop name', date: 'YYYY-MM-DD', currency: 'EUR', total: 0, category_id: null, summary: 'What was bought' }

export const RECEIPT_PROMPT = [
  'You read one receipt or invoice. The user message is its text, taken from the PDF row by row.',
  'Three spaces separate columns. Card and account numbers are masked.',
  'merchant is the shop or company that was paid, as a person would name it.',
  'date is the day of the purchase, YYYY-MM-DD. A receipt from Spain or the Philippines writes the day before the month.',
  'currency is the ISO code of the amounts. total is the amount paid in all, tax included, as a plain positive number without grouping.',
  'category_id is the id of the one category from the list that fits best, or null when none fits.',
  'summary says what was bought, in under 80 characters.',
  'If the text is not a receipt or an invoice, reply {"not_receipt": true}.',
  `Reply with json only, shaped like: ${JSON.stringify(RECEIPT_EXAMPLE)}`,
].join(' ')

export function receiptPrompt(textOfPdf: string, req: Pick<PdfRequest, 'currency' | 'categories'>): string {
  return `${JSON.stringify({ account_currency: req.currency, categories: req.categories })}\n\n${textOfPdf}`
}

// DeepSeek's receipt with its total read, its day a real one and its category one the household has.
export function readReceipt(raw: unknown, req: Pick<PdfRequest, 'currency' | 'categories'>, truncated: boolean): ReceiptRead | Fail {
  const a = (raw ?? {}) as Record<string, unknown>
  if (a.not_receipt === true) return fail(422, 'not_receipt')
  const cur = isCurrency(a.currency) ? a.currency : req.currency
  const total = minorOf(a.total, cur)
  if (total === null || total === 0) return fail(422, 'no_total')
  const category = typeof a.category_id === 'string' && req.categories.some((c) => c.id === a.category_id) ? a.category_id : null
  return {
    kind: 'receipt',
    currency: cur,
    merchant: text(a.merchant, MERCHANT_MAX),
    date: isDay(a.date) ? a.date : null,
    total_minor: Math.abs(total),
    category_id: category,
    summary: text(a.summary, SUMMARY_MAX),
    truncated,
  }
}

// One PDF read: its text, masked, one DeepSeek call, then the checked answer. Neither the file, its password nor its text is kept or logged.
export async function readPdf(req: PdfRequest, env: AiEnv, fetchFn: typeof fetch, extract: ExtractText): Promise<StatementRead | ReceiptRead | Fail> {
  const bytes = decodeBase64(req.pdf)
  if (!looksLikePdf(bytes)) return fail(415, 'not_pdf')
  const read = await extract(bytes, req.password).catch((): PdfText => ({ ok: false, error: 'not_pdf' }))
  if (!read.ok) return read.error === 'not_pdf' ? fail(415, 'not_pdf') : fail(422, read.error)
  if (read.pages.join('').replace(/[^\p{L}\p{N}]/gu, '').length < MIN_TEXT) return fail(422, 'no_text')
  const { text: forDeepSeek, clipped } = promptText(read.pages)
  const truncated = clipped || read.more
  if (req.task === 'statement') {
    const out = await askDeepSeek(env, fetchFn, STATEMENT_PROMPT, statementPrompt(forDeepSeek, req.currency), 1200, 0)
    return 'error' in out ? out : readStatement(out.json, req.currency, truncated)
  }
  const out = await askDeepSeek(env, fetchFn, RECEIPT_PROMPT, receiptPrompt(forDeepSeek, req), 600, 0)
  return 'error' in out ? out : readReceipt(out.json, req, truncated)
}

// The whole request: the signed-in user and the allow list, then the read.
export async function handlePdfRead(body: unknown, token: string | null, env: AiEnv, fetchFn: typeof fetch, extract: ExtractText): Promise<PdfReply | Fail> {
  const req = readPdfRequest(body)
  if ('error' in req) return req
  const who = await caller(env, token, fetchFn)
  if ('error' in who) return who
  if (req.task === 'status') return { enabled: who.enabled }
  if (!who.enabled) return fail(403, 'not_enabled')
  return readPdf(req, env, fetchFn, extract)
}
