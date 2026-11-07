import { abroad } from '@waypoint/core/fixtures'
import { starterDoc } from '@waypoint/core/meals-starter'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'
import { loadMeals, sendMealEdit } from '../../../apps/app/src/screens/meals/meals.writes'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-23'

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, String(v)),
  }
}

async function signUp(): Promise<{ client: WaypointClient; id: string }> {
  const client = createWaypointClient(url!, key!, { storage: memoryStorage() })
  const { data, error } = await client.auth.signUp({ email: `meals-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { client, id: data.user.id }
}

async function withHousehold(): Promise<{ client: WaypointClient; id: string }> {
  const user = await signUp()
  const { error } = await user.client.rpc('import_household', { p_doc: abroad(AS_OF).doc })
  if (error) throw new Error(`import_household: ${error.message}`)
  return user
}

describe.skipIf(!url || !key)('Meals through the REST API', () => {
  it('adds the starter pack once, then plans, ticks, edits a recipe and saves trips as the screens send them, and nothing reaches another household', { timeout: 60_000 }, async () => {
    const a = await withHousehold()
    const b = await signUp()
    await sendMealEdit(a.client, a.id, { kind: 'starter', doc: starterDoc({ meals: null, cleaning: null, care: null }, 'EUR', 5, 2) })
    await expect(sendMealEdit(a.client, a.id, { kind: 'starter', doc: starterDoc({ meals: null, cleaning: null, care: null }, 'EUR', 5, 2) })).rejects.toMatchObject({ kind: 'rejected', code: 'meals_not_empty' })
    let doc = await loadMeals(a.client)
    expect([doc.items.length, doc.recipes.length, doc.settings?.shop_weekday]).toEqual([46, 12, 5])
    const adobo = doc.recipes.find((r) => r.name === 'Chicken adobo')!
    const curry = doc.recipes.find((r) => r.name === 'Coconut chicken curry')!

    // One lunch a day: a second save of the same day and slot changes the row and adds none.
    await sendMealEdit(a.client, a.id, { kind: 'meal', row: { id: randomUUID(), day: '2026-10-24', slot: 'lunch', recipe_id: adobo.id, leftovers: true } })
    await sendMealEdit(a.client, a.id, { kind: 'meal', row: { id: randomUUID(), day: '2026-10-24', slot: 'lunch', recipe_id: curry.id, leftovers: true } })
    doc = await loadMeals(a.client)
    expect(doc.meals.map((m) => [m.day, m.slot, m.recipe_id, m.leftovers])).toEqual([['2026-10-24', 'lunch', curry.id, true]])

    // A tick is one purchase per item and day, and an untick removes it.
    const thighs = doc.items.find((i) => i.name.startsWith('Chicken thighs'))!
    const tick = { id: randomUUID(), item_id: thighs.id, bought_on: '2026-10-24', packs: 1, price_minor: null }
    await sendMealEdit(a.client, a.id, { kind: 'buy', row: tick })
    await sendMealEdit(a.client, a.id, { kind: 'buy', row: { ...tick, id: randomUUID(), packs: 2 } })
    doc = await loadMeals(a.client)
    expect(doc.purchases.map((p) => [p.item_id, p.bought_on, p.packs])).toEqual([[thighs.id, '2026-10-24', 2]])
    await sendMealEdit(a.client, a.id, { kind: 'unbuy', id: doc.purchases[0]!.id })

    // A recipe saves its row, its lines as they now read, and drops the lines taken out.
    const lines = doc.recipe_items.filter((l) => l.recipe_id === adobo.id)
    const [kept, ...out] = lines
    await sendMealEdit(a.client, a.id, { kind: 'recipe', row: { ...adobo, prep_minutes: 35 }, lines: [{ ...kept!, quantity: 700 }], removed: out.map((l) => l.id) })
    await sendMealEdit(a.client, a.id, { kind: 'item_patch', id: thighs.id, patch: { wanted_on: '2026-10-28' } })
    await sendMealEdit(a.client, a.id, { kind: 'trip', id: randomUUID(), day: '2026-10-24' })
    await sendMealEdit(a.client, a.id, { kind: 'trip', id: randomUUID(), day: '2026-10-28' })
    await sendMealEdit(a.client, a.id, { kind: 'untrip', day: '2026-10-28' })
    doc = await loadMeals(a.client)
    expect(doc.recipes.find((r) => r.id === adobo.id)?.prep_minutes).toBe(35)
    expect(doc.recipe_items.filter((l) => l.recipe_id === adobo.id).map((l) => l.quantity)).toEqual([700])
    expect([doc.purchases.length, doc.items.find((i) => i.id === thighs.id)?.wanted_on, doc.trips.map((t) => t.day)]).toEqual([0, '2026-10-28', ['2026-10-24']])

    // Another account reads none of it and changes none of it.
    expect(await loadMeals(b.client)).toMatchObject({ items: [], recipes: [], meals: [] })
    await sendMealEdit(b.client, b.id, { kind: 'item_patch', id: thighs.id, patch: { wanted_on: null } })
    expect((await loadMeals(a.client)).items.find((i) => i.id === thighs.id)?.wanted_on).toBe('2026-10-28')
  })

  it('carries the meals through an export and an import into another account, with fresh ids and the same rows', { timeout: 60_000 }, async () => {
    const a = await withHousehold()
    const groceriesOf = async (c: WaypointClient) => ((await c.rpc('export_household')).data as { categories: { id: string; name: string }[] }).categories.find((x) => x.name === 'Groceries')?.id ?? null
    await sendMealEdit(a.client, a.id, { kind: 'starter', doc: starterDoc({ meals: await groceriesOf(a.client), cleaning: null, care: null }, 'EUR', 6, 2) })
    const before = await loadMeals(a.client)
    const recipe = before.recipes[0]!
    await sendMealEdit(a.client, a.id, { kind: 'meal', row: { id: randomUUID(), day: '2026-10-25', slot: 'dinner', recipe_id: recipe.id, leftovers: false } })
    const household = await a.client.rpc('export_household')
    const meals = await a.client.rpc('export_meals')
    const b = await signUp()
    const imported = await b.client.rpc('import_household', { p_doc: { ...(household.data as object), meals: meals.data } })
    expect(imported.error).toBeNull()
    const [mine, theirs] = [await loadMeals(a.client), await loadMeals(b.client)]
    const shape = (d: typeof mine) => ({ items: d.items.map((i) => i.name).sort(), recipes: d.recipes.map((r) => r.name).sort(), lines: d.recipe_items.length, meals: d.meals.map((m) => [m.day, m.slot]), weekday: d.settings?.shop_weekday })
    expect(shape(theirs)).toEqual(shape(mine))
    expect(theirs.items.some((i) => mine.items.some((m) => m.id === i.id))).toBe(false)
    // The meals allowance follows the category to its new id.
    expect([mine.settings?.category_id, theirs.settings?.category_id]).toEqual([await groceriesOf(a.client), await groceriesOf(b.client)])
  })
})
