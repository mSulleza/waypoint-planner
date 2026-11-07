import type { MealsDoc } from '@waypoint/core/meals'

// Plan this week: what DeepSeek is told and which days of its draft survive. The app sends the week's budget and each recipe's cost, both worked out by core; DeepSeek only chooses recipes, and the app prices the draft again before it is shown.

export const NOTE_MAX = 500

export interface PlanRequest {
  task: 'plan'
  // The week's first day, the shopping day.
  week: string
  // Plan the days with nothing planned yet, or the whole week.
  mode: 'empty' | 'all'
  note: string
  budget_minor: number | null
  currency: string
  // Recipe id to its cost as written (4 portions), in minor units.
  costs: Record<string, number>
}

export interface PlannedDay {
  day: string
  // Null when lunch is not cooked, such as lunch from the fridge; the day then cooks only its dinner.
  lunch_recipe_id: string | null
  // Lunch cooked for dinner too; false with a dinner recipe when the day cooks twice or only at dinner, or with none when dinner is not planned.
  leftovers: boolean
  dinner_recipe_id: string | null
}

export interface PlanAnswer {
  plan: PlannedDay[]
  note: string
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

export function readPlanRequest(b: Record<string, unknown>): PlanRequest | null {
  const costs = b.costs as Record<string, unknown> | undefined
  const budget = b.budget_minor
  if (!isDay(b.week) || (b.mode !== 'empty' && b.mode !== 'all') || typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency)) return null
  if (budget !== null && !(Number.isInteger(budget) && (budget as number) >= 0)) return null
  if (!costs || typeof costs !== 'object' || Object.keys(costs).length > 300 || !Object.values(costs).every((c) => Number.isInteger(c) && (c as number) >= 0)) return null
  return { task: 'plan', week: b.week, mode: b.mode, note: typeof b.note === 'string' ? b.note.trim().slice(0, NOTE_MAX) : '', budget_minor: budget as number | null, currency: b.currency, costs: costs as Record<string, number> }
}

export function addDaysText(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const weekdayName = (day: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))

// The recipe ids of the meals in the seven days before week, the week's first day.
export function cookedLastWeek(doc: MealsDoc, week: string): Set<string> {
  const from = addDaysText(week, -7)
  return new Set(doc.meals.filter((m) => m.day >= from && m.day < week).map((m) => m.recipe_id))
}

// The days DeepSeek may plan: all seven, or those with nothing planned yet.
export function daysToPlan(doc: MealsDoc, req: Pick<PlanRequest, 'week' | 'mode'>): string[] {
  const days = Array.from({ length: 7 }, (_, i) => addDaysText(req.week, i))
  return req.mode === 'all' ? days : days.filter((d) => !doc.meals.some((m) => m.day === d))
}

const EXAMPLE = {
  plan: [
    { day: 'YYYY-MM-DD', lunch_recipe_id: '...', leftovers: true, dinner_recipe_id: null },
    { day: 'YYYY-MM-DD', lunch_recipe_id: null, leftovers: false, dinner_recipe_id: '...' },
  ],
  note: '...',
}

export const PLAN_PROMPT = [
  'You plan a week of cooking for one household: a couple who cook quick Asian food.',
  'They usually cook once at lunch and eat the same for dinner: leftovers true and no dinner recipe.',
  'The note overrides that. A note that names only the dinner of a day, such as "add Saturday dinner", means no lunch is cooked:',
  'give that day lunch_recipe_id null, leftovers false and a dinner recipe.',
  'On a day the note says they cook twice, give a dinner recipe and leftovers false. Leave out a day the note says to skip.',
  'Plan only the days in days_to_plan, with recipe ids from the recipes list only.',
  'Keep the sum of cost_eur for every cooking within budget_eur when you can, and say so in the note when you cannot.',
  'Vary the main item from day to day.',
  'Never plan a recipe in cooked_last_week: they ate it the week before.',
  'Only when the other recipes cannot fill days_to_plan, reuse one from cooked_last_week and say so in the note.',
  'Follow the note: use up what it says is in the fridge early in the week.',
  `Reply with json only, shaped like: ${JSON.stringify(EXAMPLE)}`,
].join(' ')

const euros = (minor: number | null | undefined) => (minor === null || minor === undefined ? null : Math.round(minor) / 100)

export function planPrompt(doc: MealsDoc, req: PlanRequest): string {
  const items = new Map(doc.items.map((i) => [i.id, i]))
  const recipes = doc.recipes.filter((r) => r.archived_at === null)
  const name = (id: string) => recipes.find((r) => r.id === id)?.name ?? null
  const end = addDaysText(req.week, 6)
  const kept = req.mode === 'all' ? [] : doc.meals.filter((m) => m.day >= req.week && m.day <= end)
  return JSON.stringify({
    week: Array.from({ length: 7 }, (_, i) => ({ day: addDaysText(req.week, i), weekday: weekdayName(addDaysText(req.week, i)) })),
    days_to_plan: daysToPlan(doc, req),
    already_planned: kept.map((m) => ({ day: m.day, slot: m.slot, recipe: name(m.recipe_id), leftovers: m.leftovers })),
    cooked_last_week: [...cookedLastWeek(doc, req.week)].map(name).filter(Boolean),
    budget_eur: euros(req.budget_minor),
    note: req.note,
    recipes: recipes.map((r) => {
      const lines = doc.recipe_items.filter((l) => l.recipe_id === r.id).sort((a, b) => a.sort_order - b.sort_order)
      const main = lines.map((l) => items.get(l.item_id)).find((i) => i?.kind === 'recipe')
      return { id: r.id, name: r.name, minutes: r.prep_minutes, cost_eur: euros(req.costs[r.id]), main: main?.name ?? null, ingredients: lines.map((l) => items.get(l.item_id)?.name).filter(Boolean) }
    }),
  })
}

// The draft with every day one it may plan, once, and every recipe id a live recipe; a day that cooks for dinner too has no dinner recipe, and one with no lunch has a dinner.
// A recipe cooked last week becomes one not yet in this week; with none left it stays, and the note says so.
export function readPlan(raw: unknown, doc: MealsDoc, req: PlanRequest): PlanAnswer {
  const allowed = new Set(daysToPlan(doc, req))
  const recipes = doc.recipes.filter((r) => r.archived_at === null)
  const live = new Set(recipes.map((r) => r.id))
  const plan: PlannedDay[] = []
  const a = raw as { plan?: unknown; note?: unknown } | null
  for (const p of Array.isArray(a?.plan) ? a.plan : []) {
    const d = p as Record<string, unknown>
    if (!isDay(d.day) || !allowed.has(d.day) || plan.some((x) => x.day === d.day)) continue
    const lunch = typeof d.lunch_recipe_id === 'string' && live.has(d.lunch_recipe_id) ? d.lunch_recipe_id : null
    // An unknown lunch drops the day; a null one means lunch is not cooked.
    if (lunch === null && d.lunch_recipe_id !== null && d.lunch_recipe_id !== undefined) continue
    const leftovers = lunch !== null && d.leftovers !== false
    const dinner = !leftovers && typeof d.dinner_recipe_id === 'string' && live.has(d.dinner_recipe_id) ? d.dinner_recipe_id : null
    if (lunch === null && dinner === null) continue
    plan.push({ day: d.day, lunch_recipe_id: lunch, leftovers, dinner_recipe_id: dinner })
  }
  plan.sort((x, y) => (x.day < y.day ? -1 : 1))
  const last = cookedLastWeek(doc, req.week)
  const end = addDaysText(req.week, 6)
  const kept = req.mode === 'all' ? [] : doc.meals.filter((m) => m.day >= req.week && m.day <= end).map((m) => m.recipe_id)
  const used = new Set([...kept, ...plan.flatMap((p) => [p.lunch_recipe_id, p.dinner_recipe_id])])
  const spare = recipes.filter((r) => !last.has(r.id) && !used.has(r.id))
  const name = (id: string) => recipes.find((r) => r.id === id)?.name ?? id
  const said = typeof a?.note === 'string' ? [a.note.replace(/\s+/g, ' ').trim().slice(0, 200)] : []
  for (const p of plan) {
    for (const slot of ['lunch_recipe_id', 'dinner_recipe_id'] as const) {
      const id = p[slot]
      if (id === null || !last.has(id)) continue
      const other = spare.shift()
      if (other) p[slot] = other.id
      said.push(other ? `${weekdayName(p.day)} has ${other.name} instead of ${name(id)}, which was cooked last week.` : `${weekdayName(p.day)} has ${name(id)} again from last week: every other recipe is already planned this week.`)
    }
  }
  return { plan, note: said.filter(Boolean).join(' ') }
}
