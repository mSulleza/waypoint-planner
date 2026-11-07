import { ledgerMonth, ledgerTotals, monthKey, snapshotIndex } from '@waypoint/core'
import { getLedgerInput } from '@waypoint/core/agent'
import { accountOf, accountRef, amount, AMOUNTS, basis, DATA_TEXT, link, type ReadTool } from './shape'

export const getLedger: ReadTool<typeof getLedgerInput> = {
  name: 'get_ledger',
  description: [
    'One account’s recorded rows for one month (default this month), oldest first, each with the balance after it, plus the month’s opening and closing balance and money in and out.',
    'This is the ledger alone, the bank’s side: compare its balances with the bank app. A card or loan reads negative while money is owed on it.',
    'Rows carry their ids, the plan occurrence they settle (plan_item_id and period), the transfer they belong to with the other leg’s account, the batch that saved them and the bank’s external id.',
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: getLedgerInput,
  run(world, args) {
    const { snapshot } = world
    const account = accountOf(snapshot, args.account_id)
    const month = args.month ?? monthKey(snapshot.as_of)
    const index = snapshotIndex(snapshot)
    const categories = new Map(snapshot.doc.categories.map((c) => [c.id, c.name]))
    const totals = ledgerTotals(snapshot, account.id, month)
    const money = (minor: number) => amount(minor, account.currency)
    const rows = ledgerMonth(snapshot, account.id, month).map((r) => {
      const other = r.transfer_id === null ? undefined : index.transfers.get(r.transfer_id)?.find((t) => t.id !== r.id)
      return {
        id: r.id,
        posted_on: r.posted_on,
        kind: r.kind,
        amount: money(r.amount_minor),
        balance_after: money(r.running_balance_minor),
        category_id: r.category_id,
        plan_item_id: r.plan_item_id,
        period: r.period,
        transfer_id: r.transfer_id,
        other_account_id: other?.account_id ?? null,
        batch_id: r.batch_id,
        external_id: r.external_id,
        data_text: { description: r.description, category: r.category_id === null ? null : (categories.get(r.category_id) ?? null) },
      }
    })
    return {
      basis: basis(world),
      account: accountRef(account),
      month,
      opening: money(totals.opening_minor),
      closing: money(totals.closing_minor),
      money_in: money(totals.in_minor),
      money_out: money(totals.out_minor),
      rows,
      link: link(world, `/money/${encodeURIComponent(account.id)}`, { month }),
    }
  },
}
