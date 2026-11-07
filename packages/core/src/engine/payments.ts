import { grossFor, netOf } from '../money'
import type { CardTerms } from '../schema/terms'
import { snapshotIndex, type Snapshot } from '../snapshot'
import type { CardPayer, CardStatement, PayContext } from './cards'
import type { Conversion } from './debts'
import { expandPlan } from './events'
import type { ExpandedPlan, Occurrence } from './types'

// Nothing due is a real zero for the cycle; paid means payments since the cut already cover it.
export type PaymentState = 'nothing_due' | 'paid' | 'to_pay'

// One cycle's payment figures (spec §6.4), defined once: the walk pays left_to_pay_minor, and Today, the Pay sheet and the agent read these and never subtract again.
export interface PaymentFigures {
  // The pay mode's base, never below 0.
  base_minor: number
  // Transfer items into the card in the cut's month, less what linked payments posted on or before the cut already put on the statement, in the card's currency.
  items_minor: number
  // The card's share of extra for debts, in its own currency.
  extra_minor: number
  // What is owed before this cycle's payments: the total plus charges, less credits that are not payments, since the cut.
  cap_minor: number
  planned_gross_minor: number
  // Recorded payments since the cut by their card leg, in transit included.
  paid_minor: number
  // All the walk sends in the cycle: on the pay day, less extra offered before it, plus extra offered after it.
  left_to_pay_minor: number
  state: PaymentState
}

// in_full pays the total, minimum the minimum, installments_plus the larger of the minimum and the cycle's installments.
export function paymentBase(mode: CardTerms['pay']['mode'], statement: Pick<CardStatement, 'total_due_minor' | 'minimum_due_minor' | 'installments_minor'>): number {
  const base = mode === 'in_full' ? statement.total_due_minor : mode === 'minimum' ? statement.minimum_due_minor : Math.max(statement.minimum_due_minor, statement.installments_minor)
  return Math.max(0, base)
}

export function paymentFigures(context: PayContext): PaymentFigures {
  const { card, statement, charges_minor, credits_minor, paid_minor, items_minor, extra_minor } = context
  const base = paymentBase(card.terms.pay.mode, statement)
  const cap = statement.total_due_minor + charges_minor - credits_minor
  const gross = Math.max(0, Math.min(cap, base + items_minor + extra_minor))
  const left = Math.max(0, gross - paid_minor)
  return {
    base_minor: base,
    items_minor,
    extra_minor,
    cap_minor: cap,
    planned_gross_minor: gross,
    paid_minor,
    left_to_pay_minor: left,
    state: gross === 0 ? 'nothing_due' : left === 0 ? 'paid' : 'to_pay',
  }
}

// The walk's payer: left to pay on the pay day, less extra the model already sent in the cycle, which PayContext counts as paid.
export const payLeft: CardPayer = (context) => paymentFigures(context).left_to_pay_minor

export interface CycleItems {
  // In the card's currency: what the counted items land once converted from the paying account.
  amount_minor: number
  // The occurrences that still count something.
  occurrence_ids: readonly string[]
}

const itemLists = new WeakMap<ExpandedPlan, Map<string, Occurrence[]>>()

// Each debt's transfer items by `<debt>|<YYYY-MM>` of their scheduled day, skipped periods left out, once per plan.
function itemsOf(plan: ExpandedPlan, debtId: string, month: string): readonly Occurrence[] {
  let byKey = itemLists.get(plan)
  if (!byKey) {
    byKey = new Map()
    for (const o of plan.occurrences) {
      if (o.flow !== 'debt_transfer' || o.skipped) continue
      const key = `${o.account_id}|${o.scheduled_on.slice(0, 7)}`
      const list = byKey.get(key)
      if (list) list.push(o)
      else byKey.set(key, [o])
    }
    itemLists.set(plan, byKey)
  }
  return byKey.get(`${debtId}|${month}`) ?? []
}

// Transfer items into a card whose occurrence falls in its cycle's month, at their full amount in the paying account's currency, less linked payments whose card leg posted on or before the cut, then converted to the card's currency.
export function cycleItems(snapshot: Snapshot, cardId: string, cut: string, month: string, conversion: Conversion): CycleItems {
  const { accounts, transfers } = snapshotIndex(snapshot)
  const card = accounts.get(cardId)
  const funder = card?.funded_from_account_id ? accounts.get(card.funded_from_account_id) : undefined
  let sent = 0
  const ids: string[] = []
  for (const o of itemsOf(expandPlan(snapshot), cardId, month)) {
    let before = 0
    for (const link of o.links) {
      const leg = link.transfer_id === null ? undefined : transfers.get(link.transfer_id)?.find((t) => t.account_id === cardId)
      if (!leg || leg.posted_on > cut) continue
      // The linked row is the outgoing cash leg; one in another currency counts as what its card leg landed, sent back at the walk's rate.
      before += accounts.get(link.account_id)?.currency === funder?.currency ? 0 - link.amount_minor : grossFor(leg.amount_minor, conversion.rate, conversion.feePct)
    }
    const counted = Math.max(0, o.amount_minor - before)
    if (counted === 0) continue
    sent += counted
    ids.push(o.id)
  }
  return { amount_minor: netOf(sent, conversion.rate, conversion.feePct), occurrence_ids: ids }
}
