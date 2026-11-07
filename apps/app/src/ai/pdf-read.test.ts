import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEEPSEEK_URL, type AiEnv } from './deepseek'
import { handlePdfRead, maskNumbers, minorOf, pageRows, readPdfRequest, readReceipt, readStatement, type ExtractText } from './pdf-read'
import { pdfText } from './pdf-text'

// Made-up documents (fixtures/*.pdf, written by scripts/make-pdf-fixtures.py): a card statement whose parts add up to its total, the same file locked with the password 1234, a Spanish receipt, and a page with no text.
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name)).toString('base64')
const ENV: AiEnv = { supabase_url: 'https://db.test', supabase_key: 'pk', deepseek_key: 'dk', model: undefined, users: 'user-a' }
const CATEGORIES = [
  { id: 'groceries', name: 'Groceries' },
  { id: 'dining', name: 'Dining out' },
]

// Answers Supabase's user read and DeepSeek's call, recording what each was sent.
function fakeFetch(user: string, answer: unknown) {
  const sent: { url: string; body: Record<string, unknown> | null }[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null })
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: user })
    if (url === DEEPSEEK_URL) return Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] })
    return new Response('?', { status: 404 })
  }) as unknown as typeof fetch
  const deepseek = () => sent.find((s) => s.url === DEEPSEEK_URL)?.body as { temperature: number; response_format: unknown; messages: { content: string }[] } | undefined
  return { fn, deepseek }
}

const STATEMENT_ANSWER = {
  issuer: 'Sample Bank Platinum Mastercard',
  last4: '7890',
  currency: 'PHP',
  cut_date: '2026-10-05',
  due_date: '2026-10-29',
  previous_balance: 20000,
  payments_and_credits: 16200,
  charges: 8450.5,
  installments: 3000,
  interest: 412.25,
  fees: 0,
  total_due: 15662.75,
  minimum_due: 850,
  available_credit: 84337.25,
}

describe('reading a PDF', () => {
  it('reads a status, a statement or a receipt request, and refuses a file that is not base64 or too large', () => {
    const pdf = fixture('statement.pdf')
    expect(readPdfRequest({ task: 'status' })).toEqual({ task: 'status' })
    expect(readPdfRequest({ task: 'statement', pdf, currency: 'PHP', password: '' })).toEqual({ task: 'statement', pdf, password: null, currency: 'PHP', categories: [] })
    expect(readPdfRequest({ task: 'statement', pdf: 'not base64!', currency: 'PHP' })).toEqual({ status: 400, error: 'bad_request' })
    expect(readPdfRequest({ task: 'statement', pdf, currency: 'peso' })).toEqual({ status: 400, error: 'bad_request' })
    expect(readPdfRequest({ task: 'receipt', pdf: 'A'.repeat(4_100_000), currency: 'EUR' })).toEqual({ status: 413, error: 'too_large' })
    // A receipt keeps the categories that have an id and a name, and a statement keeps none.
    const receipt = readPdfRequest({ task: 'receipt', pdf, currency: 'EUR', categories: [...CATEGORIES, { id: '', name: 'x' }, { id: 'y' }] })
    expect('categories' in receipt && receipt.categories).toEqual(CATEGORIES)
  })

  it('masks card and account numbers to their last four digits and drops email addresses, leaving amounts and dates', () => {
    const text = 'SAMPLE BANK 5412 7512 3456 7890   MAR* - 1000 0000 3804 2519\nAccount 1234567890123   +63 2 8888 1234   cards@bank.example\nTotal Amount Due   15,662.75   OCT 05 2026   990,000.00   07/27 11/27'
    expect(maskNumbers(text)).toBe('SAMPLE BANK ••••7890   MAR* - ••••2519\nAccount ••••0123   +••••1234   [email]\nTotal Amount Due   15,662.75   OCT 05 2026   990,000.00   07/27 11/27')
  })

  it('reads a printed amount in minor units whichever mark is the decimal one, a credit below zero', () => {
    const read = (v: unknown, c = 'PHP') => minorOf(v, c)
    expect([read(15662.75), read('15,662.75'), read('1.234,56'), read('10,55'), read('1,234'), read('(12.00)'), read('1,234.56 CR'), read('-7'), read('₱ 990,000.00'), read('1500', 'JPY')]).toEqual([1566275, 1566275, 123456, 1055, 123400, -1200, -123456, -700, 99000000, 1500])
    expect([read('n/a'), read(null), read(Number.NaN), read('')]).toEqual([null, null, null, null])
  })

  it('rebuilds each row from left to right, so a label stays beside its figure', () => {
    const item = (s: string, x: number, y: number, width = s.length * 5) => ({ str: s, transform: [1, 0, 0, 1, x, y], width })
    expect(pageRows([item('15,662.75', 500, 574), item('Total Amount Due', 330, 574.8), item('Statement', 330, 700), item('Date', 378, 700), item(' ', 10, 10)])).toBe('Statement Date\nTotal Amount Due   15,662.75')
  })

  it('keeps a statement whose figures read, works the identity out again, and moves a part printed below zero to credits', () => {
    const read = readStatement(STATEMENT_ANSWER, 'PHP', false)
    expect(read).toMatchObject({ kind: 'statement', currency: 'PHP', last4: '7890', cut_date: '2026-10-05', total_due_minor: 1566275, payments_and_credits_minor: 1620000, off_by_minor: 0 })
    // A fee reversal printed as −50 is a credit of 50: the identity still holds.
    expect(readStatement({ ...STATEMENT_ANSWER, fees: -50, payments_and_credits: 16150 }, 'PHP', false)).toMatchObject({ fees_minor: 0, payments_and_credits_minor: 1620000, off_by_minor: 0 })
    expect(readStatement({ ...STATEMENT_ANSWER, interest: null, cut_date: '2026-02-30', last4: '78' }, 'PHP', true)).toMatchObject({ interest_minor: null, off_by_minor: null, cut_date: null, last4: null, truncated: true })
    expect(readStatement({ ...STATEMENT_ANSWER, total_due: 15000 }, 'PHP', false)).toMatchObject({ off_by_minor: 66275 })
    expect([readStatement({ not_statement: true }, 'PHP', false), readStatement({ ...STATEMENT_ANSWER, total_due: null }, 'PHP', false)]).toEqual([
      { status: 422, error: 'not_statement' },
      { status: 422, error: 'not_statement' },
    ])
  })

  it('keeps a receipt with a total, and a category only when it is one of the household’s', () => {
    const req = { currency: 'EUR', categories: CATEGORIES }
    expect(readReceipt({ merchant: '  Supermercado   Ejemplo ', date: '2026-10-14', currency: 'EUR', total: '10,55', category_id: 'groceries', summary: 'Milk, rice and chicken' }, req, false)).toEqual({
      kind: 'receipt',
      currency: 'EUR',
      merchant: 'Supermercado Ejemplo',
      date: '2026-10-14',
      total_minor: 1055,
      category_id: 'groceries',
      summary: 'Milk, rice and chicken',
      truncated: false,
    })
    expect(readReceipt({ merchant: 'X', total: 3, category_id: 'cars' }, req, false)).toMatchObject({ currency: 'EUR', date: null, category_id: null, total_minor: 300 })
    expect([readReceipt({ not_receipt: true }, req, false), readReceipt({ merchant: 'X', total: 0 }, req, false)]).toEqual([
      { status: 422, error: 'not_receipt' },
      { status: 422, error: 'no_total' },
    ])
  })

  it('takes each page’s text from the PDF, and names a missing or wrong password', async () => {
    const bytes = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))
    const open = await pdfText(bytes('statement.pdf'), null)
    expect(open.ok && open.pages[0]).toContain('Total Amount Due   15,662.75')
    expect(await pdfText(bytes('statement-locked.pdf'), null)).toEqual({ ok: false, error: 'needs_password' })
    expect(await pdfText(bytes('statement-locked.pdf'), 'nope')).toEqual({ ok: false, error: 'wrong_password' })
    const unlocked = await pdfText(bytes('statement-locked.pdf'), '1234')
    expect(unlocked.ok && unlocked.pages[0]).toContain('Previous Balance   20,000.00')
    expect(await pdfText(new TextEncoder().encode('%PDF-1.7 not really'), null)).toEqual({ ok: false, error: 'not_pdf' })
  })

  it('answers status for a signed-in account, and reads a statement only for a listed one, sending DeepSeek masked text', async () => {
    const pdf = fixture('statement.pdf')
    const off = fakeFetch('user-c', STATEMENT_ANSWER)
    expect(await handlePdfRead({ task: 'status' }, 'tok', ENV, off.fn, pdfText)).toEqual({ enabled: false })
    expect(await handlePdfRead({ task: 'statement', pdf, currency: 'PHP' }, 'tok', ENV, off.fn, pdfText)).toEqual({ status: 403, error: 'not_enabled' })
    expect(await handlePdfRead({ task: 'status' }, null, ENV, off.fn, pdfText)).toEqual({ status: 401, error: 'signed_out' })
    const on = fakeFetch('user-a', STATEMENT_ANSWER)
    expect(await handlePdfRead({ task: 'statement', pdf, currency: 'PHP' }, 'tok', ENV, on.fn, pdfText)).toMatchObject({ kind: 'statement', total_due_minor: 1566275, off_by_minor: 0 })
    const call = on.deepseek()!
    expect([call.temperature, call.response_format]).toEqual([0, { type: 'json_object' }])
    const user = call.messages[1]!.content
    expect([user.includes('5412 7512 3456 7890'), user.includes('••••7890'), user.includes('cards@samplebank.example'), user.includes('15,662.75')]).toEqual([false, true, false, true])
  })

  it('reads a receipt with the household’s categories, and names a locked, empty or foreign file before asking DeepSeek', async () => {
    const answer = { merchant: 'Supermercado Ejemplo', date: '2026-10-14', currency: 'EUR', total: 10.55, category_id: 'groceries', summary: 'Groceries' }
    const on = fakeFetch('user-a', answer)
    expect(await handlePdfRead({ task: 'receipt', pdf: fixture('receipt.pdf'), currency: 'EUR', categories: CATEGORIES }, 'tok', ENV, on.fn, pdfText)).toMatchObject({ kind: 'receipt', total_minor: 1055, category_id: 'groceries' })
    expect(on.deepseek()!.messages[1]!.content).toContain('"categories":[{"id":"groceries","name":"Groceries"}')
    const never: ExtractText = () => Promise.reject(new Error('read'))
    const quiet = fakeFetch('user-a', answer)
    expect(await handlePdfRead({ task: 'statement', pdf: fixture('statement-locked.pdf'), currency: 'PHP' }, 'tok', ENV, quiet.fn, pdfText)).toEqual({ status: 422, error: 'needs_password' })
    expect(await handlePdfRead({ task: 'statement', pdf: fixture('statement-locked.pdf'), currency: 'PHP', password: '0000' }, 'tok', ENV, quiet.fn, pdfText)).toEqual({ status: 422, error: 'wrong_password' })
    expect(await handlePdfRead({ task: 'receipt', pdf: fixture('blank.pdf'), currency: 'EUR' }, 'tok', ENV, quiet.fn, pdfText)).toEqual({ status: 422, error: 'no_text' })
    expect(await handlePdfRead({ task: 'receipt', pdf: btoa('hello, not a pdf'), currency: 'EUR' }, 'tok', ENV, quiet.fn, pdfText)).toEqual({ status: 415, error: 'not_pdf' })
    expect(await handlePdfRead({ task: 'receipt', pdf: fixture('receipt.pdf'), currency: 'EUR' }, 'tok', ENV, quiet.fn, never)).toEqual({ status: 415, error: 'not_pdf' })
    expect(quiet.deepseek()).toBeUndefined()
  })
})
