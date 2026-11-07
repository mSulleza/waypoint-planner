import { randomUUID } from 'node:crypto'
import type { Db } from './auth'
import { AgentError } from './errors'
import { parsePricesArgs, refreshPrices, type PricesDeps, type PricesOptions } from './prices'

// The Friday job on Mark's Mac: Mercadona prices first, then new recipes from the web app's meals helper, saved to the household as its own login.

export const DEFAULT_RECIPES = 3
export const WEEKLY_USAGE = 'Usage: tsx src/cli.ts weekly (--warehouse <code> | --postcode <5 digits>) [--recipes 3] [--days 7]'

export interface WeeklyOptions {
  prices: PricesOptions
  recipes: number
}

export function parseWeeklyArgs(args: readonly string[]): WeeklyOptions {
  const rest: string[] = []
  let recipes = DEFAULT_RECIPES
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--recipes' && /^[0-4]$/.test(args[i + 1] ?? '')) {
      recipes = Number(args[i + 1])
      i += 1
    } else rest.push(args[i]!)
  }
  return { prices: parsePricesArgs(rest), recipes }
}

export interface DraftRecipe {
  name: string
  portions: number
  prep_minutes: number
  steps: string
  lines: { item_id: string; quantity: number }[]
}

// One call to /api/meals-ai with the login's own token; the helper never writes, so saving stays here.
export async function askRecipes(fetchFn: typeof fetch, webUrl: string, token: string, count: number): Promise<DraftRecipe[]> {
  const reply = await fetchFn(`${webUrl}/api/meals-ai`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ task: 'recipes', count }) })
  const json = (await reply.json().catch(() => null)) as { recipes?: DraftRecipe[]; error?: string } | null
  if (!reply.ok || !json || !Array.isArray(json.recipes)) throw new AgentError(`The meals helper did not write recipes (HTTP ${reply.status}${json?.error ? `, ${json.error}` : ''}).`)
  return json.recipes
}

// Each draft as a recipe and its lines, under fresh ids; returns the names saved.
export async function saveRecipes(db: Db, owner: string, drafts: readonly DraftRecipe[]): Promise<string[]> {
  const saved: string[] = []
  for (const d of drafts) {
    const id = randomUUID()
    const recipe = await db.from('recipes').insert({ id, household_id: owner, name: d.name, portions: d.portions, prep_minutes: d.prep_minutes, steps: d.steps })
    if (recipe.error) throw new AgentError(`Saving ${d.name} failed: ${recipe.error.message}`)
    const lines = await db.from('recipe_items').insert(d.lines.map((l, i) => ({ id: randomUUID(), household_id: owner, recipe_id: id, item_id: l.item_id, quantity: l.quantity, sort_order: i })))
    if (lines.error) {
      await db.from('recipes').delete().eq('id', id)
      throw new AgentError(`Saving the ingredients of ${d.name} failed: ${lines.error.message}`)
    }
    saved.push(d.name)
  }
  return saved
}

export async function weeklyRun(deps: PricesDeps, options: WeeklyOptions, webUrl: string | null): Promise<{ failed: number; recipes: string[] }> {
  const prices = await refreshPrices(deps, options.prices)
  if (options.recipes === 0) return { failed: prices.failed, recipes: [] }
  if (!webUrl) throw new AgentError('Set WAYPOINT_WEB_URL (the web app’s address) so the weekly run can reach the meals helper.')
  const { data } = await deps.db.auth.getSession()
  const token = data.session?.access_token
  const owner = data.session?.user.id
  if (!token || !owner) throw new AgentError('The login has no session; run login again.')
  deps.say(`Asking the meals helper for ${options.recipes} new recipes…`)
  const drafts = options.prices.dry_run ? [] : await askRecipes(deps.fetch, webUrl, token, options.recipes)
  const recipes = await saveRecipes(deps.db, owner, drafts)
  deps.say(recipes.length > 0 ? `New recipes: ${recipes.join(', ')}.` : 'No new recipes this week.')
  return { failed: prices.failed, recipes }
}
