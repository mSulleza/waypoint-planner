import { formatMoney, type Money } from './money'
import { snapshotIndex, type Snapshot } from './snapshot'

// Words for screens and the agent, with amounts, dates and names left as tokens: one formatter shows them and the privacy mask hides every amount.
export type CopyPart = { text: string } | { money: Money } | { date: string } | { month: string } | { account: string } | { item: string } | { category: string }
export type Copy = readonly CopyPart[]

// The five tabs (spec §7); every route names one of them.
export const TABS = ['today', 'months', 'money', 'debts', 'plan'] as const
export type Tab = (typeof TABS)[number]

export interface Route {
  tab: Tab
  month?: string
  account_id?: string
  segment?: 'todo' | 'breakdown' | 'chart'
  // A sheet over the tab: Add, prefilled, or Statement.
  sheet?: 'add' | 'statement'
}

// What an alert or the next action is about: one account in one month, or one review item.
export type Subject = { account_id: string; month: string } | { review_id: string }

export function sameSubject(a: Subject, b: Subject): boolean {
  if ('review_id' in a || 'review_id' in b) return 'review_id' in a && 'review_id' in b && a.review_id === b.review_id
  return a.account_id === b.account_id && a.month === b.month
}

export const textPart = (value: string): CopyPart => ({ text: value })
export const moneyPart = (minor: number, currency: string): CopyPart => ({ money: { minor, currency } })

export interface CopyNames {
  money(value: Money): string
  date(day: string): string
  month(key: string): string
  account(id: string): string
  item(id: string): string
  category(id: string): string
}

export function renderCopy(copy: Copy, names: CopyNames): string {
  return copy
    .map((part) => {
      if ('text' in part) return part.text
      if ('money' in part) return names.money(part.money)
      if ('date' in part) return names.date(part.date)
      if ('month' in part) return names.month(part.month)
      if ('account' in part) return names.account(part.account)
      if ('item' in part) return names.item(part.item)
      return names.category(part.category)
    })
    .join('')
}

// The snapshot's own names and the household locale's money, dates left as YYYY-MM-DD; for the agent and tests, while screens bring their own.
export function plainNames(snapshot: Snapshot, options: { mask?: boolean } = {}): CopyNames {
  const index = snapshotIndex(snapshot)
  const categories = new Map(snapshot.doc.categories.map((c) => [c.id, c.name]))
  const locale = snapshot.doc.household.locale
  return {
    money: (value) => formatMoney(value.minor, value.currency, locale, { mask: options.mask === true }),
    date: (day) => day,
    month: (key) => key,
    account: (id) => index.accounts.get(id)?.name ?? id,
    item: (id) => index.planItems.get(id)?.name ?? id,
    category: (id) => categories.get(id) ?? id,
  }
}
