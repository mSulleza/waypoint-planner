import type { Item, MealsDoc, Recipe } from '@waypoint/core/meals'
import { cookedLastWeek, PLAN_PROMPT, planPrompt, readPlan, readPlanRequest, type PlanAnswer, type PlanRequest } from './meals-plan'
import { askDeepSeek, caller, fail, type AiEnv, type Fail } from './deepseek'
import { MAX_RECIPES, readRecipes, RECIPES_PROMPT, recipesPrompt, type RecipesAnswer } from './meals-recipes'

export { allowed, DEEPSEEK_URL, DEFAULT_MODEL, readJson, type AiEnv, type Fail } from './deepseek'

// The server side of the meals helper: who may use it, what DeepSeek is told about an item a trip did not have, and which of its answers survive. Plain TypeScript with no imports at run time, so the Vercel function bundles nothing else; every amount the app shows is computed by core in the app, never here.

const NOTE_MAX = 140

export type AiRequest = { task: 'status' } | { task: 'swap'; item_id: string; trip: string } | { task: 'recipes'; count: number } | PlanRequest

// One way to deal with a missing item for one meal: cook it with another item, or cook another recipe.
export type MealFix = { type: 'ingredient'; with_item_id: string; quantity: number; note: string } | { type: 'recipe'; recipe_id: string; note: string }

export interface SwapAnswer {
  meals: { meal_id: string; options: MealFix[] }[]
  // For a kept-in item no meal needs: what to buy instead.
  buy: { item_id: string; packs: number; note: string }[]
}

export type AiReply = { enabled: boolean } | SwapAnswer | RecipesAnswer | PlanAnswer

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const text = (v: unknown, max = NOTE_MAX) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export function readRequest(body: unknown): AiRequest | null {
  const b = body as { task?: unknown; item_id?: unknown; trip?: unknown } | null
  if (b?.task === 'status') return { task: 'status' }
  if (b?.task === 'swap' && typeof b.item_id === 'string' && b.item_id !== '' && isDay(b.trip)) return { task: 'swap', item_id: b.item_id, trip: b.trip }
  const count = Number((b as { count?: unknown } | null)?.count)
  if (b?.task === 'recipes' && Number.isInteger(count) && count >= 1 && count <= MAX_RECIPES) return { task: 'recipes', count }
  if (b?.task === 'plan') return readPlanRequest(b as Record<string, unknown>)
  return null
}

export interface SwapContext {
  missing: Item
  trip: string
  meals: { meal_id: string; day: string; slot: string; recipe: Recipe; lines: { item: Item; quantity: number }[] }[]
  // What the shop has: every kept item but those not in stock on this trip.
  items: Item[]
  // Recipes it can cook instead: none cooked the week before.
  recipes: { recipe: Recipe; items: Item[] }[]
}

const tripOf = (trips: readonly string[], day: string) => [...trips].reverse().find((t) => t <= day) ?? trips[0]!

// The meals of the trip's week that the missing item was for, and what else there is to choose from.
export function swapContext(doc: MealsDoc, itemId: string, trip: string): SwapContext | null {
  const items = new Map(doc.items.map((i) => [i.id, i]))
  const missing = items.get(itemId)
  if (!missing) return null
  // The trip's week, from the shopping weekday, and its trips as core counts them: the saved ones, or the week's first day.
  const weekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7
  const start = addDaysText(trip, -((weekday(trip) - (doc.settings?.shop_weekday ?? 5) + 7) % 7))
  const end = addDaysText(start, 6)
  const saved = [...new Set(doc.trips.map((t) => t.day).filter((d) => d >= start && d <= end))].sort()
  const trips = saved.length > 0 ? saved : [start]
  const lines = (recipeId: string) => doc.recipe_items.filter((l) => l.recipe_id === recipeId).sort((a, b) => a.sort_order - b.sort_order)
  const out = (i: Item) => i.unavailable_on === trip
  const meals: SwapContext['meals'] = []
  for (const m of doc.meals) {
    if (m.day < start || m.day > end || tripOf(trips, m.day) !== trip) continue
    const recipe = doc.recipes.find((r) => r.id === m.recipe_id)
    if (!recipe || !lines(recipe.id).some((l) => l.item_id === itemId)) continue
    meals.push({ meal_id: m.id, day: m.day, slot: m.slot, recipe, lines: lines(recipe.id).flatMap((l) => (items.get(l.item_id) ? [{ item: items.get(l.item_id)!, quantity: l.quantity }] : [])) })
  }
  const kept = doc.items.filter((i) => i.archived_at === null && !out(i))
  const last = cookedLastWeek(doc, start)
  const recipes = doc.recipes
    .filter((r) => r.archived_at === null && !last.has(r.id))
    .map((recipe) => ({ recipe, items: lines(recipe.id).flatMap((l) => (items.get(l.item_id) ? [items.get(l.item_id)!] : [])) }))
    .filter((r) => !r.items.some(out))
  return { missing, trip, meals, items: kept, recipes }
}

function addDaysText(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const euros = (minor: number | null) => (minor === null ? null : Math.round(minor) / 100)

// The answer's shape, built rather than typed so no prompt line runs long.
const EXAMPLE = {
  meals: [
    {
      meal_id: '...',
      options: [
        { type: 'ingredient', with_item_id: '...', quantity: 500, note: '...' },
        { type: 'recipe', recipe_id: '...', note: '...' },
      ],
    },
  ],
  buy: [{ item_id: '...', packs: 1, note: '...' }],
}

export const SYSTEM_PROMPT = [
  'You help one household plan its cooking. They are a couple who cook quick Asian food, once at lunch, and eat the same for dinner.',
  'An item was not in stock at the shop. For each meal that needed it, give one or two fixes, best first:',
  'either cook the same recipe with another item from the shop list (type "ingredient", with the quantity for the recipe as written, in that item\'s unit),',
  'or cook another recipe from the recipe list (type "recipe").',
  'If no meal needs the item, say what to buy instead under "buy", from the shop list only.',
  'Use only ids from the lists. Prefer what keeps the dish close to the original, then what costs less. Keep each note under 100 characters.',
  `Reply with json only, shaped like: ${JSON.stringify(EXAMPLE)}`,
].join(' ')

// What DeepSeek reads: names, units, pack sizes and prices from the household's own price list, never anything else of the household.
export function swapPrompt(ctx: SwapContext): string {
  return JSON.stringify({
    missing: { id: ctx.missing.id, name: ctx.missing.name, unit: ctx.missing.unit },
    meals: ctx.meals.map((m) => ({ meal_id: m.meal_id, day: m.day, recipe: m.recipe.name, ingredients: m.lines.map((l) => ({ id: l.item.id, name: l.item.name, quantity: l.quantity, unit: l.item.unit })) })),
    shop_list: ctx.items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, pack_size: i.pack_size, price_eur: euros(i.price_minor), kind: i.kind })),
    recipes: ctx.recipes.map((r) => ({ id: r.recipe.id, name: r.recipe.name, minutes: r.recipe.prep_minutes, ingredients: r.items.map((i) => i.name) })),
  })
}

// DeepSeek's answer with every id checked against the context: a fix that names an item or recipe it does not have, or the missing item itself, is dropped.
export function readAnswer(raw: unknown, ctx: SwapContext): SwapAnswer {
  const a = raw as { meals?: unknown; buy?: unknown } | null
  const shop = new Map(ctx.items.map((i) => [i.id, i]))
  const recipes = new Map(ctx.recipes.map((r) => [r.recipe.id, r]))
  const meals: SwapAnswer['meals'] = []
  for (const m of Array.isArray(a?.meals) ? a.meals : []) {
    const meal = ctx.meals.find((x) => x.meal_id === (m as { meal_id?: unknown }).meal_id)
    if (!meal) continue
    const options: MealFix[] = []
    for (const o of Array.isArray((m as { options?: unknown }).options) ? ((m as { options: unknown[] }).options) : []) {
      const f = o as Record<string, unknown>
      if (f.type === 'ingredient' && typeof f.with_item_id === 'string' && shop.has(f.with_item_id) && f.with_item_id !== ctx.missing.id) {
        const q = Number(f.quantity)
        if (Number.isFinite(q) && q > 0 && q < 100_000) options.push({ type: 'ingredient', with_item_id: f.with_item_id, quantity: Math.round(q * 1000) / 1000, note: text(f.note) })
      } else if (f.type === 'recipe' && typeof f.recipe_id === 'string' && recipes.has(f.recipe_id) && f.recipe_id !== meal.recipe.id) {
        options.push({ type: 'recipe', recipe_id: f.recipe_id, note: text(f.note) })
      }
      if (options.length === 3) break
    }
    if (options.length > 0) meals.push({ meal_id: meal.meal_id, options })
  }
  const buy: SwapAnswer['buy'] = []
  for (const b of Array.isArray(a?.buy) ? a.buy : []) {
    const r = b as Record<string, unknown>
    const packs = Math.round(Number(r.packs))
    if (typeof r.item_id === 'string' && shop.has(r.item_id) && r.item_id !== ctx.missing.id && packs >= 1 && packs <= 20) buy.push({ item_id: r.item_id, packs, note: text(r.note) })
    if (buy.length === 3) break
  }
  return { meals, buy }
}

// The whole request: the signed-in user from their own token, the allow list, their meals read with their own rights, one DeepSeek call, then the checked answer.
export async function handle(body: unknown, token: string | null, env: AiEnv, fetchFn: typeof fetch): Promise<AiReply | Fail> {
  const req = readRequest(body)
  if (!req) return fail(400, 'bad_request')
  const who = await caller(env, token, fetchFn)
  if ('error' in who) return who
  if (req.task === 'status') return { enabled: who.enabled }
  if (!who.enabled) return fail(403, 'not_enabled')
  const read = await fetchFn(new URL('rest/v1/rpc/export_meals', `${env.supabase_url}/`).href, { method: 'POST', headers: { ...who.headers, 'Content-Type': 'application/json', 'Content-Profile': 'waypoint', 'Accept-Profile': 'waypoint' }, body: '{}' })
  if (!read.ok) return fail(502, 'read_failed')
  const doc = (await read.json()) as MealsDoc | null
  if (!doc) return fail(404, 'no_household')
  if (req.task === 'plan') {
    const out = await askDeepSeek(env, fetchFn, PLAN_PROMPT, planPrompt(doc, req), 3000)
    return 'error' in out ? out : readPlan(out.json, doc, req)
  }
  if (req.task === 'recipes') {
    const out = await askDeepSeek(env, fetchFn, RECIPES_PROMPT, recipesPrompt(doc, req.count), 8000)
    return 'error' in out ? out : readRecipes(out.json, doc, req.count)
  }
  const ctx = swapContext(doc, req.item_id, req.trip)
  if (!ctx) return fail(404, 'no_item')
  const out = await askDeepSeek(env, fetchFn, SYSTEM_PROMPT, swapPrompt(ctx), 1500)
  return 'error' in out ? out : readAnswer(out.json, ctx)
}
