import { handle } from '../src/ai/meals-swap'
import { bearer, KB, refuseEarly } from '../src/server/guard'

// The largest request, a week's plan with its recipe costs, is a few KB.
const MAX_BODY = 64 * KB

// POST /api/meals-ai: the meals helper (src/ai/meals-swap). The DeepSeek key stays on the server; the caller's own sign-in token reads their meals.
export async function POST(request: Request): Promise<Response> {
  const early = refuseEarly(request, MAX_BODY)
  if (early) return early
  const token = bearer(request)
  const body: unknown = await request.json().catch(() => null)
  const env = {
    supabase_url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabase_key: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    deepseek_key: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL,
    users: process.env.MEALS_AI_USERS,
  }
  const out = await handle(body, token, env, fetch)
  const status = 'status' in out && typeof out.status === 'number' ? out.status : 200
  return Response.json(out, { status, headers: { 'Cache-Control': 'no-store' } })
}
