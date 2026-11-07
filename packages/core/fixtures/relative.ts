import { addDays, addMonths, daysInMonth, firstOfMonth, monthKey } from '../src/dates'
import type { Rate } from '../src/rates'
import type { ImportDocInput } from '../src/schema/import-doc'

type Rows<K extends 'accounts' | 'categories' | 'plan_items' | 'statements' | 'transactions'> = NonNullable<ImportDocInput[K]>

export type AccountInput = Rows<'accounts'>[number]
export type PlanItemInput = Rows<'plan_items'>[number]
export type StatementInput = Rows<'statements'>[number]
export type TransactionInput = Rows<'transactions'>[number]

export interface SampleDoc {
  version: 1
  household: ImportDocInput['household']
  accounts: AccountInput[]
  categories: Rows<'categories'>
  plan_items: PlanItemInput[]
  statements: StatementInput[]
  transactions: TransactionInput[]
}

// A household in the import format plus made-up rates for its currencies.
export interface Sample {
  doc: SampleDoc
  rates: Rate[]
}

// Dates counted from asOf, so a sample reads the same on any day.
export function relativeTo(asOf: string) {
  const month0 = firstOfMonth(asOf)
  const first = (months: number) => addMonths(month0, months)
  const on = (months: number, day: number) => addDays(first(months), Math.min(day, daysInMonth(first(months))) - 1)
  return {
    first,
    on,
    month: (months: number) => monthKey(first(months)),
    // A row recorded this month never lands after asOf.
    done: (day: number) => (on(0, day) < asOf ? on(0, day) : asOf),
  }
}

export const link = (plan_item_id: string, period: string) => ({ plan_item_id, period })

export function row(id: string, account_id: string, posted_on: string, amount_minor: number, kind: TransactionInput['kind'], description: string, extra: Partial<TransactionInput> = {}): TransactionInput {
  return { id, account_id, posted_on, amount_minor, kind, description, ...extra }
}

// Both legs of a move between own accounts; a link rides on the outgoing leg.
export function transfer(id: string, description: string, out: [account: string, day: string, sent: number], into: [account: string, day: string, received: number], settles?: ReturnType<typeof link>): TransactionInput[] {
  return [
    row(`${id}-out`, out[0], out[1], -out[2], 'transfer', description, { transfer_id: id, ...settles }),
    row(`${id}-in`, into[0], into[1], into[2], 'transfer', description, { transfer_id: id }),
  ]
}
