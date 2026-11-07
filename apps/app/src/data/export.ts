import { todayIn } from '@waypoint/core'
import { rpcError } from './errors'
import type { WaypointClient } from './supabase'

// The household as a file: export_household's JSON as it came, with its meals, which import_household takes back (spec §10).
export interface ExportFile {
  name: string
  text: string
}

export const exportFileName = (day: string) => `waypoint-export-${day}.json`

// Dated by the household's own day, as every other date in it is.
function dayOf(doc: unknown, now: Date): string {
  const zone = (doc as { household?: { timezone?: unknown } } | null)?.household?.timezone
  try {
    return todayIn(typeof zone === 'string' ? zone : 'UTC', now)
  } catch {
    return todayIn('UTC', now)
  }
}

// export_household's document, with export_meals' rows under 'meals' when there are any; null when the account has no household yet. The file is written as read, so data that fails the app's checks still leaves with its owner.
export async function exportHousehold(client: Pick<WaypointClient, 'rpc'>, now: Date): Promise<ExportFile | null> {
  const { data, error, status } = await client.rpc('export_household')
  if (error) throw rpcError('export_household', error, status)
  if (data === null || data === undefined) return null
  const meals = await client.rpc('export_meals')
  if (meals.error) throw rpcError('export_meals', meals.error, meals.status)
  const doc = hasMeals(meals.data) ? { ...(data as object), meals: meals.data } : data
  return { name: exportFileName(dayOf(data, now)), text: `${JSON.stringify(doc, null, 2)}\n` }
}

// Settings or any row; an empty meals export stays out of the file.
function hasMeals(meals: unknown): boolean {
  if (meals === null || typeof meals !== 'object') return false
  return Object.values(meals).some((v) => (Array.isArray(v) ? v.length > 0 : v !== null))
}
