import type { GoTrueClient } from '@supabase/auth-js'
import type { QueryClient } from '@tanstack/react-query'
import { SUPABASE_KEY } from './query'
import { endAccount } from './saved'
import { signingOut } from './signout'
import { ownerAfter } from './source-state'

export interface Account {
  // Bumped when the signed-in account changes, so its household is a new query with nothing of the last account's in it.
  generation: number
  // The signed-in account as this device knows it; the saved copy shows only for it.
  owner: string | null
  // The last session ended without a sign-out here: the server refused it, it could not be renewed, or another tab signed out.
  ended: boolean
  // The last session ended because its account was deleted here.
  deleted: boolean
}

// Another account signing in never sees the last one's numbers, and a sign-out anywhere drops the saved copy.
export function followAccount(auth: Pick<GoTrueClient, 'onAuthStateChange'>, queryClient: QueryClient, current: () => Account, change: (next: Account) => void): () => void {
  const { data } = auth.onAuthStateChange((event, session) => {
    const owner = ownerAfter(event, session)
    const last = current()
    if (owner === undefined || owner === last.owner) return
    endAccount()
    queryClient.removeQueries({ queryKey: SUPABASE_KEY })
    const reason = signingOut()
    change({ generation: last.generation + 1, owner, ended: owner === null && reason === null, deleted: owner === null && reason === 'deleted' })
  })
  return () => data.subscription.unsubscribe()
}
