import { buildSnapshot, type Snapshot } from '@waypoint/core'
import { abroad } from '@waypoint/core/fixtures'
import { mealsDoc, type Item, type ShopLine } from '@waypoint/core/meals'
import { starterDoc } from '@waypoint/core/meals-starter'
import { describe, expect, it } from 'vitest'
import { amountWords, buyWords, cookedWeekBefore, mercadonaIdFrom, priceList, priceWords, reasonWords, starterCategories, weekFromParam, weekRange, weekView } from './meals.model'
import { sampleMeals } from './sample'

const AS_OF = '2026-10-23'

function snapshot(): Snapshot {
  const sample = abroad(AS_OF)
  return buildSnapshot(sample.doc, AS_OF, sample.rates)
}

const euros = (minor: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(minor / 100)

const item = (patch: Partial<Item> = {}): Item => ({
  id: 'soy',
  name: 'Soy sauce',
  kind: 'stock',
  unit: 'ml',
  pack_size: 250,
  loose: false,
  price_minor: 120,
  price_checked_on: '2026-10-21',
  price_source: 'mercadona',
  mercadona_id: '17360',
  aisle: 'Sauces',
  category_id: null,
  lasts_days: 21,
  wanted_on: null,
  unavailable_on: null,
  at_home_on: null,
  archived_at: null,
  ...patch,
})

describe('meals screens', () => {
  it('opens the week that holds ?week=, from the shopping day, and this week without one', () => {
    // 23 Oct 2026 is a Friday; the week runs from Saturday 17 Oct.
    expect([weekFromParam(undefined, AS_OF, 5), weekFromParam('2026-10-30', AS_OF, 5), weekFromParam('not a day', AS_OF, 5), weekFromParam('2026-10-23', AS_OF, 0)]).toEqual(['2026-10-17', '2026-10-24', '2026-10-17', '2026-10-19'])
    expect([weekRange('2026-10-17', 'en-IE'), weekRange('2026-10-31', 'en-IE'), weekRange('2026-10-17', 'en-PH')]).toEqual(['17–23 Oct', '31 Oct\u2009–\u20096 Nov', 'Oct 17\u2009–\u200923'])
  })

  it('finds the recipes cooked the week before the one that holds a day, from the shopping day', () => {
    const doc = mealsDoc.parse({
      ...starterDoc({ meals: null, cleaning: null, care: null }, 'EUR', 5, 2),
      meals: [
        { id: 'a', day: '2026-10-16', slot: 'lunch', recipe_id: 'teriyaki', leftovers: true },
        { id: 'b', day: '2026-10-17', slot: 'lunch', recipe_id: 'mapo', leftovers: true },
        { id: 'c', day: '2026-10-25', slot: 'lunch', recipe_id: 'adobo', leftovers: true },
      ],
    })
    // Tuesday 27 Oct: shopping on Saturday, last week ran 17 to 23 Oct; shopping on Monday, it ran 19 to 25 Oct.
    expect([[...cookedWeekBefore(doc, '2026-10-27', 5)], [...cookedWeekBefore(doc, '2026-10-27', 0)]]).toEqual([['mapo'], ['adobo']])
  })

  it('words amounts, packs and loose items as a shopper reads them', () => {
    expect([amountWords(620, 'g', 'en-IE'), amountWords(1500, 'g', 'en-IE'), amountWords(250, 'ml', 'en-IE'), amountWords(6000, 'ml', 'en-IE'), amountWords(0.5, 'unit', 'en-IE')]).toEqual(['620 g', '1.5 kg', '250 ml', '6 l', '0.5'])
    const line = (i: Item, packs: number, amount: number): ShopLine => ({ item: i, trip: AS_OF, packs, amount, cost_minor: 240, category_id: null, reasons: [], bought: null, unavailable: false, at_home: false })
    expect(buyWords(line(item(), 2, 500), 'en-IE')).toBe('2 × Soy sauce, 250 ml')
    expect(buyWords(line(item({ name: 'Tomatoes', unit: 'g', pack_size: 1000, loose: true }), 1, 350), 'en-IE')).toBe('About 350 g Tomatoes')
  })

  it('says when and where a price was checked, calls it stale after 30 days, and never shows a missing price as zero', () => {
    expect(priceWords(item(), AS_OF, euros, 'en-IE')).toEqual({ text: '€1.20 a pack · checked 21 Oct, Mercadona online', checked: 'checked 21 Oct, Mercadona online', stale: false })
    expect(priceWords(item({ price_checked_on: '2026-09-20', price_source: 'typed' }), AS_OF, euros, 'en-IE')).toEqual({ text: '€1.20 a pack · checked 20 Sept, typed in', checked: 'checked 20 Sept, typed in', stale: true })
    expect(priceWords(item({ price_minor: null, price_checked_on: null, price_source: null }), AS_OF, euros, 'en-IE')).toEqual({ text: 'No price yet', checked: 'No price yet', stale: false })
  })

  it('names why a line is on the list', () => {
    expect([
      reasonWords({ kind: 'meals', first_day: AS_OF, recipes: ['Chicken adobo', 'Tinola'] }, 'en-IE'),
      reasonWords({ kind: 'runs_out', day: '2026-10-27', late: false }, 'en-IE'),
      reasonWords({ kind: 'runs_out', day: '2026-10-20', late: true }, 'en-IE'),
      reasonWords({ kind: 'wanted', since: AS_OF }, 'en-IE'),
    ]).toEqual(['For Chicken adobo, Tinola', 'Runs out about 27 Oct', 'May have run out 20 Oct', 'Added by you'])
  })

  it('reads the product number from a Mercadona link, or the number alone, and nothing else', () => {
    expect([
      mercadonaIdFrom('https://tienda.mercadona.es/product/4241/aceite-oliva-04o-hacendado-garrafa'),
      mercadonaIdFrom(' 17360 '),
      mercadonaIdFrom('https://tienda.mercadona.es/product/81649.4/salmon'),
      mercadonaIdFrom('https://example.com/product/4241'),
      mercadonaIdFrom('soy sauce'),
    ]).toEqual(['4241', '17360', '81649.4', null, null])
  })

  it('weighs the week’s shopping against its share of the Groceries allowance and the month', () => {
    const s = snapshot()
    const doc = sampleMeals(s)
    const settings = { category_id: 'cat-groceries', currency: 'EUR', shop_weekday: 5, people: 2 }
    const v = weekView(s, doc, settings, '2026-10-17')
    expect(v.days.map((d) => [d.day.slice(8), d.lunch?.recipe.name, d.dinner === 'leftovers' ? 'leftovers' : d.dinner?.recipe.name])).toEqual([
      ['17', 'Chicken adobo', 'leftovers'],
      ['18', 'Chicken teriyaki with broccoli', 'leftovers'],
      ['19', 'Chicken tinola (ginger soup)', 'leftovers'],
      ['20', 'Prawn egg fried rice', 'Ginger-soy salmon with cucumber salad'],
      ['21', 'Coconut chicken curry', 'leftovers'],
      ['22', 'Pancit-style noodles with pork and cabbage', 'leftovers'],
      ['23', 'Garlic-pepper pork mince with fried egg', 'leftovers'],
    ])
    // October's Groceries is 400 less a one-off 50 credit: 350 × 7 ÷ 31.
    expect(v.budget).toMatchObject({ currency: 'EUR', budget_minor: 7903, approx: false })
    expect(v.budget!.cost_minor).toBe(v.trips[0]!.totals.find((t) => t.category_id === 'cat-groceries')!.cost_minor)
    expect(v.budget!.over_minor).toBe(Math.max(0, v.budget!.cost_minor - 7903))
    expect([v.trips.length, v.missing]).toEqual([1, 0])
    // The trip was on the 17th, before today, so nothing on it is still to buy this month.
    expect(v.month).toMatchObject({ month: '2026-10', currency: 'EUR', budget_minor: 35000, planned_minor: 0 })
  })

  it('leaves lines not in stock out of what is still to buy this month, so a kept-in item moved to the next trip counts once', () => {
    const settings = { category_id: 'cat-groceries', currency: 'EUR', shop_weekday: 5, people: 2 }
    const v = weekView(snapshot(), {
      settings,
      items: [
        item({ id: 'thighs', name: 'Chicken thighs', kind: 'recipe', unit: 'g', pack_size: 600, price_minor: 389, unavailable_on: '2026-10-24' }),
        item({ id: 'onions', name: 'Spring onions', kind: 'recipe', unit: 'unit', pack_size: 1, price_minor: 85 }),
        item({ id: 'soap', name: 'Dish soap', lasts_days: 30, price_minor: 155, unavailable_on: '2026-10-24' }),
      ],
      purchases: [{ id: 'p1', item_id: 'soap', bought_on: '2026-09-10', packs: 1, price_minor: null }],
      recipes: [{ id: 'adobo', name: 'Chicken adobo', portions: 4, prep_minutes: 15, steps: '', archived_at: null }],
      recipe_items: [
        { id: 'l1', recipe_id: 'adobo', item_id: 'thighs', quantity: 600, sort_order: 0 },
        { id: 'l2', recipe_id: 'adobo', item_id: 'onions', quantity: 1, sort_order: 1 },
      ],
      meals: [{ id: 'm1', day: '2026-10-24', slot: 'lunch', recipe_id: 'adobo', leftovers: true }],
      trips: [
        { id: 't1', day: '2026-10-24' },
        { id: 't2', day: '2026-10-28' },
      ],
    }, settings, '2026-10-24')
    // Saturday still buys the onions and Wednesday the soap; the thighs need a swap.
    expect(v.trips.map((t) => t.lines.map((l) => [l.item.id, l.unavailable]))).toEqual([
      [['thighs', true], ['soap', true], ['onions', false]],
      [['soap', false]],
    ])
    expect(v.month?.planned_minor).toBe(85 + 155)
  })

  it('groups the price list by aisle, archived last, with each kept-in item’s run-out day', () => {
    const s = snapshot()
    const doc = sampleMeals(s)
    const groups = priceList(doc, AS_OF, euros, 'en-IE')
    expect(groups.map((g) => g.aisle)).toEqual(['Chilled', 'Cleaning', 'Eggs and milk', 'Fish and seafood', 'Frozen', 'Fruit and veg', 'Meat', 'Oil, sauces and spices', 'Personal care', 'Rice, pasta and noodles'])
    const rice = groups.flatMap((g) => g.rows).find((r) => r.item.id === 'rice')!
    // Bought two Saturdays running: a pack lasts 7 days, so it ran out on the 17th.
    expect([rice.last_bought, rice.runs_out]).toEqual(['2026-10-10', '2026-10-17'])
  })

  it('matches the starter pack’s cleaning and personal care to the household’s own categories by name', () => {
    const s = snapshot()
    const cats = { ...s, doc: { ...s.doc, categories: [...s.doc.categories, { id: 'c1', name: 'Cleaning + laundry supplies', archived_at: null }, { id: 'c2', name: 'Personal care + cosmetics', archived_at: null }] } } as Snapshot
    expect(starterCategories(cats, 'cat-groceries')).toEqual({ meals: 'cat-groceries', cleaning: 'c1', care: 'c2' })
    expect(starterCategories(s, null)).toEqual({ meals: null, cleaning: null, care: null })
  })
})
