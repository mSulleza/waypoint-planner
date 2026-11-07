import { alerts, budgetRows, debtFigures, dropSameSubject, fxBreakeven, nextAction, plainNames, renderCopy, reviewList, walkMetrics, type Milestone } from '@waypoint/core'
import { getOverviewInput } from '@waypoint/core/agent'
import { AgentError } from '../../errors'
import { accountRef, amount, AMOUNTS, basis, bySortOrder, DATA_TEXT, link, type ReadTool } from './shape'

const milestone = (m: Milestone) => ({ month: m.month, last_owed_month: m.last_owed_month, after_horizon: m.after_horizon })

export const getOverview: ReadTool<typeof getOverviewInput> = {
  name: 'get_overview',
  description: [
    'The household today, as the app’s Today and Plan screens show it: every account with its id; the next action with its prefilled amounts and act_by, which is after today when the earliest top-up or card payment of the month can be done early;',
    'each cash account’s live balance (opening plus every row to today), month-end balance and month word, its lowest balance to the end of the projection and that day, and days under its floor and target;',
    'the FX margin and breakeven rates (null in a one-currency household); the revolving-cleared and debt-free months; and total debt per currency.',
    'alert is the worst alert Today shows, left out when it is about the next action’s own account and month, with how many more Months > To-do lists; null when there is none or the breakeven did not load.',
    'Today never says “Nothing to do now” above an alert or a Short or Tight account: when next_action.kind is none and either holds, lead with the alert.',
    'One export of the household and the day’s ECB rates, walked by the same engine as the app.',
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: getOverviewInput,
  async run(world) {
    const { snapshot, walk } = world
    const names = plainNames(snapshot)
    const review = reviewList(snapshot, walk)
    const action = nextAction({ snapshot, walk, review })
    const metrics = walkMetrics(snapshot, walk)
    const figures = debtFigures(snapshot, walk)
    const breakeven = await fxBreakeven(snapshot)
    // Today's alert line: core's alerts less the one about the next action's own subject.
    const loaded = breakeven === null || breakeven.ok ? breakeven : undefined
    const left = loaded === undefined ? [] : dropSameSubject(alerts({ snapshot, walk, review, breakeven: loaded, budgets: budgetRows(snapshot) }), action)
    const worst = left[0]
    const prefill = action.prefill
    const accounts = [...snapshot.doc.accounts].sort(bySortOrder)
    const cash = accounts
      .filter((a) => a.kind === 'cash' && a.archived_at === null)
      .map((a) => {
        const month = walk.figures.get(a.id)?.[0]
        const live = walk.start.get(a.id)
        const m = metrics.cash.find((c) => c.account_id === a.id)
        if (!month || live === undefined || !m) throw new AgentError(`The walk has no figures for account '${a.id}'.`)
        return {
          account_id: a.id,
          currency: a.currency,
          data_text: { name: a.name },
          live: amount(live, a.currency),
          month_end: amount(month.closing_minor, a.currency),
          month_word: month.word,
          floor_set: month.floor_set,
          lowest: amount(m.lowest_minor, a.currency),
          lowest_on: m.lowest_on,
          days_under_floor: m.days_under_floor,
          days_under_target: m.days_under_target,
          first_below_zero_on: m.first_below_zero_on,
        }
      })
    const fx =
      breakeven === null
        ? null
        : !breakeven.ok
          ? { problem: breakeven.errors.map((e) => e.message).join(' ') }
          : {
              funding_currency: breakeven.funding_currency,
              margin: breakeven.margin,
              multiplier: breakeven.multiplier,
              below_range: breakeven.below_range,
              rates: breakeven.rates,
              binding: breakeven.binding,
              below_zero_at_any_rate: breakeven.rate_independent,
            }
    return {
      basis: basis(world),
      accounts: accounts.map(accountRef),
      next_action: {
        kind: action.kind,
        act_by: action.act_by,
        review_id: action.review_id,
        prefill: prefill && {
          from_account_id: prefill.from_account_id,
          to_account_id: prefill.to_account_id,
          sent: prefill.sent && amount(prefill.sent.minor, prefill.sent.currency),
          received: prefill.received && amount(prefill.received.minor, prefill.received.currency),
        },
        data_text: { title: renderCopy(action.title, names), context: renderCopy(action.context, names) },
      },
      alert: worst ? { id: worst.id, kind: worst.kind, severity: worst.severity, act_by: worst.act_by, more: left.length - 1, data_text: { title: worst.title, body: renderCopy(worst.body, names) } } : null,
      cash,
      fx,
      debts: {
        revolving_cleared: milestone(metrics.revolving_cleared),
        debt_free: milestone(metrics.debt_free),
        total_debt: figures.total_debt.map((t) => amount(t.minor, t.currency)),
      },
      link: link(world, '/'),
    }
  },
}
