import { mealsDoc, type MealsDoc } from '@waypoint/core/meals'
import { starterDoc } from '@waypoint/core/meals-starter'
import { describe, expect, it } from 'vitest'
import { readRecipes } from './meals-recipes'
import { allowed, DEEPSEEK_URL, handle, readAnswer, readJson, readRequest, swapContext, swapPrompt, type AiEnv } from './meals-swap'

const SAT = '2026-10-24'

// The starter pack with pork belly not in stock on Saturday's trip, and a week that cooks it on Thursday and adobo on Sunday.
function doc(): MealsDoc {
  const base = starterDoc({ meals: null, cleaning: null, care: null }, 'EUR', 5, 2)
  return mealsDoc.parse({
    ...base,
    items: (base.items ?? []).map((i) => ({ ...i, price_minor: 100, price_checked_on: SAT, price_source: 'mercadona', unavailable_on: i.id === 'pork-belly' ? SAT : null })),
    meals: [
      { id: 'thu', day: '2026-10-29', slot: 'lunch', recipe_id: 'pork-belly', leftovers: true },
      { id: 'sun', day: '2026-10-25', slot: 'lunch', recipe_id: 'adobo', leftovers: true },
      { id: 'next', day: '2026-11-05', slot: 'lunch', recipe_id: 'pork-belly', leftovers: true },
    ],
  })
}

const ENV: AiEnv = { supabase_url: 'https://db.test', supabase_key: 'pk', deepseek_key: 'dk', model: undefined, users: 'user-a, user-b' }

// Answers Supabase's user and export_meals reads and DeepSeek's call, recording what each was sent.
function fakeFetch(user: string, content: string | null, status = 200, finish = 'stop') {
  const sent: { url: string; body: unknown; headers: Record<string, string> }[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> })
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: user })
    if (url.endsWith('/rest/v1/rpc/export_meals')) return Response.json(doc())
    if (url === DEEPSEEK_URL) return status === 200 ? Response.json({ choices: [{ message: { content }, finish_reason: finish }] }) : new Response('no', { status })
    return new Response('?', { status: 404 })
  }) as unknown as typeof fetch
  return { fn, sent }
}

describe('meals helper', () => {
  it('reads only a status or a swap request, and lets in only the listed accounts', () => {
    expect([readRequest({ task: 'status' }), readRequest({ task: 'swap', item_id: 'x', trip: SAT }), readRequest({ task: 'swap', item_id: '', trip: SAT }), readRequest({ task: 'plan' })]).toEqual([{ task: 'status' }, { task: 'swap', item_id: 'x', trip: SAT }, null, null])
    expect([allowed(ENV, 'user-b'), allowed(ENV, 'user-c'), allowed({ ...ENV, users: undefined }, 'user-a')]).toEqual([true, false, false])
  })

  it('tells DeepSeek the meals the trip buys for that need the item, and what the shop still has', () => {
    const ctx = swapContext(doc(), 'pork-belly', SAT)!
    // Thursday buys from Saturday's trip; the 5 Nov meal is next week's, and Sunday's adobo does not use pork belly.
    expect(ctx.meals.map((m) => [m.meal_id, m.recipe.name])).toEqual([['thu', 'Honey-garlic pork belly']])
    expect(ctx.items.some((i) => i.id === 'pork-belly')).toBe(false)
    // Recipes that need pork belly cannot be offered: the pancit and the pork belly itself.
    expect(ctx.recipes.map((r) => r.recipe.id)).not.toContain('pancit')
    const prompt = JSON.parse(swapPrompt(ctx)) as { shop_list: { price_eur: number }[]; missing: { name: string } }
    expect([prompt.missing.name, prompt.shop_list[0]?.price_eur]).toEqual(['Pork belly, thin slices', 1])
  })

  it('offers no recipe cooked the week before the trip’s week, which starts on the shopping day', () => {
    const d = mealsDoc.parse({
      ...doc(),
      meals: [...doc().meals, { id: 'fri', day: '2026-10-23', slot: 'lunch', recipe_id: 'mapo', leftovers: true }, { id: 'old', day: '2026-10-16', slot: 'lunch', recipe_id: 'teriyaki', leftovers: true }],
    })
    const offered = (x: MealsDoc, trip: string) => ['mapo', 'adobo', 'teriyaki'].map((id) => swapContext(x, 'pork-belly', trip)!.recipes.some((r) => r.recipe.id === id))
    // Shopping on Saturday: last week ran 17 to 23 Oct, so Friday's mapo is out and Sunday's adobo is this week.
    expect(offered(d, SAT)).toEqual([false, true, true])
    // Shopping on Monday: the week of 26 Oct follows 19 to 25 Oct, so Sunday's adobo is out too.
    expect(offered(mealsDoc.parse({ ...d, settings: { ...d.settings, shop_weekday: 0 } }), '2026-10-26')).toEqual([false, false, true])
  })

  it('keeps only fixes that name what the shop has, never the missing item or a recipe that needs it', () => {
    const ctx = swapContext(doc(), 'pork-belly', SAT)!
    const answer = readAnswer(
      {
        meals: [
          {
            meal_id: 'thu',
            options: [
              { type: 'ingredient', with_item_id: 'thighs', quantity: 500, note: 'Same glaze works on chicken.' },
              { type: 'ingredient', with_item_id: 'pork-belly', quantity: 500 },
              { type: 'ingredient', with_item_id: 'lamb', quantity: 500 },
              { type: 'recipe', recipe_id: 'pancit' },
              { type: 'recipe', recipe_id: 'curry', note: 'x'.repeat(300) },
            ],
          },
          { meal_id: 'sun', options: [{ type: 'recipe', recipe_id: 'mapo' }] },
        ],
        buy: [{ item_id: 'tofu', packs: 1 }, { item_id: 'pork-belly', packs: 1 }],
      },
      ctx,
    )
    expect(answer.meals).toEqual([
      {
        meal_id: 'thu',
        options: [
          { type: 'ingredient', with_item_id: 'thighs', quantity: 500, note: 'Same glaze works on chicken.' },
          { type: 'recipe', recipe_id: 'curry', note: 'x'.repeat(140) },
        ],
      },
    ])
    expect(answer.buy).toEqual([{ item_id: 'tofu', packs: 1, note: '' }])
  })

  it('answers status for any signed-in account, and asks DeepSeek in json mode only for a listed one', async () => {
    const off = fakeFetch('user-c', '{}')
    expect(await handle({ task: 'status' }, 'tok', ENV, off.fn)).toEqual({ enabled: false })
    expect(await handle({ task: 'swap', item_id: 'pork-belly', trip: SAT }, 'tok', ENV, off.fn)).toEqual({ status: 403, error: 'not_enabled' })
    expect(await handle({ task: 'status' }, null, ENV, off.fn)).toEqual({ status: 401, error: 'signed_out' })
    const on = fakeFetch('user-a', JSON.stringify({ meals: [{ meal_id: 'thu', options: [{ type: 'recipe', recipe_id: 'curry', note: 'Chicken instead' }] }], buy: [] }))
    expect(await handle({ task: 'swap', item_id: 'pork-belly', trip: SAT }, 'tok', ENV, on.fn)).toEqual({ meals: [{ meal_id: 'thu', options: [{ type: 'recipe', recipe_id: 'curry', note: 'Chicken instead' }] }], buy: [] })
    const call = on.sent.find((s) => s.url === DEEPSEEK_URL)!
    expect([call.headers.Authorization, (call.body as { model: string }).model, (call.body as { response_format: unknown }).response_format, (call.body as { thinking: unknown }).thinking]).toEqual(['Bearer dk', 'deepseek-flash', { type: 'json_object' }, { type: 'disabled' }])
    // The household's meals were read with the caller's own token, never another key.
    expect(on.sent.find((s) => s.url.endsWith('export_meals'))?.headers.Authorization).toBe('Bearer tok')
  })

  it('names an empty, broken or refused DeepSeek answer instead of passing it on', async () => {
    const swap = { task: 'swap', item_id: 'pork-belly', trip: SAT }
    expect(await handle(swap, 'tok', ENV, fakeFetch('user-a', '').fn)).toEqual({ status: 502, error: 'deepseek_empty' })
    expect(await handle(swap, 'tok', ENV, fakeFetch('user-a', '', 200, 'length').fn)).toEqual({ status: 502, error: 'deepseek_cut_off' })
    expect(await handle(swap, 'tok', ENV, fakeFetch('user-a', 'not json').fn)).toEqual({ status: 502, error: 'deepseek_not_json' })
    expect(await handle(swap, 'tok', ENV, fakeFetch('user-a', null, 429).fn)).toEqual({ status: 502, error: 'deepseek_429' })
  })

  it('keeps only new recipes built from the list, quick, with a main item and a name not already used', () => {
    const good = { name: 'Tofu adobo', prep_minutes: 20, steps: ['Fry the tofu.', 'Add soy, vinegar and garlic; simmer 10 minutes.'], ingredients: [{ item_id: 'tofu', quantity: 400 }, { item_id: 'soy', quantity: 60 }, { item_id: 'garlic', quantity: 15 }] }
    const answer = readRecipes(
      {
        recipes: [
          good,
          { ...good, name: 'Chicken adobo' },
          { ...good, name: 'Slow pork', prep_minutes: 90 },
          { ...good, name: 'Lamb curry', ingredients: [{ item_id: 'lamb', quantity: 500 }, ...good.ingredients] },
          { ...good, name: 'Sauce only', ingredients: [{ item_id: 'soy', quantity: 60 }, { item_id: 'garlic', quantity: 15 }, { item_id: 'rice', quantity: 300 }] },
          { ...good, name: 'Tofu adobo' },
          { ...good, name: 'Ginger tofu' },
        ],
      },
      doc(),
      3,
    )
    expect(answer.recipes.map((r) => r.name)).toEqual(['Tofu adobo', 'Ginger tofu'])
    expect(answer.recipes[0]).toMatchObject({ portions: 4, prep_minutes: 20, steps: '1. Fry the tofu.\n2. Add soy, vinegar and garlic; simmer 10 minutes.', lines: [{ item_id: 'tofu', quantity: 400 }, { item_id: 'soy', quantity: 60 }, { item_id: 'garlic', quantity: 15 }] })
    expect([readRequest({ task: 'recipes', count: 3 }), readRequest({ task: 'recipes', count: 9 })]).toEqual([{ task: 'recipes', count: 3 }, null])
  })

  it('asks DeepSeek for new recipes for a listed account, and returns only the drafts that pass', async () => {
    const on = fakeFetch('user-a', JSON.stringify({ recipes: [{ name: 'Tofu adobo', prep_minutes: 20, steps: ['Fry.', 'Simmer.'], ingredients: [{ item_id: 'tofu', quantity: 400 }, { item_id: 'soy', quantity: 60 }, { item_id: 'garlic', quantity: 15 }] }] }))
    const out = await handle({ task: 'recipes', count: 2 }, 'tok', ENV, on.fn)
    expect('recipes' in out ? out.recipes.map((r) => r.name) : out).toEqual(['Tofu adobo'])
    const prompt = JSON.parse((on.sent.find((s) => s.url === DEEPSEEK_URL)!.body as { messages: { content: string }[] }).messages[1]!.content) as { recipes_wanted: number; existing_recipes: string[] }
    expect([prompt.recipes_wanted, prompt.existing_recipes.length]).toEqual([2, 12])
  })

  it('reads json from a reply in a code fence or with words around it, and nothing from a reply cut short', () => {
    expect([readJson('{"a":1}'), readJson('```json\n{"a":1}\n```'), readJson('Here you go: {"a":1} Enjoy.'), readJson('{"a":[1,')]).toEqual([{ a: 1 }, { a: 1 }, { a: 1 }, undefined])
  })
})
