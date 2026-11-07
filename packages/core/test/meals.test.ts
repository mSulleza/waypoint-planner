import { describe, expect, it } from 'vitest'
import { checkInput } from '../src/schema/common'
import { costOf, forecast, missingMeals, mealsDoc, settingsOf, shoppingWeek, weekBudget, weekPlan, weekStartOf, weekTrips, type MealsDocInput, type MealSettings } from '../src/meals'
import { STARTER_ITEMS, STARTER_RECIPES, starterDoc } from '../src/meals-starter'
import { cashHousehold } from './walk-helpers'

const SETTINGS: MealSettings = { category_id: 'food', currency: 'EUR', shop_weekday: 5, people: 2 }

const priced = { price_checked_on: '2026-10-23', price_source: 'mercadona' as const }

// Adobo for 4 from a 600 g pack of thighs and a 1 kg bag of rice; dish soap and rice kept in, eggs asked for.
function doc(edit?: (d: Required<MealsDocInput>) => void) {
  const d: Required<MealsDocInput> = {
    settings: SETTINGS,
    items: [
      { id: 'thighs', name: 'Chicken thighs', kind: 'recipe', unit: 'g', pack_size: 600, price_minor: 389, ...priced, aisle: 'Aves y pollo' },
      { id: 'garlic', name: 'Garlic', kind: 'recipe', unit: 'unit', pack_size: 1, loose: true, price_minor: 40, ...priced, aisle: 'Verdura' },
      { id: 'rice', name: 'Rice', kind: 'stock', unit: 'g', pack_size: 1000, price_minor: 129, ...priced, aisle: 'Arroz', lasts_days: 30 },
      { id: 'soap', name: 'Dish soap', kind: 'stock', unit: 'ml', pack_size: 750, price_minor: 155, ...priced, category_id: 'cleaning', lasts_days: 40 },
      { id: 'eggs', name: 'Eggs', kind: 'stock', unit: 'unit', pack_size: 12, wanted_on: '2026-10-25' },
    ],
    purchases: [
      { id: 'r1', item_id: 'rice', bought_on: '2026-09-01' },
      { id: 'r2', item_id: 'rice', bought_on: '2026-09-15' },
      { id: 'r3', item_id: 'rice', bought_on: '2026-10-06', packs: 2 },
      { id: 's1', item_id: 'soap', bought_on: '2026-09-10' },
    ],
    recipes: [{ id: 'adobo', name: 'Chicken adobo', portions: 4, prep_minutes: 15, steps: 'Brown, then simmer.' }],
    recipe_items: [
      { id: 'l1', recipe_id: 'adobo', item_id: 'thighs', quantity: 600 },
      { id: 'l2', recipe_id: 'adobo', item_id: 'garlic', quantity: 1.5, sort_order: 1 },
      { id: 'l3', recipe_id: 'adobo', item_id: 'rice', quantity: 300, sort_order: 2 },
    ],
    meals: [
      { id: 'm1', day: '2026-10-24', slot: 'lunch', recipe_id: 'adobo', leftovers: true },
      { id: 'm2', day: '2026-10-29', slot: 'lunch', recipe_id: 'adobo' },
    ],
    trips: [],
  }
  edit?.(d)
  const checked = checkInput(mealsDoc, d)
  if (!checked.ok) throw new Error(checked.errors.join('; '))
  return checked.value
}

describe('meals', () => {
  it('starts the week of meals on the shopping weekday on or before the day', () => {
    // 24 Oct 2026 is a Saturday.
    expect([weekStartOf('2026-10-24', 5), weekStartOf('2026-10-23', 5), weekStartOf('2026-10-30', 5), weekStartOf('2026-10-23', 0)]).toEqual(['2026-10-24', '2026-10-17', '2026-10-24', '2026-10-19'])
  })

  it('prices a quantity at its pack price to the cent, and an item with no price as null, never 0', () => {
    const d = doc()
    const item = (id: string) => d.items.find((i) => i.id === id)!
    expect([costOf(item('rice'), 300), costOf(item('thighs'), 600), costOf(item('garlic'), 1.5), costOf(item('eggs'), 6)]).toEqual([39, 389, 60, null])
  })

  it('cooks lunch for dinner too as twice the people, and counts what has no price apart', () => {
    const d = doc((x) => {
      x.items.push({ id: 'leaf', name: 'Bay leaf', kind: 'stock', unit: 'unit', pack_size: 20 })
      x.recipe_items.push({ id: 'l4', recipe_id: 'adobo', item_id: 'leaf', quantity: 2, sort_order: 3 })
    })
    const [sat, , , , , wed] = weekPlan(d, SETTINGS, '2026-10-24')
    expect(sat!.dinner).toBe('leftovers')
    expect(sat!.lunch!.cost).toMatchObject({ portions: 4, cost_minor: 389 + 60 + 39, per_portion_minor: 122, missing: 1 })
    expect(wed!.lunch!.cost.ingredients.map((i) => [i.item.id, i.quantity])).toEqual([['thighs', 300], ['garlic', 0.75], ['rice', 150], ['leaf', 1]])
    expect([sat!.trip, wed!.trip]).toEqual([true, false])
  })

  it('learns how long a pack lasts from the median gap between purchases, else takes the guess', () => {
    const d = doc()
    // Gaps of 14 and 21 days a pack: 17.5 rounds to 18; the last buy was 2 packs.
    expect(forecast(d, d.items.find((i) => i.id === 'rice')!, '2026-10-24')).toMatchObject({ lasts_days: 18, learned: true, runs_out: '2026-11-11' })
    expect(forecast(d, d.items.find((i) => i.id === 'soap')!, '2026-10-24')).toMatchObject({ lasts_days: 40, learned: false, runs_out: '2026-10-20' })
    expect(forecast(d, d.items.find((i) => i.id === 'eggs')!, '2026-10-24')).toMatchObject({ last: null, runs_out: null })
  })

  it('makes one list per trip: each meal on the trip before it, a kept-in item before it runs out, an asked-for item from its day', () => {
    const d = doc((x) => x.trips.push({ id: 't1', day: '2026-10-24' }, { id: 't2', day: '2026-10-28' }))
    expect(weekTrips(d, '2026-10-24')).toEqual(['2026-10-24', '2026-10-28'])
    const [sat, wed] = shoppingWeek(d, SETTINGS, '2026-10-24')
    const lines = (t: typeof sat) => t!.lines.map((l) => [l.item.id, l.packs, l.amount, l.cost_minor, l.reasons.map((r) => r.kind).join('+')])
    // Saturday: 600 g of thighs for 4, 1.5 garlic, and the soap that ran out on 20 Oct. Wednesday: 300 g rounds up to a pack, 0.75 garlic, and eggs from Sunday.
    expect(lines(sat)).toEqual([
      ['thighs', 1, 600, 389, 'meals'],
      ['garlic', 1, 1.5, 60, 'meals'],
      ['soap', 1, 750, 155, 'runs_out'],
    ])
    expect(sat!.lines.find((l) => l.item.id === 'soap')!.reasons[0]).toEqual({ kind: 'runs_out', day: '2026-10-20', late: true })
    expect(lines(wed)).toEqual([
      ['thighs', 1, 600, 389, 'meals'],
      ['garlic', 1, 0.75, 30, 'meals'],
      ['eggs', 1, 12, null, 'wanted'],
    ])
    expect(sat!.totals).toEqual([
      { category_id: 'food', cost_minor: 449, missing: 0 },
      { category_id: 'cleaning', cost_minor: 155, missing: 0 },
    ])
    expect([wed!.cost_minor, wed!.missing]).toEqual([419, 1])
  })

  it('keeps a bought line on its trip, at the price paid, and drops a kept-in item once bought before the week', () => {
    const d = doc((x) => x.purchases.push({ id: 'p1', item_id: 'thighs', bought_on: '2026-10-24', packs: 2, price_minor: 400 }, { id: 'p2', item_id: 'soap', bought_on: '2026-10-21' }))
    const [sat] = shoppingWeek(d, SETTINGS, '2026-10-24')
    const thighs = sat!.lines.find((l) => l.item.id === 'thighs')!
    // Both meals' thighs on the one trip: 600 + 300 g is 2 packs, bought at 4.00 each.
    expect([thighs.packs, thighs.cost_minor, thighs.bought?.id, sat!.bought]).toEqual([2, 800, 'p1', 1])
    expect(sat!.lines.some((l) => l.item.id === 'soap')).toBe(false)
  })

  it('takes the household Groceries allowance and base currency until meals settings are saved', () => {
    const snapshot = cashHousehold('2026-10-23', (h) => h.categories.push({ id: 'groc', name: 'Groceries' }))
    expect(settingsOf(doc((x) => (x.settings = null)), snapshot)).toEqual({ category_id: 'groc', currency: 'EUR', shop_weekday: 5, people: 2 })
  })

  it('shares the allowance by day, so a week across a month end takes each month’s part, and a past month has none', () => {
    const snapshot = cashHousehold('2026-10-23', (h) => h.plan_items.push({ id: 'food', kind: 'allowance', name: 'Food', from_account_id: 'bank', category_id: 'food', amount_minor: 37000, starts_on: '2026-09-01' }))
    // 31 Oct is 1 of October's 31 days, 1 to 6 Nov are 6 of November's 30.
    expect(weekBudget(snapshot, 'food', '2026-10-31')).toEqual({ category_id: 'food', currency: 'EUR', budget_minor: 1194 + 7400 })
    expect(weekBudget(snapshot, 'food', '2026-10-24')!.budget_minor).toBe(8355)
    expect(weekBudget(snapshot, 'food', '2026-09-26')).toBeNull()
  })

  it('refuses a line, purchase or meal naming a row the document does not have, and leftovers at dinner', () => {
    const errors = (input: unknown) => {
      const checked = checkInput(mealsDoc, input)
      return checked.ok ? [] : checked.errors
    }
    expect(errors({ recipe_items: [{ id: 'x', recipe_id: 'nope', item_id: 'gone', quantity: 1 }], meals: [{ id: 'm', day: '2026-10-24', slot: 'lunch', recipe_id: 'nope' }] })).toEqual([
      "recipe_items[0].recipe_id: no recipe 'nope' in the document",
      "recipe_items[0].item_id: no item 'gone' in the document",
      "meals[0].recipe_id: no recipe 'nope' in the document",
    ])
    expect(errors({ recipes: [{ id: 'r', name: 'Soup', portions: 2, prep_minutes: 10 }], meals: [{ id: 'm', day: '2026-10-24', slot: 'dinner', recipe_id: 'r', leftovers: true }] })).toEqual(['meals[0].leftovers: only a lunch is cooked for dinner too'])
  })

  it('ships a starter pack of quick recipes for 4 whose every line names one of its items, unpriced, that the meals check takes', () => {
    const keys = STARTER_ITEMS.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const r of STARTER_RECIPES) {
      expect(r.prep_minutes, r.name).toBeLessThanOrEqual(30)
      for (const [item] of r.lines) expect(keys, `${r.name}: ${item}`).toContain(item)
    }
    const checked = checkInput(mealsDoc, starterDoc({ meals: 'groc', cleaning: 'clean', care: null }, 'EUR', 5, 2))
    expect(checked.ok ? checked.value.items.filter((i) => i.price_minor !== null) : checked.errors).toEqual([])
    const soap = checked.ok ? checked.value.items.find((i) => i.id === 'dish-soap') : undefined
    expect([soap?.category_id, soap?.mercadona_id]).toEqual(['clean', '42441'])
  })

  it('buys enough of a kept-in item for the week’s meals once they use a whole pack, even before it runs out', () => {
    // A 250 g bag: Saturday's adobo for 4 and Thursday's for 2 use 450 g, so two bags go on Saturday.
    const d = doc((x) => {
      x.items = x.items.map((i) => (i.id === 'rice' ? { ...i, pack_size: 250 } : i))
    })
    const rice = shoppingWeek(d, SETTINGS, '2026-10-24')[0]!.lines.find((l) => l.item.id === 'rice')!
    expect([rice.packs, rice.reasons]).toEqual([2, [{ kind: 'meals', first_day: '2026-10-24', recipes: ['Chicken adobo'] }]])
    expect(shoppingWeek(doc(), SETTINGS, '2026-10-24')[0]!.lines.some((l) => l.item.id === 'rice')).toBe(false)
  })

  it('takes a line not in stock out of the trip total, moves a kept-in one to the next trip, and names the meals that need a swap', () => {
    const d = doc((x) => {
      x.trips.push({ id: 't1', day: '2026-10-24' }, { id: 't2', day: '2026-10-28' })
      x.items = x.items.map((i) => (i.id === 'thighs' || i.id === 'soap' ? { ...i, unavailable_on: '2026-10-24' } : i))
    })
    const [sat, wed] = shoppingWeek(d, SETTINGS, '2026-10-24')
    const line = (t: typeof sat, id: string) => t!.lines.find((l) => l.item.id === id)
    expect([line(sat, 'thighs')?.unavailable, line(sat, 'soap')?.unavailable, line(sat, 'garlic')?.unavailable]).toEqual([true, true, false])
    // Saturday counts only the garlic; the soap goes on Wednesday too, and Wednesday's own thighs are another trip's.
    expect([sat!.cost_minor, sat!.unavailable, line(wed, 'soap')?.reasons.map((r) => r.kind), line(wed, 'thighs')?.unavailable]).toEqual([60, 2, ['runs_out'], false])
    expect(missingMeals(d, '2026-10-24').map((m) => [m.meal.day, m.recipe.name, m.trip, m.items.map((i) => i.id)])).toEqual([['2026-10-24', 'Chicken adobo', '2026-10-24', ['thighs']]])
    // Bought after all on that trip: nothing to swap.
    const found = doc((x) => {
      x.items = x.items.map((i) => (i.id === 'thighs' ? { ...i, unavailable_on: '2026-10-24' } : i))
      x.purchases.push({ id: 'p9', item_id: 'thighs', bought_on: '2026-10-24' })
    })
    expect(missingMeals(found, '2026-10-24')).toEqual([])
  })

  it('takes a line we still have at home off its trip and its total, for a recipe item, a kept-in item that ran out and an asked-for item, with no purchase', () => {
    const trips = (x: Required<MealsDocInput>) => x.trips.push({ id: 't1', day: '2026-10-24' }, { id: 't2', day: '2026-10-28' })
    const before = doc(trips)
    const home: Record<string, string> = { thighs: '2026-10-24', soap: '2026-10-24', eggs: '2026-10-28' }
    const d = doc((x) => {
      trips(x)
      x.items = x.items.map((i) => ({ ...i, at_home_on: home[i.id] ?? null }))
    })
    const [sat, wed] = shoppingWeek(d, SETTINGS, '2026-10-24')
    const line = (t: typeof sat, id: string) => t!.lines.find((l) => l.item.id === id)
    expect([line(sat, 'thighs')?.at_home, line(sat, 'soap')?.at_home, line(sat, 'garlic')?.at_home, line(wed, 'eggs')?.at_home, line(wed, 'thighs')?.at_home]).toEqual([true, true, false, true, false])
    // Saturday counts only the garlic; Wednesday drops the unpriced eggs, and the soap is not carried there.
    expect([sat!.totals, sat!.at_home, sat!.bought]).toEqual([[{ category_id: 'food', cost_minor: 60, missing: 0 }], 2, 0])
    expect([wed!.cost_minor, wed!.missing, wed!.at_home, line(wed, 'soap')]).toEqual([419, 0, 1, undefined])
    // Nothing was bought, so the run-out forecast and the swaps stay as they were.
    expect(d.purchases).toEqual(before.purchases)
    expect(forecast(d, d.items.find((i) => i.id === 'soap')!, '2026-10-31')).toEqual(forecast(before, before.items.find((i) => i.id === 'soap')!, '2026-10-31'))
    expect(missingMeals(d, '2026-10-24')).toEqual([])
    // Bought on that trip after all: the purchase wins.
    const bought = doc((x) => {
      trips(x)
      x.items = x.items.map((i) => (i.id === 'thighs' ? { ...i, at_home_on: '2026-10-24' } : i))
      x.purchases.push({ id: 'p9', item_id: 'thighs', bought_on: '2026-10-24' })
    })
    expect(line(shoppingWeek(bought, SETTINGS, '2026-10-24')[0], 'thighs')?.at_home).toBe(false)
  })
})
