import { useQuery } from '@tanstack/react-query'
import type { PdfReply, ReceiptRead, StatementRead } from '@/ai/pdf-read'
import { DataError, SESSION_ENDED } from './errors'
import type { PickedPdf } from './pdf-file'
import { useDataSource } from './source'
import { getSupabase } from './supabase'

// Fill from PDF's function on the web app's own origin; a phone build reaches it through the web address.
const PDF_URL = `${process.env.EXPO_PUBLIC_WEB_URL ?? ''}/api/pdf-read`

export const PDF_ERRORS: Readonly<Record<string, string>> = {
  not_enabled: 'Reading a PDF with DeepSeek is on for some accounts only.',
  signed_out: SESSION_ENDED,
  needs_password: 'This PDF is locked. Type its password to read it.',
  wrong_password: 'That password does not open this PDF.',
  not_pdf: 'This file is not a PDF Waypoint can open.',
  no_text: 'This PDF is a scan with no text in it, so it cannot be read. Type the figures instead.',
  too_large: 'This PDF is over 3 MB. Save a copy with only the summary pages and choose that.',
  not_statement: 'This PDF does not read as a card statement.',
  not_receipt: 'This PDF does not read as a receipt or an invoice.',
  no_total: 'No total could be read from this receipt.',
  deepseek_timeout: 'DeepSeek took too long to answer. Try again.',
  deepseek_cut_off: 'DeepSeek’s answer was cut short. Try again.',
}

export const pdfErrorWords = (code: string) => PDF_ERRORS[code] ?? 'DeepSeek could not read this PDF just now. Try again in a moment.'

// The password errors, which the sheets answer with a password field rather than a banner.
export const PASSWORD_CODES = ['needs_password', 'wrong_password'] as const

async function callPdf(body: unknown): Promise<PdfReply> {
  const { data } = await getSupabase().auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new DataError('signed_out', SESSION_ENDED)
  let reply: Response
  try {
    reply = await fetch(PDF_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  } catch (error) {
    throw new DataError('network', 'Waypoint could not reach the server.', { technical: String(error) })
  }
  const json = (await reply.json().catch(() => null)) as (PdfReply & { error?: string }) | null
  if (!reply.ok || !json) throw new DataError('rejected', pdfErrorWords(json?.error ?? ''), { code: json?.error ?? null, technical: `pdf-read: HTTP ${reply.status} ${json?.error ?? ''}` })
  return json
}

// Whether this account may read PDFs with DeepSeek; false in samples, offline, and where the web app has no helper (local development).
export function usePdfReadEnabled(): boolean {
  const { source, owner } = useDataSource()
  const live = source.kind !== 'sample' && owner !== null
  const query = useQuery({ queryKey: ['pdf-read', owner ?? ''], queryFn: () => callPdf({ task: 'status' }).then((r) => 'enabled' in r && r.enabled === true), enabled: live, staleTime: Infinity, retry: false })
  return live && query.data === true
}

// A card statement's printed figures; nothing is saved until the person saves the sheet.
export function readStatementPdf(file: PickedPdf, password: string | null, currency: string): Promise<StatementRead> {
  return callPdf({ task: 'statement', pdf: file.base64, password, currency }).then((r) => {
    if (!('kind' in r) || r.kind !== 'statement') throw new DataError('rejected', pdfErrorWords(''))
    return r
  })
}

// A receipt's total, day, shop and suggested category; nothing is saved until the person saves the sheet.
export function readReceiptPdf(file: PickedPdf, password: string | null, currency: string, categories: readonly { id: string; name: string }[]): Promise<ReceiptRead> {
  return callPdf({ task: 'receipt', pdf: file.base64, password, currency, categories }).then((r) => {
    if (!('kind' in r) || r.kind !== 'receipt') throw new DataError('rejected', pdfErrorWords(''))
    return r
  })
}
