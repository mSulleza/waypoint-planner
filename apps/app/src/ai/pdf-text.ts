import { getDocumentProxy } from 'unpdf'
import { pageRows, type PdfText } from './pdf-read'

// The pages read; a statement's summary and a receipt's total are on the first ones.
const MAX_PAGES = 12

// The PDF's text page by page, opened with its password when it has one. Only /api/pdf-read imports this, so pdf.js stays out of the app's bundle and the meals function.
export async function pdfText(bytes: Uint8Array, password: string | null): Promise<PdfText> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(bytes, { password: password ?? undefined, verbosity: 0 })
  } catch (error) {
    const e = error as { name?: string; code?: number }
    // pdf.js: code 1 when no password was given, 2 when the one given is wrong.
    if (e.name === 'PasswordException') return { ok: false, error: e.code === 2 ? 'wrong_password' : 'needs_password' }
    return { ok: false, error: 'not_pdf' }
  }
  try {
    const pages: string[] = []
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES); n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      pages.push(pageRows(content.items.filter((i) => 'str' in i)))
    }
    return { ok: true, pages, more: pdf.numPages > MAX_PAGES }
  } finally {
    await pdf.loadingTask.destroy()
  }
}
