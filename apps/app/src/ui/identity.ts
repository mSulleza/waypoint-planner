import type { Account } from '@waypoint/core'
import { IDENTITY } from './tokens'

type Ordered = Pick<Account, 'id' | 'sort_order' | 'archived_at'>

// Where an unknown account falls: past the seven colours, so it reads grey.
export const OTHER_IDENTITY = IDENTITY.length

const byOrder = (a: Ordered, b: Ordered) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Each account's place in the account order (sort order, then id), cash, cards and loans alike, archived ones keeping theirs, so closing a paid-off card moves no other account's colour (spec §8).
export function identityIndex(accounts: readonly Ordered[]): ReadonlyMap<string, number> {
  return new Map([...accounts].sort(byOrder).map((a, i) => [a.id, i]))
}

export function identityOf(index: ReadonlyMap<string, number>, accountId: string): number {
  return index.get(accountId) ?? OTHER_IDENTITY
}

// The tile's letters: the first letter of each of the first two words, so 'Example Bank' is EB and 'Main' is M.
export function tileLetters(name: string): string {
  const words = name.trim().split(/[\s\-_/·.]+/u).filter(Boolean)
  return words
    .slice(0, 2)
    .map((w) => (Array.from(w)[0] ?? '').toLocaleUpperCase())
    .join('')
}
