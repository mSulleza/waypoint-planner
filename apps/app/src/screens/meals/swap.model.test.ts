import { mealsDoc, type MealsDoc, type MealSettings } from '@waypoint/core/meals'
import { describe, expect, it } from 'vitest'
import { priceFix, swappedLines, variantRecipe } from './swap.model'

const SETTINGS: MealSettings = { category_id: null, currency: 'EUR', shop_weekday: 5, people: 2 }
const priced = (price_minor: number) => ({ price_minor, price_checked_on: '2026-10-24', price_source: 'typed' as const })

// Honey-garlic pork belly for 4: 500 g belly at 3.15, 15 g garlic and 300 g rice; thighs and chicken curry to swap to.
function doc(): MealsDoc {
  return mealsDoc.parse({
    items: [
      { id: 'belly', name: 'Pork belly', kind: 'recipe', unit: 'g', pack_size: 500, ...priced(315) },
      { id: 'thighs', name: 'Chicken thighs', kind: 'recipe', unit: 'g', pack_size: 620, ...priced(422) },
      { id: 'garlic', name: 'Garlic', kind: 'stock', unit: 'g', pack_size: 250, ...priced(185) },
      { id: 'rice', name: 'Rice', kind: 'stock', unit: 'g', pack_size: 1000, ...priced(120) },
    ],
    recipes: [
      { id: 'pb', name: 'Honey-garlic pork belly', portions: 4, prep_minutes: 25, steps: '1. Fry.' },
      { id: 'curry', name: 'Chicken curry', portions: 4, prep_minutes: 30 },
    ],
    recipe_items: [
      { id: 'a', recipe_id: 'pb', item_id: 'belly', quantity: 500 },
      { id: 'b', recipe_id: 'pb', item_id: 'garlic', quantity: 15, sort_order: 1 },
      { id: 'c', recipe_id: 'pb', item_id: 'rice', quantity: 300, sort_order: 2 },
      { id: 'd', recipe_id: 'curry', item_id: 'thighs', quantity: 620 },
      { id: 'e', recipe_id: 'curry', item_id: 'rice', quantity: 300, sort_order: 1 },
    ],
    meals: [{ id: 'thu', day: '2026-10-29', slot: 'lunch', recipe_id: 'pb', leftovers: true }],
  })
}

describe('meals swaps', () => {
  it('prices an ingredient swap and a recipe swap with core, against the meal as planned', () => {
    const d = doc()
    const [meal, recipe, belly] = [d.meals[0]!, d.recipes[0]!, d.items[0]!]
    // As planned: 315 + 11 (15 g of 250 g garlic) + 36 (300 g of 1 kg rice) = 362.
    const thighs = priceFix(d, SETTINGS, meal, recipe, belly, { type: 'ingredient', with_item_id: 'thighs', quantity: 500, note: '' })
    // 500 g of a 620 g pack at 4.22 is 340.3, so 340 + 11 + 36 = 387.
    expect(thighs).toMatchObject({ title: 'Use Chicken thighs instead of Pork belly', cost_minor: 387, missing: 0, delta_minor: 25 })
    const curry = priceFix(d, SETTINGS, meal, recipe, belly, { type: 'recipe', recipe_id: 'curry', note: '' })
    expect(curry).toMatchObject({ title: 'Cook Chicken curry instead', cost_minor: 422 + 36, delta_minor: 422 + 36 - 362 })
  })

  it('saves an ingredient swap as a copy of the recipe, merging the item when the recipe already uses it', () => {
    const d = doc()
    let n = 0
    const variant = variantRecipe(d, d.recipes[0]!, d.items[0]!, { type: 'ingredient', with_item_id: 'thighs', quantity: 500, note: 'Same glaze.' }, () => `id${++n}`)
    expect(variant.row).toMatchObject({ id: 'id1', name: 'Honey-garlic pork belly with Chicken thighs', portions: 4, steps: 'Swap: Chicken thighs instead of Pork belly. Same glaze.\n1. Fry.' })
    expect(variant.lines.map((l) => [l.recipe_id, l.item_id, l.quantity])).toEqual([['id1', 'thighs', 500], ['id1', 'garlic', 15], ['id1', 'rice', 300]])
    expect(swappedLines(d, d.recipes[0]!, d.items[0]!, 'rice', 200)).toEqual([{ item_id: 'rice', quantity: 500 }, { item_id: 'garlic', quantity: 15 }])
  })
})
