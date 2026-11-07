import type { Account } from '../schema/rows'
import type { Snapshot } from '../snapshot'
import type { DebtMoveKind, EngineEvent, ExpandedPlan } from './types'

// A movement a debt module makes on one of its debts; the walk posts it and, for a payment, the cash leg too.
export interface DebtMove {
  id: string
  kind: DebtMoveKind
  // Payments and a loan's interest are class 4; card cut postings such as interest class 5.
  order: 4 | 5
  date: string
  account_id: string
  // A payment leaves the debt's funded-from account; null for a posting on the debt alone.
  from_account_id: string | null
  // Signed as it moves the debt, in its currency: a payment is positive, interest negative.
  amount_minor: number
  overdue: boolean
  occurrence_ids: readonly string[]
}

// The rate and source fee money crosses from a debt's funded-from account to the debt, in minor units.
export interface Conversion {
  rate: number
  feePct: number
}

// Extra for debts on its way down a payoff order: what one debt did not need, offered to the next on the same day.
export interface ExtraOffer {
  // The debt it is offered to.
  account_id: string
  from_account_id: string
  day: string
  // In the funding account's currency: the most the debt may receive is what this sends.
  amount_minor: number
  // The extra-for-debts occurrences the money comes from.
  occurrence_ids: readonly string[]
}

export interface DebtInput {
  snapshot: Snapshot
  plan: ExpandedPlan
  // The walked days, as_of first.
  days: readonly string[]
  // This module's debts, in id order.
  accounts: readonly Account[]
  // Events on those debts in walk order, card charges dated before as_of first.
  events: readonly EngineEvent[]
  // What a payment of `amount` puts on the debt once the walk sends its gross from the funded-from account.
  landed(debtId: string, amount: number): number
  // The rate and source fee a payment crosses from the debt's funded-from account.
  conversion(debtId: string): Conversion
  // Extra passed down to these debts by debts of the other kind.
  offers: readonly ExtraOffer[]
}

export interface DebtOutput {
  // Every move dated within the walked days.
  moves: readonly DebtMove[]
  // What the module keeps for screens: statements, cycles, schedules.
  summary: unknown
  // Extra its debts did not need, offered to the next debt in payoff order when that debt is of the other kind.
  overflow?: readonly ExtraOffer[]
}

// Debts never read cash balances, since only top-ups do (spec §6.2), so each module walks its debts before the cash walk.
export interface DebtModule<K extends 'credit_card' | 'loan'> {
  readonly kind: K
  walk(input: DebtInput): DebtOutput
}

export type CardModule = DebtModule<'credit_card'>
export type LoanModule = DebtModule<'loan'>

const idle = (): DebtOutput => ({ moves: [], summary: null })

// Debts still take their events, but nothing is paid, cut or charged interest.
export const NO_CARDS: CardModule = Object.freeze({ kind: 'credit_card', walk: idle })
export const NO_LOANS: LoanModule = Object.freeze({ kind: 'loan', walk: idle })
