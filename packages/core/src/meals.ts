import { z } from 'zod'
import { addDays, daysBetween, daysInMonth, monthKey } from './dates'
import { expandPlan } from './engine/events'
import { convert } from './money'
import { weekday } from './pace'
import { toRatesPerEur } from './rates'
import { currencyCode, docId, flagDuplicateIds, isoDay, minorUnits, strictKeys, timestamp } from './schema/common'
import type { Snapshot } from './snapshot'

// Meals: a price list, recipes, a week of cooking from the shopping day, the shopping list per trip and when kept-in items run out.

export const ITEM_KINDS = ['recipe', 'stock'] as const
export const UNITS = ['g', 'ml', 'unit'] as const
export const PRICE_SOURCES = ['typed', 'paid', 'mercadona'] as const
export const SLOTS = ['lunch', 'dinner'] as const
export const MERCADONA_ID = /^[0-9]{1,12}(\.[0-9]{1,4})?$/

export type ItemKind = (typeof ITEM_KINDS)[number]
export type Unit = (typeof UNITS)[number]
export type PriceSource = (typeof PRICE_SOURCES)[number]
export type Slot = (typeof SLOTS)[number]

// numeric(10, 3) in the database.
const quantity = z.number('must be a number').positive('must be above 0').max(9_999_999, 'must be below 10,000,000')
const name = (max: number) => z.string().min(1, 'must not be empty').max(max, `must be at most ${max} characters`)

export const mealSettingsRow = strictKeys({
  category_id: docId.nullable().default(null),
  currency: currencyCode,
  shop_weekday: z.int().min(0).max(6).default(5),
  people: z.int().min(1).max(12).default(2),
})

export const itemRow = strictKeys({
  id: docId,
  name: name(60),
  kind: z.enum(ITEM_KINDS),
  unit: z.enum(UNITS),
  pack_size: quantity,
  loose: z.boolean().default(false),
  price_minor: minorUnits.positive('must be above 0').nullable().default(null),
  price_checked_on: isoDay.nullable().default(null),
  price_source: z.enum(PRICE_SOURCES).nullable().default(null),
  mercadona_id: z.string().regex(MERCADONA_ID, 'must be the number in a Mercadona product link').nullable().default(null),
  aisle: name(40).nullable().default(null),
  category_id: docId.nullable().default(null),
  lasts_days: z.int().min(1).max(730).nullable().default(null),
  wanted_on: isoDay.nullable().default(null),
  // The trip it was not in stock on; meals that trip buys for need a swap.
  unavailable_on: isoDay.nullable().default(null),
  // The trip it was still at home for: off that list, with no purchase recorded.
  at_home_on: isoDay.nullable().default(null),
  archived_at: timestamp.nullable().default(null),
}).refine((i) => [i.price_minor, i.price_checked_on, i.price_source].every((v) => v === null) || [i.price_minor, i.price_checked_on, i.price_source].every((v) => v !== null), {
  message: 'a price comes with the day it was checked and where it came from',
  path: ['price_minor'],
})

export const purchaseRow = strictKeys({
  id: docId,
  item_id: docId,
  bought_on: isoDay,
  packs: z.int().min(1).max(99).default(1),
  price_minor: minorUnits.positive('must be above 0').nullable().default(null),
})

export const recipeRow = strictKeys({
  id: docId,
  name: name(60),
  portions: z.int().min(1).max(24),
  prep_minutes: z.int().min(1).max(600),
  steps: z.string().max(4000, 'must be at most 4,000 characters').default(''),
  archived_at: timestamp.nullable().default(null),
})

export const recipeItemRow = strictKeys({ id: docId, recipe_id: docId, item_id: docId, quantity, sort_order: z.int().default(0) })

export const mealRow = strictKeys({ id: docId, day: isoDay, slot: z.enum(SLOTS), recipe_id: docId, leftovers: z.boolean().default(false) }).refine((m) => !m.leftovers || m.slot === 'lunch', {
  message: 'only a lunch is cooked for dinner too',
  path: ['leftovers'],
})

export const tripRow = strictKeys({ id: docId, day: isoDay })

// export_meals' answer, which import_household's 'meals' key takes back.
export const mealsDoc = strictKeys({
  settings: mealSettingsRow.nullable().default(null),
  items: z.array(itemRow).default([]),
  purchases: z.array(purchaseRow).default([]),
  recipes: z.array(recipeRow).default([]),
  recipe_items: z.array(recipeItemRow).default([]),
  meals: z.array(mealRow).default([]),
  trips: z.array(tripRow).default([]),
}).superRefine((doc, ctx) => {
  for (const table of ['items', 'purchases', 'recipes', 'recipe_items', 'meals', 'trips'] as const) flagDuplicateIds(doc[table], table, ctx)
  const items = new Set(doc.items.map((i) => i.id))
  const recipes = new Set(doc.recipes.map((r) => r.id))
  const missing = (table: string, i: number, field: string, id: string) => ctx.addIssue({ code: 'custom', message: `no ${field.replace('_id', '')} '${id}' in the document`, path: [table, i, field] })
  doc.purchases.forEach((p, i) => items.has(p.item_id) || missing('purchases', i, 'item_id', p.item_id))
  doc.recipe_items.forEach((l, i) => {
    if (!recipes.has(l.recipe_id)) missing('recipe_items', i, 'recipe_id', l.recipe_id)
    if (!items.has(l.item_id)) missing('recipe_items', i, 'item_id', l.item_id)
  })
  doc.meals.forEach((m, i) => recipes.has(m.recipe_id) || missing('meals', i, 'recipe_id', m.recipe_id))
})

export type MealSettings = z.output<typeof mealSettingsRow>
export type Item = z.output<typeof itemRow>
export type Purchase = z.output<typeof purchaseRow>
export type Recipe = z.output<typeof recipeRow>
export type RecipeItem = z.output<typeof recipeItemRow>
export type Meal = z.output<typeof mealRow>
export type Trip = z.output<typeof tripRow>
export type MealsDoc = z.output<typeof mealsDoc>
export type MealsDocInput = z.input<typeof mealsDoc>

export const DEFAULT_SHOP_WEEKDAY = 5
export const DEFAULT_PEOPLE = 2
// A price older than this reads as one to check again.
export const PRICE_STALE_DAYS = 30
// The forecast reads at most this many gaps between purchases, the latest first.
export const FORECAST_GAPS = 5

// The settings a household without a row works with: its base currency, Saturday, two people and its Groceries allowance when it has one.
export function settingsOf(doc: MealsDoc, snapshot: Snapshot): MealSettings {
  if (doc.settings) return doc.settings
  const groceries = snapshot.doc.categories.find((c) => c.archived_at === null && c.name.trim().toLowerCase() === 'groceries')
  return { category_id: groceries?.id ?? null, currency: snapshot.doc.household.base_currency, shop_weekday: DEFAULT_SHOP_WEEKDAY, people: DEFAULT_PEOPLE }
}

// Quantities in thousandths, so 0.5 of an onion and 1.25 kg add up without float drift.
export const milli = (q: number) => Math.round(q * 1000)

// a × b ÷ c, rounded half up, in BigInt so a large quantity times a price never loses a cent.
function mulDivRound(a: number, b: number, c: number): number {
  if (c <= 0) throw new RangeError(`Divisor must be above 0: ${c}`)
  return Number((2n * BigInt(a) * BigInt(b) + BigInt(c)) / (2n * BigInt(c)))
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b)

// The price of a quantity at the item's pack price; null without a price.
export function costOf(item: Item, q: number): number | null {
  return item.price_minor === null ? null : mulDivRound(item.price_minor, milli(q), milli(item.pack_size))
}

export function priceAge(item: Item, asOf: string): number | null {
  return item.price_checked_on === null ? null : daysBetween(item.price_checked_on, asOf)
}

// The first day of the week of meals that holds day: the shopping weekday on or before it.
export function weekStartOf(day: string, shopWeekday: number): string {
  return addDays(day, -((weekday(day) - shopWeekday + 7) % 7))
}

export const weekDays = (start: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(start, i))

export const portionsOf = (meal: Meal, people: number) => people * (meal.leftovers ? 2 : 1)

export interface MealsIndex {
  items: ReadonlyMap<string, Item>
  recipes: ReadonlyMap<string, Recipe>
  lines: ReadonlyMap<string, readonly RecipeItem[]>
  purchases: ReadonlyMap<string, readonly Purchase[]>
}

const indexes = new WeakMap<MealsDoc, MealsIndex>()

// Rows by id, each recipe's lines in order and each item's purchases oldest first, once per document.
export function mealsIndex(doc: MealsDoc): MealsIndex {
  const cached = indexes.get(doc)
  if (cached) return cached
  const lines = new Map<string, RecipeItem[]>()
  for (const l of doc.recipe_items) lines.set(l.recipe_id, [...(lines.get(l.recipe_id) ?? []), l])
  for (const list of lines.values()) list.sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1))
  const purchases = new Map<string, Purchase[]>()
  for (const p of doc.purchases) purchases.set(p.item_id, [...(purchases.get(p.item_id) ?? []), p])
  for (const list of purchases.values()) list.sort((a, b) => (a.bought_on < b.bought_on ? -1 : a.bought_on > b.bought_on ? 1 : 0))
  const index: MealsIndex = { items: new Map(doc.items.map((i) => [i.id, i])), recipes: new Map(doc.recipes.map((r) => [r.id, r])), lines, purchases }
  indexes.set(doc, index)
  return index
}

export interface Ingredient {
  item: Item
  // For the portions asked, in the item's unit.
  quantity: number
  cost_minor: number | null
}

export interface CookCost {
  portions: number
  ingredients: readonly Ingredient[]
  // What the cooking uses, at pack prices; ingredients with no price are left out and counted.
  cost_minor: number
  per_portion_minor: number
  missing: number
}

// A recipe's ingredients and cost for a number of portions.
export function cookCost(doc: MealsDoc, recipeId: string, portions: number): CookCost {
  const index = mealsIndex(doc)
  const recipe = index.recipes.get(recipeId)
  const ingredients: Ingredient[] = []
  let cost = 0
  let missing = 0
  for (const l of index.lines.get(recipeId) ?? []) {
    const item = index.items.get(l.item_id)
    if (!item || !recipe) continue
    const q = mulDivRound(milli(l.quantity), portions, recipe.portions) / 1000
    const c = costOf(item, q)
    if (c === null) missing += 1
    else cost += c
    ingredients.push({ item, quantity: q, cost_minor: c })
  }
  return { portions, ingredients, cost_minor: cost, per_portion_minor: portions > 0 ? mulDivRound(cost, 1, portions) : 0, missing }
}

export interface Forecast {
  last: Purchase | null
  // Days one pack lasts: learned from the gaps between purchases, else the item's own guess.
  lasts_days: number | null
  learned: boolean
  runs_out: string | null
}

// When a kept-in item runs out, from purchases before a day: the last purchase plus its packs times the days a pack lasts.
export function forecast(doc: MealsDoc, item: Item, before: string): Forecast {
  const bought = (mealsIndex(doc).purchases.get(item.id) ?? []).filter((p) => p.bought_on < before)
  const gaps: number[] = []
  for (let i = bought.length - 1; i > 0 && gaps.length < FORECAST_GAPS; i--) {
    const [prev, next] = [bought[i - 1], bought[i]]
    if (prev && next) gaps.push(daysBetween(prev.bought_on, next.bought_on) / prev.packs)
  }
  const sorted = gaps.sort((a, b) => a - b)
  const mid = sorted.length / 2
  const median = sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  const learned = median !== null ? Math.max(1, Math.round(median)) : null
  const lasts = learned ?? item.lasts_days
  const last = bought.at(-1) ?? null
  return { last, lasts_days: lasts, learned: learned !== null, runs_out: last && lasts !== null ? addDays(last.bought_on, lasts * last.packs) : null }
}

// The week's trips: the ones saved in it, or its first day.
export function weekTrips(doc: MealsDoc, start: string): string[] {
  const end = addDays(start, 6)
  const saved = [...new Set(doc.trips.map((t) => t.day).filter((d) => d >= start && d <= end))].sort()
  return saved.length > 0 ? saved : [start]
}

export type LineReason =
  | { kind: 'meals'; first_day: string; recipes: readonly string[] }
  // late: it runs out before the first trip that can buy it.
  | { kind: 'runs_out'; day: string; late: boolean }
  | { kind: 'wanted'; since: string }

export interface ShopLine {
  item: Item
  trip: string
  // Whole packs; a loose item is bought by the amount, so packs is 1 and amount is what to weigh out.
  packs: number
  amount: number
  cost_minor: number | null
  // Counted against this allowance: the item's own category, else the meals one.
  category_id: string | null
  reasons: readonly LineReason[]
  bought: Purchase | null
  // Not in stock on this trip: out of the totals, and a kept-in item moves to the trip after.
  unavailable: boolean
  // Still at home: out of the totals, and not carried to another trip.
  at_home: boolean
}

export interface TripList {
  day: string
  lines: readonly ShopLine[]
  // Each allowance's total, the lines with no price left out and counted.
  totals: readonly { category_id: string | null; cost_minor: number; missing: number }[]
  cost_minor: number
  missing: number
  bought: number
  unavailable: number
  at_home: number
}

interface Need {
  milli: number
  first_day: string
  recipes: Set<string>
}

// What the week's meals use, summed per trip and item for recipe items (each meal's on the last trip on or before its day), and per item for kept-in ones.
function recipeNeeds(doc: MealsDoc, start: string, people: number, tripFor: (day: string) => string): Map<string, Need & { trip: string; item: Item }> {
  const index = mealsIndex(doc)
  const end = addDays(start, 6)
  const needs = new Map<string, Need & { trip: string; item: Item }>()
  for (const meal of doc.meals) {
    if (meal.day < start || meal.day > end) continue
    const recipe = index.recipes.get(meal.recipe_id)
    if (!recipe) continue
    const trip = tripFor(meal.day)
    for (const l of index.lines.get(recipe.id) ?? []) {
      const item = index.items.get(l.item_id)
      if (!item) continue
      // A kept-in item's use is summed for the whole week, apart from the trips.
      const key = item.kind === 'recipe' ? `${trip}:${item.id}` : `stock:${item.id}`
      const need = needs.get(key) ?? { item, trip, milli: 0, first_day: meal.day, recipes: new Set<string>() }
      need.milli += mulDivRound(milli(l.quantity), portionsOf(meal, people), recipe.portions)
      if (meal.day < need.first_day) need.first_day = meal.day
      need.recipes.add(recipe.name)
      needs.set(key, need)
    }
  }
  return needs
}

const byAisle = (a: ShopLine, b: ShopLine) => {
  const [x, y] = [a.item.aisle ?? '￿', b.item.aisle ?? '￿']
  return x < y ? -1 : x > y ? 1 : a.item.name.localeCompare(b.item.name)
}

// The week's shopping, one list per trip: recipe items on the last trip on or before each meal that needs them, kept-in items on the last trip before they run out, and items asked for on the first trip from that day.
export function shoppingWeek(doc: MealsDoc, settings: MealSettings, start: string): TripList[] {
  const index = mealsIndex(doc)
  const trips = weekTrips(doc, start)
  const end = addDays(start, 6)
  const first = trips[0]!
  const tripFor = (day: string) => tripOf(trips, day)
  type Draft = { item: Item; trip: string; recipe: number; extra: number; reasons: LineReason[] }
  const drafts = new Map<string, Draft>()
  const draft = (item: Item, trip: string) => {
    const key = `${trip}:${item.id}`
    const d = drafts.get(key) ?? { item, trip, recipe: 0, extra: 0, reasons: [] }
    drafts.set(key, d)
    return d
  }
  const needs = recipeNeeds(doc, start, settings.people, tripFor)
  for (const need of needs.values()) {
    if (need.item.kind !== 'recipe') continue
    const { item } = need
    const d = draft(item, need.trip)
    d.recipe += item.loose ? need.milli : ceilDiv(need.milli, milli(item.pack_size))
    d.reasons.push({ kind: 'meals', first_day: need.first_day, recipes: [...need.recipes].sort() })
  }
  for (const item of doc.items) {
    if (item.archived_at !== null) continue
    const bought = index.purchases.get(item.id) ?? []
    if (item.kind === 'stock') {
      const f = forecast(doc, item, start)
      const due = f.runs_out !== null && f.runs_out <= end
      const use = needs.get(`stock:${item.id}`)
      // A week whose meals use a whole pack or more buys enough to cover them, so a week of rice dishes buys more than one bag.
      const forMeals = use && use.milli >= milli(item.pack_size) ? ceilDiv(use.milli, milli(item.pack_size)) : 0
      if (due || forMeals > 0) {
        const d = draft(item, due && f.runs_out !== null ? tripFor(f.runs_out) : tripFor(use?.first_day ?? first))
        const packs = Math.max(due ? (f.last?.packs ?? 1) : 0, forMeals)
        d.extra = Math.max(d.extra, item.loose ? milli(item.pack_size) * packs : packs)
        if (due && f.runs_out !== null) d.reasons.push({ kind: 'runs_out', day: f.runs_out, late: f.runs_out < first })
        if (use && forMeals > 0) d.reasons.push({ kind: 'meals', first_day: use.first_day, recipes: [...use.recipes].sort() })
      }
    }
    const since = item.wanted_on
    if (since !== null && since <= end && !bought.some((p) => p.bought_on >= since && p.bought_on < start)) {
      const trip = since < start ? first : trips.find((t) => t >= since)
      if (trip === undefined) continue
      const d = draft(item, trip)
      d.extra = Math.max(d.extra, item.loose ? milli(item.pack_size) : 1)
      d.reasons.push({ kind: 'wanted', since })
    }
  }
  // A kept-in or asked-for item that was not in stock goes on the week's next trip too.
  for (const d of [...drafts.values()]) {
    const next = trips.find((t) => t > d.trip)
    if (d.item.unavailable_on !== d.trip || d.extra === 0 || next === undefined) continue
    const carried = draft(d.item, next)
    carried.extra = Math.max(carried.extra, d.extra)
    carried.reasons.push(...d.reasons.filter((r) => r.kind !== 'meals'))
  }
  return trips.map((day) => {
    const lines: ShopLine[] = []
    for (const d of drafts.values()) {
      if (d.trip !== day) continue
      const { item } = d
      const bought = (index.purchases.get(item.id) ?? []).find((p) => p.bought_on === day) ?? null
      const packs = item.loose ? 1 : d.recipe + d.extra
      const amount = item.loose ? (d.recipe + d.extra) / 1000 : packs * item.pack_size
      const planned = item.loose ? costOf(item, amount) : item.price_minor === null ? null : packs * item.price_minor
      const cost = bought && bought.price_minor !== null ? bought.price_minor * bought.packs : planned
      lines.push({ item, trip: day, packs, amount, cost_minor: cost, category_id: item.category_id ?? settings.category_id, reasons: d.reasons, bought, unavailable: !bought && item.unavailable_on === day, at_home: !bought && item.at_home_on === day })
    }
    lines.sort(byAisle)
    const totals = new Map<string | null, { category_id: string | null; cost_minor: number; missing: number }>()
    for (const l of lines) {
      if (l.unavailable || l.at_home) continue
      const t = totals.get(l.category_id) ?? { category_id: l.category_id, cost_minor: 0, missing: 0 }
      if (l.cost_minor === null) t.missing += 1
      else t.cost_minor += l.cost_minor
      totals.set(l.category_id, t)
    }
    const all = [...totals.values()]
    return { day, lines, totals: all, cost_minor: all.reduce((s, t) => s + t.cost_minor, 0), missing: all.reduce((s, t) => s + t.missing, 0), bought: lines.filter((l) => l.bought).length, unavailable: lines.filter((l) => l.unavailable).length, at_home: lines.filter((l) => l.at_home).length }
  })
}

// The trip that buys for a day: the last one on or before it, else the week's first.
export function tripOf(trips: readonly string[], day: string): string {
  return [...trips].reverse().find((t) => t <= day) ?? trips[0]!
}

export interface MissingMeal {
  meal: Meal
  recipe: Recipe
  trip: string
  // Recipe items its trip did not have.
  items: readonly Item[]
}

// Meals whose trip did not have one of their recipe items, so they need a swap before that trip ends.
export function missingMeals(doc: MealsDoc, start: string): MissingMeal[] {
  const index = mealsIndex(doc)
  const trips = weekTrips(doc, start)
  const end = addDays(start, 6)
  const out: MissingMeal[] = []
  for (const meal of [...doc.meals].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.slot === 'lunch' ? -1 : 1))) {
    if (meal.day < start || meal.day > end) continue
    const recipe = index.recipes.get(meal.recipe_id)
    if (!recipe) continue
    const trip = tripOf(trips, meal.day)
    const bought = (id: string) => (index.purchases.get(id) ?? []).some((p) => p.bought_on === trip)
    const items = (index.lines.get(recipe.id) ?? []).map((l) => index.items.get(l.item_id)).filter((i): i is Item => i !== undefined && i.kind === 'recipe' && i.unavailable_on === trip && !bought(i.id))
    if (items.length > 0) out.push({ meal, recipe, trip, items })
  }
  return out
}

export interface Cook {
  meal: Meal
  recipe: Recipe
  cost: CookCost
}

export interface DayPlan {
  day: string
  lunch: Cook | null
  // 'leftovers' when lunch was cooked for dinner too.
  dinner: Cook | 'leftovers' | null
  trip: boolean
}

// Each day of the week: its lunch, its dinner or lunch's leftovers, and whether a trip falls on it.
export function weekPlan(doc: MealsDoc, settings: MealSettings, start: string): DayPlan[] {
  const index = mealsIndex(doc)
  const trips = new Set(weekTrips(doc, start))
  const cook = (meal: Meal | undefined): Cook | null => {
    const recipe = meal && index.recipes.get(meal.recipe_id)
    return meal && recipe ? { meal, recipe, cost: cookCost(doc, recipe.id, portionsOf(meal, settings.people)) } : null
  }
  return weekDays(start).map((day) => {
    const lunch = cook(doc.meals.find((m) => m.day === day && m.slot === 'lunch'))
    const dinner = lunch?.meal.leftovers ? 'leftovers' : cook(doc.meals.find((m) => m.day === day && m.slot === 'dinner'))
    return { day, lunch, dinner, trip: trips.has(day) }
  })
}

export interface WeekBudget {
  category_id: string
  currency: string
  // Each day's share of its month's allowance, summed: allowance × days in the week that fall in the month ÷ days in the month.
  budget_minor: number
}

// The week's share of an allowance; null when a day of it falls in a month with no allowance for the category (a past month, or none planned).
export function weekBudget(snapshot: Snapshot, categoryId: string, start: string): WeekBudget | null {
  const budgets = expandPlan(snapshot).budgets.filter((b) => b.category_id === categoryId)
  const days = new Map<string, number>()
  for (const day of weekDays(start)) days.set(monthKey(day), (days.get(monthKey(day)) ?? 0) + 1)
  let total = 0
  let currency: string | null = null
  for (const [month, n] of days) {
    const b = budgets.find((x) => x.month === month)
    if (!b || (currency !== null && b.currency !== currency)) return null
    currency = b.currency
    total += mulDivRound(b.budget_minor, n, daysInMonth(month))
  }
  return currency === null ? null : { category_id: categoryId, currency, budget_minor: total }
}

// An amount in the meals currency read in the allowance's currency, at today's rate when they differ; null without a rate.
export function inBudgetCurrency(snapshot: Snapshot, minor: number, from: string, to: string): number | null {
  return from === to ? minor : convert(minor, from, to, toRatesPerEur(snapshot.rates))
}
