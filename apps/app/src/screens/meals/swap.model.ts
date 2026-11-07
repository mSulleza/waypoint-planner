import { cookCost, costOf, mealsIndex, portionsOf, type Item, type Meal, type MealsDoc, type MealSettings, type Recipe, type RecipeItem } from '@waypoint/core/meals'
import type { MealFix } from '@/ai/meals-swap'

// A DeepSeek fix for one meal, priced by core: what the meal costs cooked that way, against the plan.

export interface PricedFix {
  fix: MealFix
  title: string
  cost_minor: number
  // Ingredients with no price, which the cost leaves out.
  missing: number
  // Against the meal as planned; null when either side has an unpriced ingredient.
  delta_minor: number | null
}

const scaled = (q: number, portions: number, recipe: Recipe) => (q * portions) / recipe.portions

// The recipe's lines with the missing item swapped for another, merged when the recipe already uses that item.
export function swappedLines(doc: MealsDoc, recipe: Recipe, missing: Item, withItem: string, quantity: number): { item_id: string; quantity: number }[] {
  const lines = mealsIndex(doc).lines.get(recipe.id) ?? []
  const out: { item_id: string; quantity: number }[] = []
  for (const l of lines) {
    const item_id = l.item_id === missing.id ? withItem : l.item_id
    const q = l.item_id === missing.id ? quantity : l.quantity
    const same = out.find((o) => o.item_id === item_id)
    if (same) same.quantity = Math.round((same.quantity + q) * 1000) / 1000
    else out.push({ item_id, quantity: q })
  }
  return out
}

export function priceFix(doc: MealsDoc, settings: MealSettings, meal: Meal, recipe: Recipe, missing: Item, fix: MealFix): PricedFix | null {
  const index = mealsIndex(doc)
  const portions = portionsOf(meal, settings.people)
  const before = cookCost(doc, recipe.id, portions)
  if (fix.type === 'recipe') {
    const other = index.recipes.get(fix.recipe_id)
    if (!other) return null
    const after = cookCost(doc, other.id, portions)
    return { fix, title: `Cook ${other.name} instead`, cost_minor: after.cost_minor, missing: after.missing, delta_minor: after.missing + before.missing === 0 ? after.cost_minor - before.cost_minor : null }
  }
  const withItem = index.items.get(fix.with_item_id)
  if (!withItem) return null
  let cost = 0
  let missingPrices = 0
  for (const l of swappedLines(doc, recipe, missing, withItem.id, fix.quantity)) {
    const item = index.items.get(l.item_id)
    const c = item ? costOf(item, scaled(l.quantity, portions, recipe)) : null
    if (c === null) missingPrices += 1
    else cost += c
  }
  return { fix, title: `Use ${withItem.name} instead of ${missing.name}`, cost_minor: cost, missing: missingPrices, delta_minor: missingPrices + before.missing === 0 ? cost - before.cost_minor : null }
}

// The copy of the recipe an ingredient fix saves, so the original recipe stays as it was.
export function variantRecipe(doc: MealsDoc, recipe: Recipe, missing: Item, fix: Extract<MealFix, { type: 'ingredient' }>, newId: () => string): { row: Recipe; lines: RecipeItem[] } {
  const withItem = mealsIndex(doc).items.get(fix.with_item_id)
  const id = newId()
  const swap = `Swap: ${withItem?.name ?? 'another item'} instead of ${missing.name}.${fix.note ? ` ${fix.note}` : ''}`
  const row: Recipe = { id, name: `${recipe.name} with ${withItem?.name ?? 'a swap'}`.slice(0, 60), portions: recipe.portions, prep_minutes: recipe.prep_minutes, steps: `${swap}\n${recipe.steps}`.slice(0, 4000), archived_at: null }
  const lines = swappedLines(doc, recipe, missing, fix.with_item_id, fix.quantity).map((l, i): RecipeItem => ({ id: newId(), recipe_id: id, item_id: l.item_id, quantity: l.quantity, sort_order: i }))
  return { row, lines }
}

export const AI_ERRORS: Readonly<Record<string, string>> = {
  not_enabled: 'The DeepSeek helper is on for some accounts only.',
  signed_out: 'Your session has ended. Sign in again.',
  no_item: 'That item is no longer in your price list.',
  deepseek_timeout: 'DeepSeek took too long to answer. Try again.',
  deepseek_empty: 'DeepSeek sent an empty answer. Try again.',
}

export const aiErrorWords = (code: string) => AI_ERRORS[code] ?? 'DeepSeek could not answer just now. Try again in a moment.'
