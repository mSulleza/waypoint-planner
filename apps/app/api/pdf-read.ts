import { handlePdfRead } from '../src/ai/pdf-read'
import { pdfText } from '../src/ai/pdf-text'

// POST /api/pdf-read: Fill from PDF (src/ai/pdf-read). The DeepSeek key stays on the server, and the PDF, its password and its text are read in memory and never kept.
export async function POST(request: Request): Promise<Response> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  const body: unknown = await request.json().catch(() => null)
  const env = {
    supabase_url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabase_key: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    deepseek_key: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL,
    // The meals helper's list unless this one has its own.
    users: process.env.PDF_AI_USERS ?? process.env.MEALS_AI_USERS,
  }
  const out = await handlePdfRead(body, token, env, fetch, pdfText)
  const status = 'status' in out && typeof out.status === 'number' ? out.status : 200
  return Response.json(out, { status, headers: { 'Cache-Control': 'no-store' } })
}
