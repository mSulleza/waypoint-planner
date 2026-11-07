import { describe, expect, it } from 'vitest'
import type { Db } from '../src/auth'
import { askRecipes, parseWeeklyArgs, saveRecipes } from '../src/weekly'

const draft = { name: 'Tofu adobo', portions: 4, prep_minutes: 20, steps: '1. Fry.\n2. Simmer.', lines: [{ item_id: 'tofu', quantity: 400 }, { item_id: 'soy', quantity: 60 }] }

// Records each insert and delete; refuses recipe_items when asked to.
function fakeDb(failLines = false) {
  const calls: [string, string, unknown][] = []
  const db = {
    from: (table: string) => ({
      insert: async (rows: unknown) => {
        calls.push([table, 'insert', rows])
        return { error: failLines && table === 'recipe_items' ? { message: 'foreign key' } : null }
      },
      delete: () => ({ eq: async (_c: string, id: string) => void calls.push([table, 'delete', id]) }),
    }),
  }
  return { db: db as unknown as Db, calls }
}

describe('weekly run', () => {
  it('takes the price options and how many recipes to ask for, 3 unless told', () => {
    expect(parseWeeklyArgs(['--postcode', '18001'])).toMatchObject({ recipes: 3, prices: { postcode: '18001', days: 7 } })
    expect(parseWeeklyArgs(['--recipes', '0', '--warehouse', '3968']).recipes).toBe(0)
  })

  it('asks the meals helper with the login’s token and names its refusal', async () => {
    const sent: [string, RequestInit | undefined][] = []
    const ok = (async (url: string, init?: RequestInit) => {
      sent.push([url, init])
      return Response.json({ recipes: [draft] })
    }) as unknown as typeof fetch
    expect(await askRecipes(ok, 'https://w.test', 'tok', 2)).toEqual([draft])
    expect([sent[0]![0], (sent[0]![1]?.headers as Record<string, string>).Authorization, sent[0]![1]?.body]).toEqual(['https://w.test/api/meals-ai', 'Bearer tok', JSON.stringify({ task: 'recipes', count: 2 })])
    const no = (async () => Response.json({ error: 'not_enabled' }, { status: 403 })) as unknown as typeof fetch
    await expect(askRecipes(no, 'https://w.test', 'tok', 2)).rejects.toThrow('The meals helper did not write recipes (HTTP 403, not_enabled).')
  })

  it('saves each recipe with its lines under the household, and takes a recipe back out when its lines fail', async () => {
    const { db, calls } = fakeDb()
    expect(await saveRecipes(db, 'house', [draft])).toEqual(['Tofu adobo'])
    const [recipe, lines] = calls
    expect(recipe).toMatchObject(['recipes', 'insert', { household_id: 'house', name: 'Tofu adobo', portions: 4, prep_minutes: 20 }])
    expect((lines![2] as { recipe_id: string; item_id: string; sort_order: number }[]).map((l) => [l.recipe_id === (recipe![2] as { id: string }).id, l.item_id, l.sort_order])).toEqual([[true, 'tofu', 0], [true, 'soy', 1]])
    const failing = fakeDb(true)
    await expect(saveRecipes(failing.db, 'house', [draft])).rejects.toThrow('Saving the ingredients of Tofu adobo failed: foreign key')
    expect(failing.calls.map((c) => `${c[0]}:${c[1]}`)).toEqual(['recipes:insert', 'recipe_items:insert', 'recipes:delete'])
  })
})
