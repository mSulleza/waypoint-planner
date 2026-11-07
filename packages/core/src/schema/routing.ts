import type { AccountKind, PlanItem, PlanItemKind, Transaction } from './rows'

export interface AccountRef {
  id: string
  kind: AccountKind
}

type ItemRoute = Pick<PlanItem, 'id' | 'kind' | 'from_account_id' | 'to_account_id'>
type Leg = Pick<Transaction, 'id' | 'kind' | 'account_id' | 'amount_minor' | 'transfer_id'>

const ITEM: Record<PlanItemKind, string> = { income: 'an income item', bill: 'a bill', allowance: 'an allowance', transfer: 'a transfer item', installment: 'an installment' }

function kindOf(id: string | null, accounts: readonly AccountRef[], field: string, errors: string[]): AccountKind | undefined {
  if (id === null) return undefined
  const found = accounts.find((a) => a.id === id)
  if (!found) errors.push(`${field}: no account '${id}'`)
  return found?.kind
}

// The check_plan_item trigger in schema.dbml: routing by account kind.
export function validatePlanItem(item: Omit<ItemRoute, 'id'>, accounts: readonly AccountRef[]): string[] {
  const errors: string[] = []
  const from = kindOf(item.from_account_id, accounts, 'from_account_id', errors)
  const to = kindOf(item.to_account_id, accounts, 'to_account_id', errors)
  if (errors.length > 0) return errors
  const fromCash = from === 'cash'
  switch (item.kind) {
    case 'income':
      if (from !== undefined || to === undefined) errors.push('income lands in a cash account or on a debt, from no account')
      break
    case 'bill':
    case 'allowance':
      if (to !== undefined || (!fromCash && from !== 'credit_card')) errors.push(`${ITEM[item.kind]} leaves a cash account or a card, to no account`)
      break
    case 'installment':
      if (to !== undefined || from !== 'credit_card') errors.push('an installment sits on a card, to no account')
      break
    case 'transfer':
      if (from !== undefined && to !== undefined) {
        if (!fromCash || to !== 'cash') errors.push("a transfer with both accounts moves cash to cash; one into a debt has no from account and leaves the debt's funded-from account")
      } else if (to !== undefined) {
        if (to === 'cash') errors.push('a transfer with no from account goes into a debt')
      } else if (from !== undefined) {
        if (!fromCash) errors.push('extra for debts leaves a cash account')
      } else errors.push('a transfer needs a from account, a to account or both')
      break
  }
  return errors
}

// The check_link trigger in schema.dbml: which row may settle which item, by account.
export function validateLink(tx: Leg, partner: Leg | null, item: ItemRoute, accounts: readonly AccountRef[]): string[] {
  if (item.kind === 'allowance') return ['an allowance settles by spending and takes no links']
  if (item.kind === 'installment') return ['an installment settles through statements and takes no links']
  if (item.kind === 'transfer' && item.to_account_id === null) return ['extra for debts is sized by the engine and takes no links']
  const errors: string[] = []
  switch (tx.kind) {
    case 'adjustment':
      errors.push('an adjustment never links')
      break
    case 'expense':
      if (item.kind !== 'bill') errors.push(`an expense links only to a bill, not to ${ITEM[item.kind]}`)
      else if (tx.account_id !== item.from_account_id) errors.push(`the expense must leave the bill's account '${item.from_account_id}'`)
      break
    case 'income':
    case 'refund':
    case 'drawdown':
      if (item.kind !== 'income') errors.push(`${tx.kind === 'income' ? 'income' : `a ${tx.kind}`} links only to an income item, not to ${ITEM[item.kind]}`)
      else if (tx.account_id !== item.to_account_id) errors.push(`the ${tx.kind} must land in the item's account '${item.to_account_id}'`)
      break
    case 'transfer':
      if (item.kind !== 'transfer') {
        errors.push(`a transfer links only to a transfer item, not to ${ITEM[item.kind]}`)
        break
      }
      if (tx.amount_minor > 0) errors.push('a transfer links by its outgoing (negative) leg')
      if (item.from_account_id !== null) {
        if (tx.account_id !== item.from_account_id) errors.push(`the outgoing leg must leave the item's account '${item.from_account_id}'`)
      } else {
        const kind = kindOf(tx.account_id, accounts, 'account_id', errors)
        if (kind !== undefined && kind !== 'cash') errors.push('the outgoing leg of a payment into a debt must leave a cash account')
      }
      if (!partner || partner.id === tx.id || partner.transfer_id !== tx.transfer_id) errors.push('the transfer needs its other leg')
      else if (partner.account_id !== item.to_account_id) errors.push(`the other leg must land in the item's account '${item.to_account_id}'`)
      break
  }
  return errors
}
