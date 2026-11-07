import { rateRow, SCHEMA_VERSION, type Rate } from '@waypoint/core'

// The one copy of the household kept on the device: the last good export with the rates it was read at (one rate store).
export const SNAPSHOT_KEY = `waypoint:snapshot:v${SCHEMA_VERSION}`

export interface SavedSnapshot {
  // Whose household this is, so another account signing in on the device never sees it.
  user_id: string
  fetched_at: string
  doc: unknown
  rates: Rate[]
}

function isSaved(value: unknown): value is SavedSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.user_id === 'string' &&
    s.user_id !== '' &&
    typeof s.fetched_at === 'string' &&
    !Number.isNaN(Date.parse(s.fetched_at)) &&
    'doc' in s &&
    Array.isArray(s.rates) &&
    s.rates.every((r) => rateRow.safeParse(r).success)
  )
}

// Private windows, blocked site data and full quotas throw; the app then runs without a saved copy.
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readSaved(): SavedSnapshot | null {
  try {
    const text = storage()?.getItem(SNAPSHOT_KEY)
    if (!text) return null
    const parsed: unknown = JSON.parse(text)
    return isSaved(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeSaved(saved: SavedSnapshot): boolean {
  try {
    const store = storage()
    if (!store) return false
    store.setItem(SNAPSHOT_KEY, JSON.stringify(saved))
    return true
  } catch {
    return false
  }
}

export function forgetSaved(): void {
  try {
    storage()?.removeItem(SNAPSHOT_KEY)
  } catch {
    // Nothing saved can be read back either.
  }
}

let epoch = 0

// Counts sign-outs and account changes on this device; a load that started under an older count never writes the saved copy.
export function accountEpoch(): number {
  return epoch
}

// The signed-in account ended or changed: its saved copy goes, and loads still in flight for it will not bring it back.
export function endAccount(): void {
  epoch += 1
  forgetSaved()
}
