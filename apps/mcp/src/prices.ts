import { addDays, checkInput, todayIn } from '@waypoint/core'
import { mealsDoc, type Item } from '@waypoint/core/meals'
import type { Db } from './auth'
import { AgentError } from './errors'

// The Mercadona refresh: reads the current price of the household's own items linked to a Mercadona product, a few a week from this computer, and saves each with today's date. It never runs from the hosted app.

export const MERCADONA = 'https://tienda.mercadona.es'
// One product every 2 seconds, so a refresh of ~60 items takes two minutes and never loads the shop.
export const PAUSE_MS = 2000
export const DEFAULT_DAYS = 7
export const USER_AGENT = 'Waypoint price check (one household, weekly, personal use)'

export interface PricesOptions {
  // Mercadona's warehouse code, such as 3968, or a postcode it serves, which names one.
  warehouse: string | null
  postcode: string | null
  // Prices checked this many days ago or more are read again.
  days: number
  dry_run: boolean
}

export function parsePricesArgs(args: readonly string[]): PricesOptions {
  const options: PricesOptions = { warehouse: null, postcode: null, days: DEFAULT_DAYS, dry_run: false }
  for (let i = 0; i < args.length; i++) {
    const [flag, value] = [args[i], args[i + 1]]
    if (flag === '--dry-run') {
      options.dry_run = true
      continue
    }
    if (flag === '--warehouse' && value) options.warehouse = value
    else if (flag === '--postcode' && value) options.postcode = value
    else if (flag === '--days' && value && /^\d+$/.test(value)) options.days = Number(value)
    else throw new AgentError(`Unknown or incomplete option: ${flag ?? ''}. ${PRICES_USAGE}`)
    i += 1
  }
  if (!options.warehouse && !options.postcode) throw new AgentError(`Name the shop's zone with --warehouse or --postcode. ${PRICES_USAGE}`)
  if (options.warehouse && !/^[a-z0-9]{1,8}$/i.test(options.warehouse)) throw new AgentError(`--warehouse is a code such as 3968 or vlc1, not ${options.warehouse}.`)
  if (options.postcode && !/^\d{5}$/.test(options.postcode)) throw new AgentError(`--postcode is five digits, not ${options.postcode}.`)
  return options
}

export const PRICES_USAGE = 'Usage: tsx src/cli.ts prices (--warehouse <code> | --postcode <5 digits>) [--days 7] [--dry-run]'

// Linked, kept, and with no price or one checked `days` ago or more.
export function dueItems(items: readonly Item[], today: string, days: number): Item[] {
  const since = addDays(today, -days)
  return items.filter((i) => i.archived_at === null && i.mercadona_id !== null && (i.price_checked_on === null || i.price_checked_on <= since))
}

export interface ProductPrice {
  // The pack price and the price per reference unit, in euros as Mercadona writes them.
  unit_price: string
  bulk_price: string | null
  reference_format: string | null
  name: string
  published: boolean
}

const cents = (euros: string | null) => (euros !== null && /^\d+(\.\d{1,3})?$/.test(euros) ? Math.round(Number(euros) * 100) : null)

// The item's price for its own pack: the shop's pack price, or for an item sold loose the price per kg or litre scaled to the item's pack size.
export function priceFor(item: Item, product: ProductPrice): number | null {
  if (!product.published) return null
  if (item.loose) {
    const per = cents(product.bulk_price)
    const unit = product.reference_format?.toLowerCase()
    if (per === null || !((item.unit === 'g' && unit === 'kg') || (item.unit === 'ml' && unit === 'l'))) return null
    return Math.round((per * item.pack_size) / 1000)
  }
  return cents(product.unit_price)
}

export function readProduct(json: unknown): ProductPrice | null {
  const p = json as { display_name?: unknown; published?: unknown; price_instructions?: { unit_price?: unknown; bulk_price?: unknown; reference_format?: unknown } } | null
  const pi = p?.price_instructions
  if (!p || !pi || typeof pi.unit_price !== 'string') return null
  return {
    unit_price: pi.unit_price,
    bulk_price: typeof pi.bulk_price === 'string' ? pi.bulk_price : null,
    reference_format: typeof pi.reference_format === 'string' ? pi.reference_format : null,
    name: typeof p.display_name === 'string' ? p.display_name : '',
    published: p.published !== false,
  }
}

export interface PricesDeps {
  db: Db
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => Date
  say: (line: string) => void
}

// The warehouse a postcode is served from; Mercadona answers a postcode it does not deliver to with 404.
async function warehouseFor(deps: PricesDeps, postcode: string): Promise<string> {
  const reply = await deps.fetch(`${MERCADONA}/api/postal-codes/actions/change-pc/`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify({ new_postal_code: postcode }) })
  const wh = reply.headers.get('x-customer-wh')
  if (reply.status === 404) throw new AgentError(`Mercadona's online shop does not serve ${postcode}. Pass --warehouse with a nearby zone instead, such as 3968 for Granada.`)
  if (!reply.ok || !wh) throw new AgentError(`Mercadona did not name a zone for ${postcode} (HTTP ${reply.status}).`)
  return wh
}

export interface PricesResult {
  warehouse: string
  checked: number
  changed: number
  failed: number
}

// Reads each due item's product once, saves its price with today's date, and stops at the first refusal, so a blocked or rate-limited read is never retried.
export async function refreshPrices(deps: PricesDeps, options: PricesOptions): Promise<PricesResult> {
  const exported = await deps.db.rpc('export_meals')
  if (exported.error) throw new AgentError(`export_meals failed: ${exported.error.message}`)
  if (exported.data === null) throw new AgentError('This account has no household yet.')
  const checked = checkInput(mealsDoc, exported.data)
  if (!checked.ok) throw new AgentError(`The meals data did not pass the checks: ${checked.errors[0] ?? ''}`)
  const doc = checked.value
  if (doc.settings && doc.settings.currency !== 'EUR') throw new AgentError(`Meals are priced in ${doc.settings.currency}; Mercadona's prices are in EUR.`)
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, deps.now())
  const due = dueItems(doc.items, today, options.days)
  const warehouse = options.warehouse ?? (await warehouseFor(deps, options.postcode!))
  deps.say(`${due.length} of ${doc.items.length} items to check in Mercadona zone ${warehouse}${options.dry_run ? ' (dry run: nothing is saved)' : ''}.`)
  const result: PricesResult = { warehouse, checked: 0, changed: 0, failed: 0 }
  for (const [n, item] of due.entries()) {
    if (n > 0) await deps.sleep(PAUSE_MS)
    const reply = await deps.fetch(`${MERCADONA}/api/products/${item.mercadona_id}/?lang=es&wh=${encodeURIComponent(warehouse)}`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } })
    if (reply.status === 403 || reply.status === 429) {
      deps.say(`Mercadona refused the read (HTTP ${reply.status}); stopping here. Try again another day.`)
      result.failed += due.length - n
      break
    }
    const product = reply.ok ? readProduct(await reply.json().catch(() => null)) : null
    const price = product ? priceFor(item, product) : null
    if (price === null || price <= 0) {
      result.failed += 1
      deps.say(`  ${item.name}: no price read (product ${item.mercadona_id}, HTTP ${reply.status}${product && !product.published ? ', no longer sold online' : ''})`)
      continue
    }
    result.checked += 1
    const was = item.price_minor
    if (was !== price) result.changed += 1
    deps.say(`  ${item.name}: ${was === null ? 'none' : (was / 100).toFixed(2)} → ${(price / 100).toFixed(2)}${product ? ` (${product.name})` : ''}`)
    if (options.dry_run) continue
    const saved = await deps.db.from('items').update({ price_minor: price, price_checked_on: today, price_source: 'mercadona' }).eq('id', item.id).select('id')
    if (saved.error || (saved.data ?? []).length !== 1) throw new AgentError(`Saving ${item.name} failed: ${saved.error?.message ?? 'no row matched'}`)
  }
  deps.say(`Done: ${result.checked} read, ${result.changed} changed, ${result.failed} not read.`)
  return result
}
