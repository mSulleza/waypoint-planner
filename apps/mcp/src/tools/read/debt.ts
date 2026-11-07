import { anchorStatement, cardsOf, debtFigures, debtPayoffs, installmentProgress, loansOf, nextLoanPayment, snapshotIndex, walkMetrics, type CardStatement, type PaymentFigures } from '@waypoint/core'
import { getDebtInput } from '@waypoint/core/agent'
import { AgentError } from '../../errors'
import { accountOf, accountRef, amount, AMOUNTS, basis, DATA_TEXT, link, type ReadTool } from './shape'

// The statements after the current one that the answer lists, as Debt detail does.
export const NEXT_CYCLES = 6

export const getDebt: ReadTool<typeof getDebtInput> = {
  name: 'get_debt',
  description: [
    'One card or loan as the app’s Debt detail shows it, with core’s payment figures.',
    'A card: owed, remaining due on the current statement, unbilled installments and total debt; the current statement (provisional when its cut has passed with no statement entered: enter it before paying, because a payment is measured from the latest entered statement);',
    'this cycle’s payment (base, transfer items, extra, cap, recorded paid, left_to_pay, state and pay_on; pay left_to_pay and never subtract again); installments; the next statements the plan builds; interest; payoff month.',
    'A loan: owed, the scheduled payment and day, the next payment still to make, interest and payoff.',
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: getDebtInput,
  run(world, args) {
    const { snapshot, walk } = world
    const account = accountOf(snapshot, args.account_id)
    if (account.kind === 'cash') throw new AgentError(`'${account.id}' is a cash account; get_debt takes a card or a loan. get_ledger shows a cash account.`)
    const money = (minor: number) => amount(minor, account.currency)
    const payoff = debtPayoffs(snapshot, walk).get(account.id) ?? null
    const interest = walkMetrics(snapshot, walk).interest.find((i) => i.account_id === account.id)
    const common = {
      basis: basis(world),
      account: accountRef(account),
      funded_from_account_id: account.funded_from_account_id,
      payoff: payoff && { month: payoff.month, last_owed_month: payoff.last_owed_month, after_horizon: payoff.after_horizon },
      interest_to_horizon: money(interest?.interest_to_horizon_minor ?? 0),
      interest_after_horizon: money(interest?.interest_after_horizon_minor ?? 0),
      link: link(world, `/debts/${encodeURIComponent(account.id)}`),
    }

    if (account.kind === 'loan') {
      const schedule = loansOf(walk)?.get(account.id)
      if (!schedule) throw new AgentError(`The walk has no schedule for loan '${account.id}'.`)
      const next = nextLoanPayment(schedule, snapshot.as_of)
      return {
        ...common,
        owed: money(schedule.owed_minor),
        annual_rate: account.terms.annual_rate,
        payment: money(account.terms.payment_minor),
        payment_day: account.terms.payment_day,
        next_payment: next && { on: next.on, due: money(next.due_minor), paid: money(next.paid_minor), left: money(next.left_minor), interest: money(next.interest_minor), overdue: next.overdue },
        paid_off_on: schedule.payoff.on,
      }
    }

    const replay = cardsOf(walk)?.get(account.id)
    const figures = debtFigures(snapshot, walk).cards.find((c) => c.account_id === account.id)
    if (!replay || !figures) throw new AgentError(`The walk has no replay for card '${account.id}'.`)
    const current = replay.statements.find((s) => s.id === replay.current_id)
    if (!current) throw new AgentError(`The card replay lost its current statement '${replay.current_id}'.`)
    const entered = anchorStatement(snapshot, account.id)
    const items = snapshotIndex(snapshot).planItems
    const statement = (s: CardStatement) => ({
      id: s.id,
      source: s.source,
      provisional: s.provisional,
      cut_date: s.cut_date,
      due_date: s.due_date,
      total: money(s.total_due_minor),
      minimum: money(s.minimum_due_minor),
      installments: money(s.installments_minor),
      revolving: money(s.revolving_minor),
    })
    const payment = (p: PaymentFigures | null) =>
      p && {
        state: p.state,
        base: money(p.base_minor),
        items: money(p.items_minor),
        extra: money(p.extra_minor),
        cap: money(p.cap_minor),
        planned_gross: money(p.planned_gross_minor),
        paid: money(p.paid_minor),
        left_to_pay: money(p.left_to_pay_minor),
      }
    return {
      ...common,
      owed: money(figures.owed_minor),
      remaining_due: money(figures.remaining_due_minor),
      unbilled_installments: money(figures.unbilled_installments_minor),
      total_debt: money(figures.total_debt_minor),
      over_limit: figures.over_limit,
      available_credit: figures.available_credit_minor === null ? null : money(figures.available_credit_minor),
      latest_entered_statement_id: entered?.id ?? null,
      current_statement: statement(current),
      this_cycle: { pay_on: figures.pay_on, payment: payment(figures.payment) },
      installments: installmentProgress(snapshot, walk, account.id).map((i) => ({
        plan_item_id: i.plan_item_id,
        amount: money(i.amount_minor),
        billed: i.billed,
        total: i.total,
        first_month: i.first_month,
        last_month: i.last_month,
        unbilled: money(i.unbilled_minor),
        data_text: { name: items.get(i.plan_item_id)?.name ?? i.plan_item_id },
      })),
      next_statements: replay.statements
        .filter((s) => s.cut_date > current.cut_date)
        .slice(0, NEXT_CYCLES)
        .map((s) => ({ ...statement(s), pay_on: s.pay_on, interest: money(s.model?.interest_minor ?? 0), payment: payment(s.payment) })),
    }
  },
}
