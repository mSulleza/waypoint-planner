import { addDays, type Snapshot } from '@waypoint/core'
import { mealsDoc, settingsOf, weekStartOf, type MealsDoc } from '@waypoint/core/meals'
import { starterDoc } from '@waypoint/core/meals-starter'

// Made-up shelf prices for the samples, in minor units of the sample's own currency; no shop's real prices ship with the app.
const SAMPLE_PRICES: Readonly<Record<string, number>> = {
  thighs: 420, breast: 410, 'pork-mince': 280, 'pork-belly': 320, beef: 900, salmon: 820, prawns: 490, tofu: 175, 'spring-onions': 170, broccoli: 100,
  cabbage: 190, cucumber: 35, courgette: 60, 'red-pepper': 60, spinach: 130, lime: 45, 'wok-veg': 190, coconut: 130, 'rice-noodles': 145, ramen: 85,
  rice: 120, soy: 120, teriyaki: 170, 'sweet-chili': 140, oil: 370, vinegar: 65, honey: 320, cornflour: 120, curry: 110, pepper: 130, paprika: 135, bay: 85, stock: 75,
  garlic: 185, ginger: 165, onions: 150, carrots: 100, peas: 155, eggs: 305, milk: 500, 'dish-soap': 115, laundry: 465, 'toilet-paper': 240, shampoo: 135,
  'shower-gel': 95, toothpaste: 110,
}

// The read-only week a sample shows: the starter pack priced a week ago, this week cooked once a day, and a few kept-in items bought before.
export function sampleMeals(snapshot: Snapshot): MealsDoc {
  const settings = settingsOf({ settings: null, items: [], purchases: [], recipes: [], recipe_items: [], meals: [], trips: [] }, snapshot)
  const start = weekStartOf(snapshot.as_of, settings.shop_weekday)
  const checked = addDays(start, -7)
  const base = starterDoc({ meals: settings.category_id, cleaning: null, care: null }, settings.currency, settings.shop_weekday, settings.people)
  const week: [number, string, boolean][] = [[0, 'adobo', true], [1, 'teriyaki', true], [2, 'tinola', true], [3, 'fried-rice', false], [4, 'curry', true], [5, 'pancit', true], [6, 'kra-pao', true]]
  const doc = mealsDoc.parse({
    ...base,
    items: (base.items ?? []).map((i) => (SAMPLE_PRICES[i.id] === undefined ? i : { ...i, price_minor: SAMPLE_PRICES[i.id], price_checked_on: checked, price_source: 'typed' })),
    purchases: [
      { id: 'p1', item_id: 'rice', bought_on: addDays(start, -14) },
      { id: 'p2', item_id: 'rice', bought_on: addDays(start, -7) },
      { id: 'p3', item_id: 'dish-soap', bought_on: addDays(start, -40) },
      { id: 'p4', item_id: 'eggs', bought_on: addDays(start, -6) },
      { id: 'p5', item_id: 'soy', bought_on: addDays(start, -30) },
    ],
    meals: [
      ...week.map(([d, recipe, leftovers]) => ({ id: `m${d}`, day: addDays(start, d), slot: 'lunch', recipe_id: recipe, leftovers })),
      { id: 'm3d', day: addDays(start, 3), slot: 'dinner', recipe_id: 'salmon' },
    ],
  })
  return doc
}

