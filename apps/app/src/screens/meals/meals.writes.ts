import { checkInput } from '@waypoint/core'
import { mealsDoc, type Item, type Meal, type MealsDoc, type MealsDocInput, type MealSettings, type Purchase, type Recipe, type RecipeItem } from '@waypoint/core/meals'
import { DataError, rpcError, type RpcFailure } from '../../data/errors'
import type { WaypointClient } from '../../data/supabase'

// The meals read and writes, apart from React, so the database tests send exactly what the screens send.

export const EMPTY_MEALS: MealsDoc = Object.freeze({ settings: null, items: [], purchases: [], recipes: [], recipe_items: [], meals: [], trips: [] }) as MealsDoc

export type MealsClient = Pick<WaypointClient, 'from' | 'rpc'>

// One export_meals call, checked by core; a household with no meals row reads as empty, never as an error.
export async function loadMeals(client: MealsClient): Promise<MealsDoc> {
  const { data, error, status } = await client.rpc('export_meals')
  if (error) throw rpcError('export_meals', error, status)
  if (data === null || data === undefined) return EMPTY_MEALS
  const checked = checkInput(mealsDoc, data)
  if (!checked.ok) throw new DataError('bad_data', 'Some of the meals data did not pass the checks, so Waypoint cannot show it.', { detail: checked.errors, technical: checked.errors[0] ?? null })
  return checked.value
}

type Owned<T> = T & { household_id: string }

// One write each, under the same row-level security as the read; a retry sends the same ids, so it changes a row and adds none.
export type MealEdit =
  | { kind: 'settings'; row: MealSettings }
  | { kind: 'item'; row: Item }
  | { kind: 'item_patch'; id: string; patch: Partial<Pick<Item, 'wanted_on' | 'archived_at' | 'unavailable_on' | 'at_home_on'>> }
  | { kind: 'buy'; row: Purchase }
  | { kind: 'unbuy'; id: string }
  // The recipe, its lines as they should read, and the ids of lines taken out.
  | { kind: 'recipe'; row: Recipe; lines: readonly RecipeItem[]; removed: readonly string[] }
  | { kind: 'meal'; row: Meal }
  | { kind: 'unmeal'; ids: readonly string[] }
  | { kind: 'trip'; id: string; day: string }
  | { kind: 'untrip'; day: string }
  | { kind: 'starter'; doc: MealsDocInput }

interface Reply {
  error: RpcFailure | null
  status: number
}

const owned = <T extends object>(row: T, household_id: string): Owned<T> => ({ ...row, household_id })

export async function sendMealEdit(client: MealsClient, owner: string, edit: MealEdit): Promise<void> {
  const fail = (r: Reply) => {
    if (r.error) throw rpcError(edit.kind, r.error, r.status)
  }
  if (edit.kind === 'settings') return fail(await client.from('meal_settings').upsert(owned(edit.row, owner), { onConflict: 'household_id' }))
  if (edit.kind === 'item') return fail(await client.from('items').upsert(owned(edit.row, owner), { onConflict: 'id' }))
  if (edit.kind === 'item_patch') return fail(await client.from('items').update(edit.patch).eq('id', edit.id))
  if (edit.kind === 'buy') return fail(await client.from('item_purchases').upsert(owned(edit.row, owner), { onConflict: 'item_id,bought_on' }))
  if (edit.kind === 'unbuy') return fail(await client.from('item_purchases').delete().eq('id', edit.id))
  if (edit.kind === 'meal') return fail(await client.from('meals').upsert(owned(edit.row, owner), { onConflict: 'household_id,day,slot' }))
  if (edit.kind === 'unmeal') return fail(await client.from('meals').delete().in('id', [...edit.ids]))
  if (edit.kind === 'trip') return fail(await client.from('trips').upsert(owned({ id: edit.id, day: edit.day }, owner), { onConflict: 'household_id,day' }))
  if (edit.kind === 'untrip') return fail(await client.from('trips').delete().eq('day', edit.day))
  if (edit.kind === 'starter') return fail(await client.rpc('import_meals', { p_meals: edit.doc }))
  // A recipe: the row, then its lines, then the lines taken out.
  fail(await client.from('recipes').upsert(owned(edit.row, owner), { onConflict: 'id' }))
  if (edit.lines.length > 0) fail(await client.from('recipe_items').upsert(edit.lines.map((l) => owned(l, owner)), { onConflict: 'id' }))
  if (edit.removed.length > 0) fail(await client.from('recipe_items').delete().in('id', [...edit.removed]))
}
