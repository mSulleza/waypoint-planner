import type { Item, MealsDoc } from '@waypoint/core/meals'

// The weekly new recipes: what DeepSeek is asked for and which of its drafts survive. Plain TypeScript with no imports at run time, like meals-swap.

export const MAX_RECIPES = 4

export interface RecipeDraft {
  name: string
  portions: number
  prep_minutes: number
  steps: string
  lines: { item_id: string; quantity: number }[]
}

export interface RecipesAnswer {
  recipes: RecipeDraft[]
}

const EXAMPLE = {
  recipes: [
    {
      name: '...',
      prep_minutes: 20,
      steps: ['...', '...'],
      ingredients: [{ item_id: '...', quantity: 500 }],
    },
  ],
}

export const RECIPES_PROMPT = [
  'You write recipes for one household: a couple who cook quick Asian food once a day at lunch and eat the same for dinner.',
  'Write the number of new recipes asked for. Each serves 4 (lunch and dinner for two) and takes 30 minutes or less.',
  'Use only ingredients from the shop list, by id, with quantities for 4 portions in each item\'s unit.',
  'Each needs at least 3 ingredients and one main item of kind "recipe".',
  'Do not repeat or rename a recipe in the existing list; vary the main item and the cuisine (Filipino, Chinese, Japanese, Korean, Thai, Vietnamese).',
  'Steps: 3 to 5 short sentences. Prefer cheaper items when two would do.',
  `Reply with json only, shaped like: ${JSON.stringify(EXAMPLE)}`,
].join(' ')

const euros = (minor: number | null) => (minor === null ? null : Math.round(minor) / 100)

export function recipesPrompt(doc: MealsDoc, count: number): string {
  const kept = doc.items.filter((i) => i.archived_at === null)
  return JSON.stringify({
    recipes_wanted: count,
    existing_recipes: doc.recipes.map((r) => r.name),
    shop_list: kept.map((i) => ({ id: i.id, name: i.name, unit: i.unit, pack_size: i.pack_size, price_eur: euros(i.price_minor), kind: i.kind })),
  })
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

// Drafts with every ingredient on the household's list, a main recipe item, 30 minutes or less and a name not already used; at most `count`.
export function readRecipes(raw: unknown, doc: MealsDoc, count: number): RecipesAnswer {
  const items = new Map<string, Item>(doc.items.filter((i) => i.archived_at === null).map((i) => [i.id, i]))
  const taken = new Set(doc.recipes.map((r) => r.name.trim().toLowerCase()))
  const recipes: RecipeDraft[] = []
  for (const r of Array.isArray((raw as { recipes?: unknown } | null)?.recipes) ? (raw as { recipes: unknown[] }).recipes : []) {
    const d = r as Record<string, unknown>
    const name = clean(d.name, 60)
    const prep = Math.round(Number(d.prep_minutes))
    const steps = (Array.isArray(d.steps) ? d.steps : []).map((s) => clean(s, 200)).filter(Boolean).slice(0, 8)
    const lines: RecipeDraft['lines'] = []
    let bad = false
    for (const l of Array.isArray(d.ingredients) ? d.ingredients : []) {
      const x = l as Record<string, unknown>
      const q = Number(x.quantity)
      if (typeof x.item_id !== 'string' || !items.has(x.item_id) || !(q > 0 && q < 100_000) || lines.some((y) => y.item_id === x.item_id)) {
        bad = true
        break
      }
      lines.push({ item_id: x.item_id, quantity: Math.round(q * 1000) / 1000 })
    }
    const main = lines.some((l) => items.get(l.item_id)?.kind === 'recipe')
    if (bad || name.length < 3 || taken.has(name.toLowerCase()) || !(prep >= 5 && prep <= 30) || steps.length < 2 || lines.length < 3 || lines.length > 15 || !main) continue
    taken.add(name.toLowerCase())
    recipes.push({ name, portions: 4, prep_minutes: prep, steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n').slice(0, 4000), lines })
    if (recipes.length === count) break
  }
  return { recipes }
}
