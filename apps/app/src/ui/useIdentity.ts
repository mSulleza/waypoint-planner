import { useCallback, useMemo } from 'react'
import { useSnapshot } from '@/data/hooks'
import { identityIndex, identityOf } from './identity'

// An account's place in the account order, which picks its colour, for a screen that names accounts without a view model of its own.
export function useIdentity(): (accountId: string) => number {
  const accounts = useSnapshot().snapshot?.doc.accounts
  const index = useMemo(() => identityIndex(accounts ?? []), [accounts])
  return useCallback((accountId: string) => identityOf(index, accountId), [index])
}
