import { addDays } from '@waypoint/core'
import { cookCost, weekDays, type Meal, type MealsDoc } from '@waypoint/core/meals'
import type { PlannedDay } from '@/ai/meals-plan'
import type { MealEdit } from './meals.writes'

// Plan this week in the app: each recipe's cost for the helper, the week as it would read with the draft, and the writes that save it.

export type PlanMode = 'empty' | 'all'

// Each live recipe's cost as written, at saved prices; an unpriced ingredient counts nothing.
export function recipeCosts(doc: MealsDoc): Record<string, number> {
  return Object.fromEntries(doc.recipes.filter((r) => r.archived_at === null).map((r) => [r.id, cookCost(doc, r.id, r.portions).cost_minor]))
}

const inWeek = (m: Meal, start: string) => m.day >= start && m.day <= addDays(start, 6)

// The meals with the draft in place: the whole week replaced, or only the planned days added to what is there.
export function draftDoc(doc: MealsDoc, plan: readonly PlannedDay[], start: string, mode: PlanMode): MealsDoc {
  const planned = new Set(plan.map((p) => p.day))
  const kept = doc.meals.filter((m) => !inWeek(m, start) || (mode === 'empty' && !planned.has(m.day)))
  const added = plan.flatMap((p): Meal[] => [
    ...(p.lunch_recipe_id ? [{ id: `draft:${p.day}:lunch`, day: p.day, slot: 'lunch' as const, recipe_id: p.lunch_recipe_id, leftovers: p.leftovers }] : []),
    ...(p.dinner_recipe_id ? [{ id: `draft:${p.day}:dinner`, day: p.day, slot: 'dinner' as const, recipe_id: p.dinner_recipe_id, leftovers: false }] : []),
  ])
  return { ...doc, meals: [...kept, ...added] }
}

// The writes that make the week read as the draft: each planned day's lunch and dinner set or cleared, and with the whole week, every day the draft leaves out cleared.
export function planEdits(doc: MealsDoc, plan: readonly PlannedDay[], start: string, mode: PlanMode, newId: () => string): MealEdit[] {
  const edits: MealEdit[] = []
  const at = (day: string, slot: 'lunch' | 'dinner') => doc.meals.find((m) => m.day === day && m.slot === slot)
  const clear: string[] = []
  for (const day of weekDays(start)) {
    const p = plan.find((x) => x.day === day)
    if (!p) {
      if (mode === 'all') clear.push(...[at(day, 'lunch'), at(day, 'dinner')].flatMap((m) => (m ? [m.id] : [])))
      continue
    }
    const lunch = at(day, 'lunch')
    const dinner = at(day, 'dinner')
    // No lunch cooked clears the lunch the day had; a dinner from lunch, or none planned, clears its dinner.
    if (lunch && !p.lunch_recipe_id) clear.push(lunch.id)
    if (dinner && !p.dinner_recipe_id) clear.push(dinner.id)
    if (p.lunch_recipe_id) edits.push({ kind: 'meal', row: { id: lunch?.id ?? newId(), day, slot: 'lunch', recipe_id: p.lunch_recipe_id, leftovers: p.leftovers } })
    if (p.dinner_recipe_id) edits.push({ kind: 'meal', row: { id: dinner?.id ?? newId(), day, slot: 'dinner', recipe_id: p.dinner_recipe_id, leftovers: false } })
  }
  // Clearing first, so a lunch cooked for dinner too never sits beside a dinner it replaces.
  return clear.length > 0 ? [{ kind: 'unmeal', ids: clear }, ...edits] : edits
}
