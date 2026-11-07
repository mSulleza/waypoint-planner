import { expandPlan, lastDayOfMonth, monthKey, plainNames, renderCopy, reviewList, snapshotIndex } from '@waypoint/core'
import { listOpenInput } from '@waypoint/core/agent'
import { amount, AMOUNTS, basis, DATA_TEXT, link, type ReadTool } from './shape'

// Core's open states: what is still expected, in full or in part (spec §6.6).
const OPEN = new Set(['due', 'overdue', 'late', 'unconfirmed', 'partly_settled'])

export const listOpen: ReadTool<typeof listOpenInput> = {
  name: 'list_open',
  description: [
    'What still needs settling, as the app’s To-do shows it: every plan occurrence dated on or before the end of through_month (default this month) that is due, overdue, late, unconfirmed or partly settled,',
    'with its open amount and the rows already linked to it; then every review item (money that should have arrived, a transaction that may settle an item, an overdue payment, a statement to enter or one whose figures differ),',
    'sorted by the day to act by. An occurrence is settled only by linking a transaction to it, skipping it, or a statement.',
    'Late is income whose date passed with less linked than planned: its open amount counts on carried_to, the first of the month after today’s, and moves on a month each month until a link settles it or it is skipped because it will not come;',
    'while a review item suggests a row for it, it counts nowhere. Unconfirmed is a planned draw onto a debt whose date passed; it counts nowhere.',
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: listOpenInput,
  run(world, args) {
    const { snapshot, walk } = world
    const through = args.through_month ?? monthKey(snapshot.as_of)
    const index = snapshotIndex(snapshot)
    const names = plainNames(snapshot)
    const last = lastDayOfMonth(through)
    const currencyOf = (id: string) => index.accounts.get(id)?.currency ?? snapshot.doc.household.base_currency
    const occurrences = expandPlan(snapshot)
      .occurrences.filter((o) => o.state !== null && OPEN.has(o.state) && !o.skipped && o.date <= last)
      .map((o) => {
        const currency = currencyOf(o.account_id)
        const item = index.planItems.get(o.plan_item_id)
        return {
          id: o.id,
          plan_item_id: o.plan_item_id,
          kind: o.kind,
          flow: o.flow,
          period: o.period,
          date: o.date,
          state: o.state,
          carried_to: o.carried_to,
          confidence: item?.confidence ?? null,
          account_id: o.account_id,
          to_account_id: o.to_account_id,
          category_id: o.category_id,
          amount: amount(o.amount_minor, currency),
          linked: amount(o.linked_minor, currency),
          open: amount(o.open_minor, currency),
          linked_row_ids: o.links.map((t) => t.id),
          data_text: { item: item?.name ?? o.plan_item_id },
        }
      })
    const review = reviewList(snapshot, walk).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      account_id: r.account_id,
      month: r.month,
      date: r.date,
      act_by: r.act_by,
      occurrence_id: r.occurrence_id,
      row_id: r.row_id,
      statement_id: r.statement_id,
      amount: r.amount && amount(r.amount.minor, r.amount.currency),
      data_text: { body: renderCopy(r.body, names) },
    }))
    return { basis: basis(world), through_month: through, occurrences, review, link: link(world, '/months', { month: through, view: 'todo' }) }
  },
}
