import { beforeEach, describe, expect, it } from 'vitest'
import { CACHE_MS, cacheKey, clearCache, handle, readProducts, readQuery, searchUrl, type ShopEnv } from './mercadona'

// Made-up search credentials; the real ones come from the environment.
const ENV: ShopEnv = { supabase_url: 'https://db.test', supabase_key: 'pk', algolia_app: 'TESTAPP', algolia_key: 'search-only-test-key' }
const SEARCH_URL = searchUrl('TESTAPP')

// Two hits as the shop's search returned them for "platano" in zone 3968 (30 Oct 2026), trimmed to the fields read.
const HITS = {
  hits: [
    {
      id: '3819',
      display_name: 'Plátano de Canarias IGP',
      packaging: 'Pieza',
      published: true,
      categories: [{ id: 1, name: 'Fruta y verdura', level: 0 }],
      price_instructions: { unit_price: '0.46', bulk_price: '3.00', reference_format: 'kg', unit_size: 0.154, size_format: 'kg', total_units: null, approx_size: true },
    },
    {
      id: '49750',
      display_name: 'Bolsas de basura 30L Bosque Verde perfumadas',
      packaging: 'Paquete',
      published: true,
      categories: [{ id: 26, name: 'Limpieza y hogar', level: 0 }],
      price_instructions: { unit_price: '1.80', bulk_price: '0.05', reference_format: 'ud', unit_size: 1, size_format: 'ud', total_units: 40, approx_size: false },
    },
    // Not sold online any more, and one with no price: both left out.
    { id: '1', display_name: 'Gone', published: false, price_instructions: { unit_price: '1.00' } },
    { id: '2', display_name: 'No price', price_instructions: {} },
  ],
}

// Answers Supabase's user check and the shop's search, counting the searches.
function fakeFetch(opts: { user?: boolean; shop?: number | 'throw' } = {}) {
  const calls = { search: 0, bodies: [] as unknown[], headers: [] as Record<string, string>[] }
  const fn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/v1/user')) return opts.user === false ? new Response('no', { status: 401 }) : Response.json({ id: 'user-a' })
    if (url === SEARCH_URL) {
      calls.search += 1
      calls.bodies.push(JSON.parse(String(init?.body)))
      calls.headers.push(init?.headers as Record<string, string>)
      if (opts.shop === 'throw') throw new TypeError('fetch failed')
      return opts.shop && opts.shop !== 200 ? new Response('no', { status: opts.shop }) : Response.json(HITS)
    }
    return new Response('?', { status: 404 })
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('Mercadona search', () => {
  beforeEach(() => clearCache())

  it('reads two to sixty characters of search words', () => {
    expect([readQuery({ query: '  platano  de  canarias ' }), readQuery({ query: 'a' }), readQuery({ query: 'x'.repeat(61) }), readQuery({ query: 3 }), readQuery(null)]).toEqual(['platano de canarias', null, null, null, null])
  })

  it('keeps products on sale with a price, with their pack, unit price and top section', () => {
    expect(readProducts(HITS)).toEqual([
      { id: '3819', name: 'Plátano de Canarias IGP', packaging: 'Pieza', price: '0.46', unit_price: '3.00', per: 'kg', size: 0.154, size_format: 'kg', units: null, approx: true, category: 'Fruta y verdura' },
      { id: '49750', name: 'Bolsas de basura 30L Bosque Verde perfumadas', packaging: 'Paquete', price: '1.80', unit_price: '0.05', per: 'ud', size: 1, size_format: 'ud', units: 40, approx: false, category: 'Limpieza y hogar' },
    ])
    expect([readProducts(null), readProducts({ hits: 'x' })]).toEqual([[], []])
  })

  it('needs a signed-in user before it searches', async () => {
    const { fn, calls } = fakeFetch({ user: false })
    expect(await handle({ query: 'platano' }, 'token', ENV, fn)).toEqual({ status: 401, error: 'signed_out' })
    expect(await handle({ query: 'platano' }, null, ENV, fn)).toEqual({ status: 401, error: 'signed_out' })
    expect(await handle({ query: 'p' }, 'token', ENV, fn)).toEqual({ status: 400, error: 'bad_request' })
    expect(await handle({ query: 'platano' }, 'token', { ...ENV, supabase_url: undefined }, fn)).toEqual({ status: 503, error: 'not_configured' })
    expect(calls.search).toBe(0)
  })

  it('names the missing search credentials and searches nothing without them', async () => {
    const { fn, calls } = fakeFetch()
    for (const env of [
      { ...ENV, algolia_key: undefined },
      { ...ENV, algolia_app: undefined },
      { ...ENV, algolia_key: '  ' },
    ])
      expect(await handle({ query: 'platano' }, 'token', env, fn)).toEqual({ status: 503, error: 'mercadona_not_configured' })
    expect(calls.search).toBe(0)
  })

  it('sends the application id and search key from the environment', async () => {
    const { fn, calls } = fakeFetch()
    await handle({ query: 'leche' }, 'token', ENV, fn)
    expect(calls.headers[0]).toMatchObject({ 'X-Algolia-Application-Id': 'TESTAPP', 'X-Algolia-API-Key': 'search-only-test-key' })
    expect(SEARCH_URL).toBe('https://testapp-dsn.algolia.net/1/indexes/products_prod_3968_es/query')
  })

  it('searches once for the same words with or without accents, until the cache runs out', async () => {
    const { fn, calls } = fakeFetch()
    const first = await handle({ query: 'Plátano' }, 'token', ENV, fn, 0)
    expect('products' in first && first.products.map((p) => p.id)).toEqual(['3819', '49750'])
    expect(calls.bodies[0]).toMatchObject({ query: 'Plátano' })
    await handle({ query: 'platano' }, 'token', ENV, fn, CACHE_MS - 1)
    expect(calls.search).toBe(1)
    await handle({ query: 'platano' }, 'token', ENV, fn, CACHE_MS)
    expect(calls.search).toBe(2)
    expect(cacheKey('Plátano  ')).toBe('platano  ')
  })

  it('names a refusal or an unreachable shop, and keeps no failure in the cache', async () => {
    const refused = fakeFetch({ shop: 403 })
    expect(await handle({ query: 'leche' }, 'token', ENV, refused.fn)).toEqual({ status: 502, error: 'mercadona_403' })
    expect(await handle({ query: 'leche' }, 'token', ENV, fakeFetch({ shop: 'throw' }).fn)).toEqual({ status: 504, error: 'mercadona_unreachable' })
    const ok = fakeFetch()
    expect(await handle({ query: 'leche' }, 'token', ENV, ok.fn)).toHaveProperty('products')
    expect(ok.calls.search).toBe(1)
  })
})
