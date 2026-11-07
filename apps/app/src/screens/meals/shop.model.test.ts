import type { Item } from '@waypoint/core/meals'
import { describe, expect, it } from 'vitest'
import type { Product } from '@/server/mercadona'
import { fold, linkedItem, matchItems, productDraft, productWords } from './shop.model'

const item = (id: string, name: string, aisle: string | null, patch: Partial<Item> = {}): Item => ({
  id,
  name,
  kind: 'stock',
  unit: 'unit',
  pack_size: 1,
  loose: false,
  price_minor: null,
  price_checked_on: null,
  price_source: null,
  mercadona_id: null,
  aisle,
  category_id: null,
  lasts_days: null,
  wanted_on: null,
  unavailable_on: null,
  at_home_on: null,
  archived_at: null,
  ...patch,
})

const ITEMS = [
  item('banana', 'Plátano', 'Fruit and veg'),
  item('bay', 'Bay leaves', 'Oil, sauces and spices'),
  item('bags', 'Bin bags 30 L', 'Cleaning', { mercadona_id: '49750' }),
  item('pepper', 'Black pepper, ground', 'Oil, sauces and spices'),
  item('old', 'Platanos fritos', 'Snacks', { archived_at: '2026-10-01T00:00:00Z' }),
]

const product = (patch: Partial<Product>): Product => ({ id: '1', name: 'Product', packaging: 'Paquete', price: '1.00', unit_price: null, per: null, size: null, size_format: null, units: null, approx: false, category: null, ...patch })

// Real products from zone 3968 on 30 Oct 2026.
const MILK = product({ id: '10381', name: 'Leche semidesnatada Hacendado', packaging: null, price: '4.98', unit_price: '0.83', per: 'L', size: 6, size_format: 'l', units: 6, category: 'Huevos, leche y mantequilla' })
const EGGS = product({ id: '31504', name: 'Huevos grandes L', price: '3.05', unit_price: '0.25', per: 'dc', size: 12, size_format: 'ud', category: 'Huevos, leche y mantequilla' })
const BAGS = product({ id: '49750', name: 'Bolsas de basura 30L Bosque Verde perfumadas', price: '1.80', unit_price: '0.05', per: 'ud', size: 1, size_format: 'ud', units: 40, category: 'Limpieza y hogar' })
const BANANA = product({ id: '3819', name: 'Plátano de Canarias IGP', packaging: 'Pieza', price: '0.46', unit_price: '3.00', per: 'kg', size: 0.154, size_format: 'kg', approx: true, category: 'Fruta y verdura' })

const euros = (minor: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(minor / 100)

describe('Add an item', () => {
  it('folds case and accents', () => {
    expect([fold('Plátano'), fold('JAMÓN Ibérico'), fold('pingüino')]).toEqual(['platano', 'jamon iberico', 'pinguino'])
  })

  it('finds kept items by name or aisle, every word, without accents, by name', () => {
    const ids = (q: string) => matchItems(ITEMS, q, 'en').map((i) => i.id)
    expect(ids('platano')).toEqual(['banana'])
    expect(ids('PLÁTANO')).toEqual(['banana'])
    expect(ids('spices')).toEqual(['bay', 'pepper'])
    expect(ids('pepper spices')).toEqual(['pepper'])
    expect(ids('clean')).toEqual(['bags'])
    expect(ids('')).toEqual(['bay', 'bags', 'pepper', 'banana'])
    expect(ids('nothing')).toEqual([])
  })

  it('makes a product into a new item: its pack in g, ml or a count, its price in cents, an aisle and kind from its section', () => {
    expect(productDraft(MILK)).toEqual({ name: 'Leche semidesnatada Hacendado', kind: 'stock', unit: 'ml', pack_size: 6000, price_minor: 498, mercadona_id: '10381', aisle: 'Eggs and milk', budget: 'meals' })
    expect(productDraft(EGGS)).toMatchObject({ unit: 'unit', pack_size: 12, price_minor: 305 })
    expect(productDraft(BAGS)).toMatchObject({ unit: 'unit', pack_size: 40, kind: 'stock', aisle: 'Cleaning', budget: 'cleaning' })
    expect(productDraft(BANANA)).toMatchObject({ unit: 'g', pack_size: 154, kind: 'recipe', aisle: 'Fruit and veg', price_minor: 46 })
    // A section with no aisle of its own keeps the shop's name; no size is a pack of one.
    expect(productDraft(product({ category: 'Nueva sección', name: 'x'.repeat(70) }))).toMatchObject({ unit: 'unit', pack_size: 1, kind: 'stock', aisle: 'Nueva sección', name: 'x'.repeat(60) })
  })

  it('says each product’s pack, price and unit price', () => {
    expect(productWords(MILK, euros, 'en')).toBe('6 l · €4.98 · €0.83/l')
    expect(productWords(EGGS, euros, 'en')).toBe('12 in a pack · €3.05 · €0.25 each')
    expect(productWords(BAGS, euros, 'en')).toBe('40 in a pack · €1.80 · €0.05 each')
    expect(productWords(BANANA, euros, 'en')).toBe('about 154 g · €0.46 · €3.00/kg')
  })

  it('finds the kept item a product is already linked to', () => {
    expect(linkedItem(ITEMS, BAGS)?.id).toBe('bags')
    expect(linkedItem(ITEMS, MILK)).toBeNull()
  })
})
