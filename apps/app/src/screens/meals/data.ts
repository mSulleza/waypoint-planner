import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Snapshot } from '@waypoint/core'
import { settingsOf, type MealsDoc, type MealSettings } from '@waypoint/core/meals'
import { useMemo } from 'react'
import { DataError } from '@/data/errors'
import { useSnapshot } from '@/data/hooks'
import { HOUSEHOLD_KEY } from '@/data/query'
import { useDataSource } from '@/data/source'
import { getSupabase } from '@/data/supabase'
import type { PlanAnswer, PlanRequest } from '@/ai/meals-plan'
import type { AiReply, SwapAnswer } from '@/ai/meals-swap'
import type { Product, ShopReply } from '@/server/mercadona'
import { loadMeals, sendMealEdit, type MealEdit } from './meals.writes'
import { aiErrorWords } from './swap.model'
import { sampleMeals } from './sample'

export { EMPTY_MEALS, type MealEdit } from './meals.writes'

// Under the household's key, so a reload of the household reloads meals too.
export const MEALS_KEY = [...HOUSEHOLD_KEY, 'meals'] as const

export interface MealsState {
  doc: MealsDoc | undefined
  settings: MealSettings | undefined
  snapshot: Snapshot | undefined
  error: DataError | null
  loading: boolean
  writable: boolean
  refetch: () => void
}

// The household's meals beside its snapshot; a sample shows its own read-only week.
export function useMeals(): MealsState {
  const { source, owner, generation } = useDataSource()
  const { snapshot, writable } = useSnapshot()
  const sample = source.kind === 'sample'
  const query = useQuery({ queryKey: [...MEALS_KEY, owner ?? '', generation], queryFn: () => loadMeals(getSupabase()), enabled: !sample && owner !== null })
  const sampled = useMemo(() => (sample && snapshot ? sampleMeals(snapshot) : undefined), [sample, snapshot])
  const doc = sample ? sampled : query.data
  const settings = useMemo(() => (doc && snapshot ? settingsOf(doc, snapshot) : undefined), [doc, snapshot])
  const error = query.error ? (query.error instanceof DataError ? query.error : new DataError('server', 'The meals could not load.', { technical: String(query.error) })) : null
  return { doc, settings, snapshot, error: sample ? null : error, loading: !doc && !error, writable: writable && !sample, refetch: () => void query.refetch() }
}

// Each meals write, then a reload of the meals; samples and offline never write.
export function useMealEdit() {
  const queryClient = useQueryClient()
  const { owner } = useDataSource()
  const { writable } = useMeals()
  return useMutation({
    mutationFn: async (edit: MealEdit) => {
      if (!writable || owner === null) throw new DataError('read_only', 'Saving is off offline and in samples.')
      await sendMealEdit(getSupabase(), owner, edit)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: MEALS_KEY }),
  })
}

// The helper's function on the web app's own origin; a phone build reaches it through the web address.
const AI_URL = `${process.env.EXPO_PUBLIC_WEB_URL ?? ''}/api/meals-ai`

async function callAi(body: unknown): Promise<AiReply> {
  const { data } = await getSupabase().auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new DataError('signed_out', aiErrorWords('signed_out'))
  let reply: Response
  try {
    reply = await fetch(AI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  } catch (error) {
    throw new DataError('network', 'Waypoint could not reach the server.', { technical: String(error) })
  }
  const json = (await reply.json().catch(() => null)) as (AiReply & { error?: string }) | null
  if (!reply.ok || !json) throw new DataError('rejected', aiErrorWords(json?.error ?? ''), { code: json?.error ?? null, technical: `meals-ai: HTTP ${reply.status} ${json?.error ?? ''}` })
  return json
}

// Whether this account may ask DeepSeek; false in samples, offline, and where the web app has no helper (local development).
export function useAiEnabled(): boolean {
  const { source, owner } = useDataSource()
  const live = source.kind !== 'sample' && owner !== null
  const query = useQuery({ queryKey: ['meals-ai', owner ?? ''], queryFn: () => callAi({ task: 'status' }).then((r) => 'enabled' in r && r.enabled === true), enabled: live, staleTime: Infinity, retry: false })
  return live && query.data === true
}

// Fixes for the meals an item not in stock was for, or what to buy instead; nothing is saved until one is used.
export function askSwap(itemId: string, trip: string): Promise<SwapAnswer> {
  return callAi({ task: 'swap', item_id: itemId, trip }).then((r) => {
    if (!('meals' in r)) throw new DataError('rejected', aiErrorWords(''))
    return r
  })
}

// DeepSeek's draft of the week; nothing is saved until the person uses it.
export function askPlan(req: Omit<PlanRequest, 'task'>): Promise<PlanAnswer> {
  return callAi({ task: 'plan', ...req }).then((r) => {
    if (!('plan' in r)) throw new DataError('rejected', aiErrorWords(''))
    return r
  })
}

const SHOP_URL = `${process.env.EXPO_PUBLIC_WEB_URL ?? ''}/api/mercadona`

// Mercadona's products for the typed words, through the web app's server; a failure is named so Add an item can offer the manual add.
export async function searchMercadona(query: string): Promise<Product[]> {
  const { data } = await getSupabase().auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new DataError('signed_out', 'Sign in again to search Mercadona.')
  let reply: Response
  try {
    reply = await fetch(SHOP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ query }) })
  } catch (error) {
    throw new DataError('network', 'Waypoint could not reach the server.', { technical: String(error) })
  }
  const json = (await reply.json().catch(() => null)) as (ShopReply & { error?: string }) | null
  if (!reply.ok || !json || !Array.isArray(json.products)) throw new DataError('rejected', 'Mercadona did not answer.', { code: json?.error ?? null, technical: `mercadona: HTTP ${reply.status} ${json?.error ?? ''}` })
  return json.products
}
