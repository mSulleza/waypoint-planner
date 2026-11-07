// The server side of Add an item's Mercadona search: the signed-in user, one product search in the shop's own search index, and the results kept for a few hours. Plain TypeScript with no imports at run time, so the Vercel function bundles nothing else.

// Mercadona's zone for Granada, the one the price refresh's README names (apps/mcp): packaged goods cost the same in every zone checked.
export const WAREHOUSE = '3968'
// The shop's web app searches its Algolia index (its own search service turns away calls from servers). The application id and the public search-only key
// are the ones the shop's page sends; they come from MERCADONA_ALGOLIA_APP_ID and MERCADONA_ALGOLIA_KEY, and with either unset the search answers 503.
export const searchUrl = (app: string) => `https://${app.toLowerCase()}-dsn.algolia.net/1/indexes/products_prod_${WAREHOUSE}_es/query`
const TIMEOUT_MS = 8000
const HITS = 12
export const CACHE_MS = 6 * 60 * 60 * 1000
const CACHE_MAX = 200
const QUERY_MAX = 60

export interface ShopEnv {
  supabase_url: string | undefined
  supabase_key: string | undefined
  algolia_app: string | undefined
  algolia_key: string | undefined
}

type Algolia = { app: string; key: string }

// One product as the shop lists it; prices are in euros as Mercadona writes them, such as "1.20".
export interface Product {
  id: string
  name: string
  packaging: string | null
  price: string
  // The price per reference unit and that unit: kg, L, ud (each), dc or dz (a dozen).
  unit_price: string | null
  per: string | null
  // The pack's size in kg, l or ud, and for a pack of countable things how many it holds.
  size: number | null
  size_format: string | null
  units: number | null
  approx: boolean
  // The shop's top section, such as "Fruta y verdura".
  category: string | null
}

export type ShopReply = { products: Product[] }

export interface Fail {
  status: number
  error: string
}

const fail = (status: number, error: string): Fail => ({ status, error })

export function readQuery(body: unknown): string | null {
  const q = (body as { query?: unknown } | null)?.query
  if (typeof q !== 'string') return null
  const text = q.trim().replace(/\s+/g, ' ')
  return text.length >= 2 && text.length <= QUERY_MAX ? text : null
}

const ID = /^[0-9]{1,12}(\.[0-9]{1,4})?$/
const EUROS = /^\d+(\.\d{1,3})?$/
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

// The search's hits that are on sale with a price; anything else is left out.
export function readProducts(json: unknown): Product[] {
  const hits = (json as { hits?: unknown } | null)?.hits
  const out: Product[] = []
  for (const h of Array.isArray(hits) ? hits : []) {
    const p = h as Record<string, unknown>
    const pi = (p.price_instructions ?? {}) as Record<string, unknown>
    const id = str(p.id)
    const name = str(p.display_name)
    const price = str(pi.unit_price)
    if (!id || !ID.test(id) || !name || !price || !EUROS.test(price) || p.published === false) continue
    const bulk = str(pi.bulk_price)
    const top = Array.isArray(p.categories) ? (p.categories[0] as { name?: unknown } | undefined) : undefined
    out.push({
      id,
      name,
      packaging: str(p.packaging),
      price,
      unit_price: bulk && EUROS.test(bulk) ? bulk : null,
      per: str(pi.reference_format),
      size: num(pi.unit_size),
      size_format: str(pi.size_format)?.toLowerCase() ?? null,
      units: num(pi.total_units),
      approx: pi.approx_size === true,
      category: str(top?.name),
    })
  }
  return out
}

// Searches by the folded words, so "Plátano" and "platano" share one entry; the oldest entry goes first when it is full.
const cache = new Map<string, { at: number; products: Product[] }>()
export const cacheKey = (query: string) =>
  query
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

export function clearCache() {
  cache.clear()
}

async function search(query: string, algolia: Algolia, fetchFn: typeof fetch): Promise<Product[] | Fail> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const reply = await fetchFn(searchUrl(algolia.app), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Algolia-Application-Id': algolia.app, 'X-Algolia-API-Key': algolia.key },
      body: JSON.stringify({ query, hitsPerPage: HITS, analytics: false }),
    })
    if (!reply.ok) return fail(502, `mercadona_${reply.status}`)
    return readProducts(await reply.json())
  } catch {
    return fail(504, controller.signal.aborted ? 'mercadona_timeout' : 'mercadona_unreachable')
  } finally {
    clearTimeout(timer)
  }
}

// The whole request: the signed-in user from their own token, then the products, from the cache when the same words were searched in the last few hours.
export async function handle(body: unknown, token: string | null, env: ShopEnv, fetchFn: typeof fetch, now = Date.now()): Promise<ShopReply | Fail> {
  const query = readQuery(body)
  if (!query) return fail(400, 'bad_request')
  if (!env.supabase_url || !env.supabase_key) return fail(503, 'not_configured')
  const algolia = env.algolia_app?.trim() && env.algolia_key?.trim() ? { app: env.algolia_app.trim(), key: env.algolia_key.trim() } : null
  if (!algolia) return fail(503, 'mercadona_not_configured')
  if (!token) return fail(401, 'signed_out')
  const who = await fetchFn(new URL('auth/v1/user', `${env.supabase_url}/`).href, { headers: { apikey: env.supabase_key, Authorization: `Bearer ${token}` } })
  if (!who.ok) return fail(401, 'signed_out')
  const key = cacheKey(query)
  const kept = cache.get(key)
  if (kept && now - kept.at < CACHE_MS) return { products: kept.products }
  const products = await search(query, algolia, fetchFn)
  if ('error' in products) return products
  cache.delete(key)
  cache.set(key, { at: now, products })
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return { products }
}
