import type { QueryClient } from '@tanstack/react-query'
import { asDataError, authError, type DataError } from './errors'
import { queryClient } from './query'
import { endAccount } from './saved'
import { getSupabase } from './supabase'

export interface SignOutDeps {
  signOut: () => Promise<{ error: unknown }>
  queryClient: QueryClient
}

const DEPS: SignOutDeps = {
  // This device only, so the agent's session elsewhere stays signed in.
  signOut: () => getSupabase().auth.signOut({ scope: 'local' }),
  queryClient,
}

// Why this device is signing out: the person asked, or their account has just been deleted.
export type SignOutReason = 'asked' | 'deleted'

let asked: SignOutReason | null = null

// Set while a sign-out run here is under way, so the account it ends is not reported as a session that ended by itself.
export function signingOut(): SignOutReason | null {
  return asked
}

// The saved household and every cache go first, and a load still in flight cannot save it again.
export async function signOut(deps: SignOutDeps = DEPS, reason: SignOutReason = 'asked'): Promise<DataError | null> {
  endAccount()
  asked = reason
  try {
    const { error } = await deps.signOut()
    return error ? authError(error) : null
  } catch (error) {
    return asDataError(error)
  } finally {
    asked = null
    endAccount()
    deps.queryClient.getMutationCache().clear()
    deps.queryClient.removeQueries({ type: 'inactive' })
  }
}
