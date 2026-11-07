import { addDays, expandPlan, monthKey, type Snapshot } from '@waypoint/core'
import {
  forecast,
  inBudgetCurrency,
  MERCADONA_ID,
  priceAge,
  PRICE_STALE_DAYS,
  shoppingWeek,
  weekBudget,
  weekPlan,
  weekStartOf,
  type DayPlan,
  type Item,
  type LineReason,
  type MealsDoc,
  type MealSettings,
  type ShopLine,
  type TripList,
  type Unit,
} from '@waypoint/core/meals'

// Spec, meals v1: the week of meals, its shopping against the meals allowance, and the words each screen and the printout use.

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

// ?week= names any day of a week; the page shows the week that holds it, this week without one.
export function weekFromParam(param: unknown, asOf: string, shopWeekday: number): string {
  return weekStartOf(isDay(param) ? param : asOf, shopWeekday)
}

// The recipe ids cooked in the week before the one that holds day, which the planner keeps out.
export function cookedWeekBefore(doc: MealsDoc, day: string, shopWeekday: number): Set<string> {
  const start = weekStartOf(day, shopWeekday)
  return new Set(doc.meals.filter((m) => m.day >= addDays(start, -7) && m.day < start).map((m) => m.recipe_id))
}

export function dayName(day: string, locale: string, style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(locale, { weekday: style, day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}

export function weekRange(start: string, locale: string): string {
  const day = (d: string) => new Date(`${d}T00:00:00Z`)
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).formatRange(day(start), day(addDays(start, 6)))
}

const number = (q: number, locale: string) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(q)

// 300 g, 1.5 kg, 250 ml, 1.5 l, or a bare count.
export function amountWords(q: number, unit: Unit, locale: string): string {
  if (unit === 'g') return q >= 1000 ? `${number(q / 1000, locale)} kg` : `${number(q, locale)} g`
  if (unit === 'ml') return q >= 1000 ? `${number(q / 1000, locale)} l` : `${number(q, locale)} ml`
  return number(q, locale)
}

// What one pack is, for a name: "Soy sauce, 250 ml".
export const packWords = (item: Item, locale: string) => (item.unit === 'unit' && item.pack_size === 1 ? item.name : `${item.name}, ${amountWords(item.pack_size, item.unit, locale)}`)

// An ingredient for a recipe line: "620 g chicken thighs", "2 × cucumber".
export function ingredientWords(item: Item, q: number, locale: string): string {
  return item.unit === 'unit' ? `${number(q, locale)} × ${item.name}` : `${amountWords(q, item.unit, locale)} ${item.name}`
}

// What to put in the trolley: whole packs, or the amount for an item sold loose.
export function buyWords(line: ShopLine, locale: string): string {
  if (line.item.loose) return `About ${amountWords(line.amount, line.item.unit, locale)} ${line.item.name}`
  return `${line.packs} × ${packWords(line.item, locale)}`
}

const SOURCE_WORDS = { typed: 'typed in', paid: 'price paid', mercadona: 'Mercadona online' } as const

export interface PriceWords {
  text: string
  // When and where alone, for a line that already shows the cost.
  checked: string
  stale: boolean
}

// "€1.20 a pack · checked 21 Oct, Mercadona online", or that it has no price yet; stale after 30 days.
export function priceWords(item: Item, asOf: string, money: (minor: number) => string, locale: string): PriceWords {
  if (item.price_minor === null || item.price_checked_on === null || item.price_source === null) return { text: 'No price yet', checked: 'No price yet', stale: false }
  const age = priceAge(item, asOf) ?? 0
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${item.price_checked_on}T00:00:00Z`))
  const per = item.loose ? `a ${amountWords(item.pack_size, item.unit, locale)}` : 'a pack'
  const checked = `checked ${day}, ${SOURCE_WORDS[item.price_source]}`
  return { text: `${money(item.price_minor)} ${per} · ${checked}`, checked, stale: age > PRICE_STALE_DAYS }
}

export function reasonWords(reason: LineReason, locale: string): string {
  const day = (d: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))
  if (reason.kind === 'meals') return `For ${reason.recipes.join(', ')}`
  if (reason.kind === 'runs_out') return reason.late ? `May have run out ${day(reason.day)}` : `Runs out about ${day(reason.day)}`
  return 'Added by you'
}

// The number in a Mercadona product link, or the number itself; null for anything else.
export function mercadonaIdFrom(text: string): string | null {
  const t = text.trim()
  const linked = /tienda\.mercadona\.es\/product\/([0-9.]+)/.exec(t)?.[1] ?? t
  return MERCADONA_ID.test(linked) ? linked : null
}

export const mercadonaLink = (id: string) => `https://tienda.mercadona.es/product/${id}`

export interface BudgetLine {
  currency: string
  budget_minor: number
  // The week's shopping counted against the meals allowance, in its currency; approx when a rate converted it.
  cost_minor: number
  over_minor: number
  approx: boolean
}

export interface MonthLine {
  month: string
  currency: string
  budget_minor: number
  spent_minor: number
  // This week's lines not bought yet, not out of stock and not at home, on trips from today to the month's end.
  planned_minor: number
  left_minor: number
}

export interface WeekView {
  start: string
  days: readonly DayPlan[]
  trips: readonly TripList[]
  budget: BudgetLine | null
  month: MonthLine | null
  // Lines with no price, which the totals leave out.
  missing: number
  // The week's total per allowance other than the meals one.
  others: readonly { category_id: string | null; cost_minor: number; missing: number }[]
}

// The week's plan, its trips and how its shopping sits against the meals allowance this week and this month.
export function weekView(snapshot: Snapshot, doc: MealsDoc, settings: MealSettings, start: string): WeekView {
  const trips = shoppingWeek(doc, settings, start)
  const days = weekPlan(doc, settings, start)
  const category = settings.category_id
  let meals = 0
  let missing = 0
  const others = new Map<string | null, { category_id: string | null; cost_minor: number; missing: number }>()
  for (const t of trips) {
    for (const total of t.totals) {
      missing += total.missing
      if (total.category_id === category) meals += total.cost_minor
      else {
        const o = others.get(total.category_id) ?? { category_id: total.category_id, cost_minor: 0, missing: 0 }
        o.cost_minor += total.cost_minor
        o.missing += total.missing
        others.set(total.category_id, o)
      }
    }
  }
  const allowance = category ? weekBudget(snapshot, category, start) : null
  const cost = allowance ? inBudgetCurrency(snapshot, meals, settings.currency, allowance.currency) : null
  const budget = allowance && cost !== null ? { currency: allowance.currency, budget_minor: allowance.budget_minor, cost_minor: cost, over_minor: Math.max(0, cost - allowance.budget_minor), approx: allowance.currency !== settings.currency } : null
  return { start, days, trips, budget, month: category ? monthLine(snapshot, category, settings, trips) : null, missing, others: [...others.values()] }
}

function monthLine(snapshot: Snapshot, category: string, settings: MealSettings, trips: readonly TripList[]): MonthLine | null {
  const month = monthKey(snapshot.as_of)
  const b = expandPlan(snapshot).budgets.find((x) => x.category_id === category && x.month === month)
  if (!b) return null
  let planned = 0
  for (const t of trips) {
    if (t.day < snapshot.as_of || monthKey(t.day) !== month) continue
    for (const l of t.lines) if (!l.bought && !l.unavailable && !l.at_home && l.category_id === category && l.cost_minor !== null) planned += l.cost_minor
  }
  const inBudget = inBudgetCurrency(snapshot, planned, settings.currency, b.currency) ?? 0
  return { month, currency: b.currency, budget_minor: b.budget_minor, spent_minor: b.spent_minor, planned_minor: inBudget, left_minor: b.budget_minor - b.spent_minor - inBudget }
}

export interface ItemRowView {
  item: Item
  price: PriceWords
  // For a kept-in item: when it runs out, from its purchases so far.
  runs_out: string | null
  last_bought: string | null
}

// The price list by aisle, archived items last in their own group.
export function priceList(doc: MealsDoc, asOf: string, money: (minor: number) => string, locale: string): { aisle: string; rows: ItemRowView[] }[] {
  const groups = new Map<string, ItemRowView[]>()
  const sorted = [...doc.items].sort((a, b) => a.name.localeCompare(b.name, locale))
  for (const item of sorted) {
    const aisle = item.archived_at !== null ? 'Archived' : (item.aisle ?? 'No aisle')
    const f = item.kind === 'stock' ? forecast(doc, item, addDays(asOf, 1)) : null
    const rows = groups.get(aisle) ?? []
    rows.push({ item, price: priceWords(item, asOf, money, locale), runs_out: f?.runs_out ?? null, last_bought: f?.last?.bought_on ?? null })
    groups.set(aisle, rows)
  }
  const order = (a: string) => (a === 'Archived' ? 2 : a === 'No aisle' ? 1 : 0)
  return [...groups].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b, locale)).map(([aisle, rows]) => ({ aisle, rows }))
}

// Lines of a trip by aisle, in the order the list sorts them.
export function byAisle(lines: readonly ShopLine[]): { aisle: string; lines: ShopLine[] }[] {
  const out: { aisle: string; lines: ShopLine[] }[] = []
  for (const l of lines) {
    const aisle = l.item.aisle ?? 'Other'
    const last = out.at(-1)
    if (last?.aisle === aisle) last.lines.push(l)
    else out.push({ aisle, lines: [l] })
  }
  return out
}

// The household's categories a meals line can count against: active ones, the meals allowance first.
export function categoryChoices(snapshot: Snapshot, mealsCategory: string | null): { value: string; title: string }[] {
  return snapshot.doc.categories
    .filter((c) => c.archived_at === null)
    .sort((a, b) => (a.id === mealsCategory ? -1 : b.id === mealsCategory ? 1 : a.name.localeCompare(b.name)))
    .map((c) => ({ value: c.id, title: c.name }))
}

// The starter pack's allowances: the household's own cleaning and personal care categories, matched by name.
export function starterCategories(snapshot: Snapshot, meals: string | null): { meals: string | null; cleaning: string | null; care: string | null } {
  const active = snapshot.doc.categories.filter((c) => c.archived_at === null)
  const find = (re: RegExp) => active.find((c) => re.test(c.name))?.id ?? null
  return { meals, cleaning: find(/clean|laundry/i), care: find(/personal care|toiletr/i) }
}
