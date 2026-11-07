import { handle } from '../src/server/mercadona'

// POST /api/mercadona: Add an item's product search (src/server/mercadona), from the server so the browser never calls the shop.
export async function POST(request: Request): Promise<Response> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  const body: unknown = await request.json().catch(() => null)
  const env = {
    supabase_url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabase_key: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    algolia_app: process.env.MERCADONA_ALGOLIA_APP_ID,
    algolia_key: process.env.MERCADONA_ALGOLIA_KEY,
  }
  const out = await handle(body, token, env, fetch)
  if ('error' in out && out.error === 'mercadona_not_configured') console.error('/api/mercadona: set MERCADONA_ALGOLIA_APP_ID and MERCADONA_ALGOLIA_KEY to search the shop')
  const status = 'status' in out && typeof out.status === 'number' ? out.status : 200
  return Response.json(out, { status, headers: { 'Cache-Control': 'no-store' } })
}
