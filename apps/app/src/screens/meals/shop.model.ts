import type { Item, ItemKind, Unit } from '@waypoint/core/meals'
import type { StarterBudget } from '@waypoint/core/meals-starter'
import type { Product } from '@/server/mercadona'
import { amountWords } from './meals.model'

// Add an item: the search over the saved items, and a Mercadona product made into a new item.

// Lower case without accents, so "platano" finds "Plátano".
export const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

// Kept items whose name or aisle holds every typed word, by name.
export function matchItems(items: readonly Item[], query: string, locale: string): Item[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  return items
    .filter((i) => i.archived_at === null)
    .filter((i) => {
      const text = fold(`${i.name} ${i.aisle ?? ''}`)
      return words.every((w) => text.includes(w))
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale))
}

interface Section {
  aisle: string
  kind: ItemKind
  budget: StarterBudget
}

const FRESH = (aisle: string): Section => ({ aisle, kind: 'recipe', budget: 'meals' })
const KEPT = (aisle: string, budget: StarterBudget = 'meals'): Section => ({ aisle, kind: 'stock', budget })

// The shop's top sections, in the starter pack's aisle names where it has one.
const SECTIONS: Record<string, Section> = {
  'Fruta y verdura': FRESH('Fruit and veg'),
  Carne: FRESH('Meat'),
  'Marisco y pescado': FRESH('Fish and seafood'),
  'Charcutería y quesos': FRESH('Chilled'),
  'Postres y yogures': FRESH('Chilled'),
  'Pizzas y platos preparados': FRESH('Chilled'),
  'Panadería y pastelería': FRESH('Bakery'),
  Congelados: KEPT('Frozen'),
  'Huevos, leche y mantequilla': KEPT('Eggs and milk'),
  'Arroz, legumbres y pasta': KEPT('Rice, pasta and noodles'),
  'Aceite, especias y salsas': KEPT('Oil, sauces and spices'),
  'Conservas, caldos y cremas': KEPT('Tins and stock'),
  'Cereales y galletas': KEPT('Breakfast'),
  'Cacao, café e infusiones': KEPT('Breakfast'),
  'Azúcar, caramelos y chocolate': KEPT('Sweets and snacks'),
  Aperitivos: KEPT('Sweets and snacks'),
  'Agua y refrescos': KEPT('Drinks'),
  Zumos: KEPT('Drinks'),
  Bodega: KEPT('Drinks'),
  'Limpieza y hogar': KEPT('Cleaning', 'cleaning'),
  'Cuidado del cabello': KEPT('Personal care', 'personal care'),
  'Cuidado facial y corporal': KEPT('Personal care', 'personal care'),
  Maquillaje: KEPT('Personal care', 'personal care'),
  'Fitoterapia y parafarmacia': KEPT('Personal care', 'personal care'),
  Bebé: KEPT('Baby'),
  Mascotas: KEPT('Pets'),
}

// A new item's fields from a product: its pack in grams, millilitres or a count, the pack price in cents, and an aisle from the shop's section.
export interface ProductDraft {
  name: string
  kind: ItemKind
  unit: Unit
  pack_size: number
  price_minor: number | null
  mercadona_id: string
  aisle: string | null
  budget: StarterBudget
}

const cents = (euros: string | null) => (euros !== null && /^\d+(\.\d{1,3})?$/.test(euros) ? Math.round(Number(euros) * 100) : null)
const round3 = (n: number) => Math.round(n * 1000) / 1000

function pack(p: Product): { unit: Unit; pack_size: number } {
  const size = p.size ?? 0
  if (p.size_format === 'kg' && size > 0) return { unit: 'g', pack_size: round3(size * 1000) }
  if (p.size_format === 'l' && size > 0) return { unit: 'ml', pack_size: round3(size * 1000) }
  // A pack of 40 bin bags is one "ud" holding 40.
  if (p.size_format === 'ud') return { unit: 'unit', pack_size: round3(p.units ?? (size > 0 ? size : 1)) }
  return { unit: 'unit', pack_size: 1 }
}

export function productDraft(p: Product): ProductDraft {
  const section = p.category ? SECTIONS[p.category] : undefined
  const price = cents(p.price)
  return {
    name: p.name.slice(0, 60),
    kind: section?.kind ?? 'stock',
    ...pack(p),
    price_minor: price !== null && price > 0 ? price : null,
    mercadona_id: p.id,
    aisle: section?.aisle ?? p.category?.slice(0, 40) ?? null,
    budget: section?.budget ?? 'meals',
  }
}

// Eggs' dc and dz are priced per egg: 12 for €3.05 reads 0.25 dc.
const PER: Record<string, string> = { kg: 'kg', l: 'l', ud: 'each', dc: 'each', dz: 'each' }

// Under a product's name: "1 kg · €1.20 · €1.20/kg", with "about" for a pack weighed at the till.
export function productWords(p: Product, money: (minor: number) => string, locale: string): string {
  const d = productDraft(p)
  const size = d.unit === 'unit' ? (d.pack_size === 1 ? p.packaging : `${amountWords(d.pack_size, 'unit', locale)} in a pack`) : `${p.approx ? 'about ' : ''}${amountWords(d.pack_size, d.unit, locale)}`
  const per = cents(p.unit_price)
  const ref = p.per ? (PER[p.per.toLowerCase()] ?? p.per) : null
  const unit = per !== null && ref ? `${money(per)}${ref === 'each' ? ' each' : `/${ref}`}` : null
  return [size, d.price_minor !== null ? money(d.price_minor) : null, unit].filter(Boolean).join(' · ')
}

// A product already linked to a kept item adds that item instead of a copy.
export const linkedItem = (items: readonly Item[], p: Product) => items.find((i) => i.archived_at === null && i.mercadona_id === p.id) ?? null
