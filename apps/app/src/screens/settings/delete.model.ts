// Spec §10: the person types this word before delete_my_account runs.
export const CONFIRM_WORD = 'DELETE'

// Spaces around the word are forgiven; lower case is not, so typing it is a deliberate act.
export const confirmed = (text: string): boolean => text.trim() === CONFIRM_WORD

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// 'a, b and c', without Intl.ListFormat, which phones' JavaScript engine may lack.
function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

type Counted = 'accounts' | 'plan_items' | 'transactions' | 'statements' | 'categories'

// What goes with the household, counted from it as loaded: every table but the household row itself.
export function householdWords(doc: Record<Counted, readonly unknown[]>): string {
  return list([
    count(doc.accounts.length, 'account', 'accounts'),
    count(doc.plan_items.length, 'plan item', 'plan items'),
    count(doc.transactions.length, 'transaction', 'transactions'),
    count(doc.statements.length, 'statement', 'statements'),
    count(doc.categories.length, 'category', 'categories'),
  ])
}

// The same, before the household has loaded or when it cannot be counted.
export const EVERYTHING = 'Every account, card and loan, with each plan item, transaction, statement and category'
