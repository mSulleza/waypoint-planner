import { monthKey } from '../dates'
import { convert } from '../money'
import { toRatesPerEur, type RatesPerEur } from '../rates'
import type { Transaction } from '../schema/rows'
import { snapshotIndex, type Snapshot } from '../snapshot'
import type { CategoryBudget, Occurrence } from './types'

const mulDiv = (a: number, b: number, c: number) => Number((BigInt(a) * BigInt(b)) / BigInt(c))

// Unlinked rows with a category, keyed `<category> <YYYY-MM>`: a row linked to any plan item never counts against a budget.
export function taggedSpend(snapshot: Snapshot): Map<string, Transaction[]> {
  const out = new Map<string, Transaction[]>()
  for (const t of snapshot.doc.transactions) {
    if (t.category_id === null || t.plan_item_id !== null) continue
    const key = `${t.category_id} ${t.posted_on.slice(0, 7)}`
    const list = out.get(key)
    if (list) list.push(t)
    else out.set(key, [t])
  }
  return out
}

function netCategory(snapshot: Snapshot, rates: RatesPerEur, categoryId: string, month: string, lines: readonly Occurrence[], spend: readonly Transaction[]): CategoryBudget {
  const { accounts } = snapshotIndex(snapshot)
  const currencyOf = (accountId: string) => accounts.get(accountId)?.currency ?? snapshot.doc.household.base_currency
  const own = new Set(lines.map((l) => currencyOf(l.account_id)))
  const currency = own.size === 1 ? [...own][0] ?? snapshot.doc.household.base_currency : snapshot.doc.household.base_currency
  const missing = new Set<string>()
  const toNet = (minor: number, from: string) => {
    const value = convert(minor, from, currency, rates)
    if (value === null) missing.add(from)
    return value
  }

  // A skipped line drops out with its share of the credits; a skipped credit drops out whole.
  let [all, kept, credits] = [0, 0, 0]
  const weights = new Map<string, number>()
  const unnetted = new Map<string, number>()
  for (const line of lines) {
    if (line.skipped && line.amount_minor < 0) continue
    const value = toNet(line.amount_minor, currencyOf(line.account_id))
    if (value === null) {
      // Without a rate a line cannot net, so it keeps its full amount and cash stays low.
      if (line.amount_minor > 0 && !line.skipped) unnetted.set(line.account_id, (unnetted.get(line.account_id) ?? 0) + line.amount_minor)
    } else if (line.amount_minor < 0) credits += value
    else {
      all += value
      if (!line.skipped) {
        kept += value
        weights.set(line.account_id, (weights.get(line.account_id) ?? 0) + value)
      }
    }
  }
  const budget = all === 0 ? credits : kept + mulDiv(credits, kept, all)
  let spent = 0
  for (const t of spend) spent -= toNet(t.amount_minor, currencyOf(t.account_id)) ?? 0
  // Refunds give back at most the whole budget, and the net floors at zero once for the category.
  const left = Math.max(0, Math.min(budget, budget - spent))

  const shares: { account_id: string; amount_minor: number }[] = []
  const ids = [...weights.keys()].sort()
  const total = [...weights.values()].reduce((sum, w) => sum + w, 0)
  let given = 0
  ids.forEach((accountId, i) => {
    const part = i === ids.length - 1 ? left - given : mulDiv(left, weights.get(accountId) ?? 0, total)
    given += part
    shares.push({ account_id: accountId, amount_minor: convert(part, currency, currencyOf(accountId), rates) ?? part })
  })
  for (const [accountId, amount] of unnetted) {
    const found = shares.find((s) => s.account_id === accountId)
    if (found) found.amount_minor += amount
    else shares.push({ account_id: accountId, amount_minor: amount })
  }
  return {
    category_id: categoryId,
    month,
    currency,
    budget_minor: budget,
    spent_minor: spent,
    left_minor: left,
    shares,
    occurrence_ids: lines.map((l) => l.id),
    missing_rates: [...missing].sort(),
  }
}

// One month's allowance lines netted per category; the Budget view and the walk both read this.
export function netAllowances(snapshot: Snapshot, month: string, lines: readonly Occurrence[], spend: ReadonlyMap<string, readonly Transaction[]>): CategoryBudget[] {
  const key = monthKey(month)
  const byCategory = new Map<string, Occurrence[]>()
  for (const line of lines) {
    if (line.flow !== 'allowance' || line.category_id === null || line.period.slice(0, 7) !== key) continue
    const list = byCategory.get(line.category_id)
    if (list) list.push(line)
    else byCategory.set(line.category_id, [line])
  }
  const rates = toRatesPerEur(snapshot.rates)
  return [...byCategory.keys()].sort().map((categoryId) => netCategory(snapshot, rates, categoryId, key, byCategory.get(categoryId) ?? [], spend.get(`${categoryId} ${key}`) ?? []))
}

export function categoryBudgets(snapshot: Snapshot, month: string, occurrences: readonly Occurrence[]): CategoryBudget[] {
  return netAllowances(snapshot, month, occurrences, taggedSpend(snapshot))
}
