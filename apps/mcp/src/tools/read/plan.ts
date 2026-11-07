import { monthKey, type PlanItem } from '@waypoint/core'
import { listPlanInput } from '@waypoint/core/agent'
import { amount, AMOUNTS, basis, countedIn, DATA_TEXT, link, type ReadTool } from './shape'

const KIND_ORDER: readonly PlanItem['kind'][] = ['income', 'bill', 'allowance', 'transfer', 'installment']

// Before this month: a one-off whose month has passed, or an item whose end month has.
export function ended(item: PlanItem, asOf: string): boolean {
  const now = monthKey(asOf)
  if (item.every === 'once') return monthKey(item.starts_on) < now
  return item.ends_on !== null && monthKey(item.ends_on) < now
}

export const listPlan: ReadTool<typeof listPlanInput> = {
  name: 'list_plan',
  description: [
    'Every plan item by kind (income, bills, budgets, transfers, installments) with its accounts, amount, schedule, confidence, whether it stops with income and skipped periods, and the categories with their ids.',
    'Items that ended before this month are left out unless include_ended is true.',
    'A transfer item with no to account is extra for debts; one with no from account pays a card or loan from its funded-from account, in the debt’s currency.',
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: listPlanInput,
  run(world, args) {
    const { snapshot } = world
    const asOf = snapshot.as_of
    const items = snapshot.doc.plan_items
      .filter((i) => args.include_ended === true || !ended(i, asOf))
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.starts_on < b.starts_on ? -1 : a.starts_on > b.starts_on ? 1 : a.id < b.id ? -1 : 1))
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        from_account_id: i.from_account_id,
        to_account_id: i.to_account_id,
        category_id: i.category_id,
        amount: amount(i.amount_minor, countedIn(snapshot, i)),
        every: i.every,
        starts_on: i.starts_on,
        ends_on: i.ends_on,
        roll: i.roll,
        confidence: i.confidence,
        stops_with_income: i.stops_with_income,
        skip_periods: i.skip_periods,
        ended: ended(i, asOf),
        data_text: { name: i.name },
      }))
    const categories = snapshot.doc.categories.map((c) => ({ id: c.id, archived: c.archived_at !== null, data_text: { name: c.name } }))
    return { basis: basis(world), items, categories, link: link(world, '/plan') }
  },
}
