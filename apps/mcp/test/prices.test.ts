import type { Item } from '@waypoint/core/meals'
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/auth'
import { dueItems, parsePricesArgs, priceFor, readProduct, refreshPrices, type PricesDeps } from '../src/prices'

const item = (patch: Partial<Item> = {}): Item => ({
  id: 'soy',
  name: 'Soy sauce',
  kind: 'stock',
  unit: 'ml',
  pack_size: 250,
  loose: false,
  price_minor: 110,
  price_checked_on: '2026-10-10',
  price_source: 'mercadona',
  mercadona_id: '17360',
  aisle: null,
  category_id: null,
  lasts_days: 21,
  wanted_on: null,
  unavailable_on: null,
  at_home_on: null,
  archived_at: null,
  ...patch,
})

const product = (unit_price: string, extra: Record<string, unknown> = {}) => ({ display_name: 'Salsa de Soja Hacendado', published: true, price_instructions: { unit_price, bulk_price: '4.80', reference_format: 'L', ...extra } })

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// A database that answers export_meals with these items and records each price it is asked to save.
function fakeDb(items: Item[]) {
  const saved: { id: string; row: Record<string, unknown> }[] = []
  const db = {
    rpc: async () => ({ data: { settings: { category_id: null, currency: 'EUR', shop_weekday: 5, people: 2 }, items, purchases: [], recipes: [], recipe_items: [], meals: [], trips: [] }, error: null }),
    from: () => ({
      update: (row: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => ({
          select: async () => {
            saved.push({ id, row })
            return { data: [{ id }], error: null }
          },
        }),
      }),
    }),
  }
  return { db: db as unknown as Db, saved }
}

function deps(db: Db, replies: Record<string, () => Response>, lines: string[], urls: string[] = []): PricesDeps {
  return {
    db,
    fetch: (async (url: string) => {
      urls.push(url)
      const id = /products\/([^/]+)\//.exec(url)?.[1] ?? ''
      return (replies[id] ?? (() => json(404, {})))()
    }) as typeof fetch,
    sleep: async () => undefined,
    now: () => new Date('2026-10-23T10:00:00Z'),
    say: (line) => void lines.push(line),
  }
}

describe('Mercadona prices', () => {
  it('needs a zone, by warehouse or postcode, and refuses an option it does not know', () => {
    expect(parsePricesArgs(['--warehouse', '3968'])).toEqual({ warehouse: '3968', postcode: null, days: 7, dry_run: false })
    expect(parsePricesArgs(['--postcode', '18001', '--days', '0', '--dry-run'])).toEqual({ warehouse: null, postcode: '18001', days: 0, dry_run: true })
    expect(() => parsePricesArgs([])).toThrow(/--warehouse or --postcode/)
    expect(() => parsePricesArgs(['--warehouse', '3968', '--all'])).toThrow(/Unknown or incomplete option: --all/)
  })

  it('reads only linked, kept items with no price or one checked a week ago or more', () => {
    const items = [item(), item({ id: 'fresh', price_checked_on: '2026-10-20' }), item({ id: 'unpriced', price_minor: null, price_checked_on: null, price_source: null }), item({ id: 'unlinked', mercadona_id: null }), item({ id: 'gone', archived_at: '2026-10-01T00:00:00Z' })]
    expect(dueItems(items, '2026-10-23', 7).map((i) => i.id)).toEqual(['soy', 'unpriced'])
  })

  it('takes the pack price, or for an item sold loose the price per kg or litre for its pack size, and nothing for a product no longer sold', () => {
    const p = readProduct(product('1.20'))!
    expect(priceFor(item(), p)).toBe(120)
    expect(priceFor(item({ loose: true, unit: 'g', pack_size: 500 }), readProduct(product('0.35', { bulk_price: '1.70', reference_format: 'kg' }))!)).toBe(85)
    expect(priceFor(item({ loose: true, unit: 'unit' }), p)).toBeNull()
    expect(priceFor(item(), { ...p, published: false })).toBeNull()
    expect(readProduct({ display_name: 'x' })).toBeNull()
  })

  it('saves each price read with today’s date and Mercadona as its source, one product at a time', async () => {
    const { db, saved } = fakeDb([item(), item({ id: 'rice', name: 'Rice', mercadona_id: '5063', price_minor: null, price_checked_on: null, price_source: null })])
    const lines: string[] = []
    const urls: string[] = []
    const result = await refreshPrices(deps(db, { '17360': () => json(200, product('1.20')), '5063': () => json(200, product('1.20')) }, lines, urls), { warehouse: '3968', postcode: null, days: 7, dry_run: false })
    expect(result).toEqual({ warehouse: '3968', checked: 2, changed: 2, failed: 0 })
    expect(urls).toEqual(['https://tienda.mercadona.es/api/products/17360/?lang=es&wh=3968', 'https://tienda.mercadona.es/api/products/5063/?lang=es&wh=3968'])
    expect(saved.map((s) => [s.id, s.row])).toEqual([
      ['soy', { price_minor: 120, price_checked_on: expect.stringMatching(/^2026-10-2[34]$/), price_source: 'mercadona' }],
      ['rice', { price_minor: 120, price_checked_on: expect.stringMatching(/^2026-10-2[34]$/), price_source: 'mercadona' }],
    ])
  })

  it('stops at the first refusal and never retries it, and a dry run saves nothing', async () => {
    const { db, saved } = fakeDb([item(), item({ id: 'b', mercadona_id: '2' }), item({ id: 'c', mercadona_id: '3' })])
    const lines: string[] = []
    const urls: string[] = []
    const blocked = await refreshPrices(deps(db, { '17360': () => json(200, product('1.20')), '2': () => json(429, {}) }, lines, urls), { warehouse: '3968', postcode: null, days: 7, dry_run: true })
    expect(blocked).toMatchObject({ checked: 1, failed: 2 })
    expect(urls).toHaveLength(2)
    expect(saved).toEqual([])
    expect(lines).toContain('Mercadona refused the read (HTTP 429); stopping here. Try again another day.')
  })
})
