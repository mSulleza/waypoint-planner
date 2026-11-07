import { asDataError, rpcError, type DataError } from './errors'
import type { WaypointClient } from './supabase'

export interface DeleteDeps {
  rpc: WaypointClient['rpc']
  // data/signout's signOut with the reason 'deleted', so Welcome says what happened.
  signOut: () => Promise<DataError | null>
}

// delete_my_account removes the sign-in, and the household goes with every row by cascade (spec §10); then this device forgets the session and the saved copy.
export async function deleteAccount(deps: DeleteDeps): Promise<DataError | null> {
  try {
    const { error, status } = await deps.rpc('delete_my_account')
    if (error) return rpcError('delete_my_account', error, status)
  } catch (error) {
    return asDataError(error)
  }
  // The account is gone either way: auth-js drops the stored session even when the sign-out request fails.
  await deps.signOut()
  return null
}
