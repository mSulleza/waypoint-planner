import type { BatchIds } from '@/screens/add/add.model'
import { randomId } from './uuid'

// One save's ids, made when the sheet opens and sent again unchanged on every retry, so a double tap or a lost reply saves once (post_batch already_applied).
export function newBatchIds(uuid: () => string = randomId): BatchIds {
  return { batch_id: uuid(), rows: [uuid(), uuid(), uuid()], transfer_id: uuid() }
}

// The account the Add sheet opens on, per device: the one the last save on it used.
export const LAST_ACCOUNT_KEY = 'waypoint:add:last-account'

// Private windows and blocked site data throw; the sheet then opens on the first cash account.
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readLastAccount(): string | null {
  try {
    const id = storage()?.getItem(LAST_ACCOUNT_KEY)
    return id ? id : null
  } catch {
    return null
  }
}

export function rememberLastAccount(id: string): void {
  try {
    storage()?.setItem(LAST_ACCOUNT_KEY, id)
  } catch {
    // The next sheet opens on the first cash account instead.
  }
}
