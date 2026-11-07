import { z } from 'zod'
import { monthKey } from '../dates'
import { currencyCode, docId, isoDay, isoMonth, minorUnits, rollRule, strictKeys, timestamp, uuid } from './common'
import { cardTerms, loanTerms } from './terms'

// Rows mirror schema.dbml; household_id and created_at stay out, as a document is one household's and created_at is write time.

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function isLocale(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1
  } catch {
    return false
  }
}

export const householdRow = strictKeys({
  base_currency: currencyCode,
  timezone: z.string().refine(isTimeZone, 'must be an IANA time zone such as Europe/Madrid'),
  locale: z.string().refine(isLocale, 'must be a BCP 47 tag such as en-PH'),
  payoff_order: z.enum(['avalanche', 'list']).default('avalanche'),
  track_from: isoDay,
})

export const floorWindow = strictKeys({
  from_month: isoMonth,
  to_month: isoMonth.nullable(),
  amount_minor: minorUnits.min(0, 'must not be negative'),
}).refine((w) => w.to_month === null || w.to_month >= w.from_month, { message: 'must not be before from_month', path: ['to_month'] })

const accountFields = {
  id: docId,
  name: z.string().min(1, 'must not be empty').max(40, 'must be at most 40 characters'),
  currency: currencyCode,
  opening_balance_minor: minorUnits.default(0),
  opening_date: isoDay,
  csv_mapping: z.record(z.string(), z.unknown()).nullable().default(null),
  sort_order: z.int().default(0),
  archived_at: timestamp.nullable().default(null),
}

const debtFields = {
  funded_from_account_id: z.string({ error: (issue) => (issue.input === undefined ? 'a debt needs the cash account that pays it' : undefined) }).min(1, 'must be a non-empty id'),
  floor_windows: z.array(floorWindow).max(0, 'floor windows are for cash accounts only').default([]),
  fx_fee_pct: z.null('fx_fee_pct is for cash accounts only').default(null),
}

function notSelfFunded(account: { id: string; funded_from_account_id: string | null }, ctx: z.RefinementCtx): void {
  if (account.funded_from_account_id === account.id) ctx.addIssue({ code: 'custom', message: 'an account cannot fund itself', path: ['funded_from_account_id'] })
}

export const cashAccountRow = strictKeys({
  ...accountFields,
  kind: z.literal('cash'),
  terms: z.null('terms are for credit cards and loans only').default(null),
  funded_from_account_id: docId.nullable().default(null),
  floor_windows: z.array(floorWindow).default([]),
  fx_fee_pct: z.number().min(0, 'must not be negative').lt(0.2, 'must be a fraction below 0.2, such as 0.007; percent and fraction never mix').nullable().default(null),
}).superRefine(notSelfFunded)

export const cardAccountRow = strictKeys({ ...accountFields, kind: z.literal('credit_card'), terms: cardTerms, ...debtFields }).superRefine(notSelfFunded)

export const loanAccountRow = strictKeys({ ...accountFields, kind: z.literal('loan'), terms: loanTerms, ...debtFields }).superRefine(notSelfFunded)

export const accountRow = z.discriminatedUnion('kind', [cashAccountRow, cardAccountRow, loanAccountRow])

export const categoryRow = strictKeys({
  id: docId,
  name: z.string().min(1, 'must not be empty').max(40, 'must be at most 40 characters'),
  archived_at: timestamp.nullable().default(null),
})

const TRANSACTION_KINDS = ['income', 'expense', 'refund', 'transfer', 'drawdown', 'adjustment'] as const

function transactionFields<I extends z.ZodType<string>>(id: I) {
  return {
    id,
    account_id: id,
    posted_on: isoDay,
    amount_minor: minorUnits.refine((n) => n !== 0, 'must not be 0'),
    kind: z.enum(TRANSACTION_KINDS),
    category_id: id.nullable().default(null),
    description: z.string().max(140, 'must be at most 140 characters').default(''),
    transfer_id: id.nullable().default(null),
    plan_item_id: id.nullable().default(null),
    period: isoDay.nullable().default(null),
    external_id: z.string().min(1, 'must not be empty').nullable().default(null),
  }
}

interface TransactionCore {
  kind: (typeof TRANSACTION_KINDS)[number]
  amount_minor: number
  category_id: string | null
  transfer_id: string | null
  plan_item_id: string | null
  period: string | null
}

function checkTransaction(t: TransactionCore, ctx: z.RefinementCtx): void {
  const issue = (message: string, field: keyof TransactionCore) => ctx.addIssue({ code: 'custom', message, path: [field] })
  if ((t.kind === 'income' || t.kind === 'refund' || t.kind === 'drawdown') && t.amount_minor < 0) issue(`${t.kind} is money in, so it must be positive`, 'amount_minor')
  if (t.kind === 'expense' && t.amount_minor > 0) issue('an expense is money out, so it must be negative', 'amount_minor')
  if (t.category_id !== null && t.kind !== 'expense' && t.kind !== 'refund') issue('only an expense or a refund takes a category', 'category_id')
  if (t.kind === 'transfer' && t.transfer_id === null) issue('a transfer needs the transfer_id its two legs share', 'transfer_id')
  if (t.kind !== 'transfer' && t.transfer_id !== null) issue('only a transfer has a transfer_id', 'transfer_id')
  if ((t.plan_item_id === null) !== (t.period === null)) issue('plan_item_id and period come together: both or neither', t.plan_item_id === null ? 'plan_item_id' : 'period')
  if (t.kind === 'transfer' && t.plan_item_id !== null && t.amount_minor > 0) issue('a transfer links by its outgoing (negative) leg', 'plan_item_id')
}

export const transactionRow = strictKeys({ ...transactionFields(docId), batch_id: docId.nullable().default(null) }).superRefine(checkTransaction)

// What post_batch takes: database ids, and the batch stamps batch_id on every row.
export const batchTransactionRow = strictKeys(transactionFields(uuid)).superRefine(checkTransaction)

const PLAN_ITEM_KINDS = ['income', 'bill', 'allowance', 'transfer', 'installment'] as const
const EVERY = ['once', 'week', '2weeks', 'month', 'quarter', 'year'] as const
// Months from one occurrence to the next, for an item counted in months from starts_on.
export const MONTHS_APART = { month: 1, quarter: 3, year: 12 } as const
const OUTGOING = { bill: 'a bill', allowance: 'an allowance', installment: 'an installment' } as const

export const planItemRow = strictKeys({
  id: docId,
  kind: z.enum(PLAN_ITEM_KINDS),
  name: z.string().min(1, 'must not be empty').max(60, 'must be at most 60 characters'),
  from_account_id: docId.nullable().default(null),
  to_account_id: docId.nullable().default(null),
  category_id: docId.nullable().default(null),
  amount_minor: minorUnits,
  every: z.enum(EVERY).default('month'),
  starts_on: isoDay,
  ends_on: isoDay.nullable().default(null),
  roll: rollRule.default('none'),
  confidence: z.enum(['committed', 'estimated', 'upside']).default('committed'),
  // A bill or allowance that would not be paid while income is stopped, such as tax on that income.
  stops_with_income: z.boolean().default(false),
  skip_periods: z.array(isoDay).default([]),
}).superRefine((p, ctx) => {
  const issue = (message: string, field: string) => ctx.addIssue({ code: 'custom', message, path: [field] })
  const from = p.from_account_id
  const to = p.to_account_id
  if (from !== null && from === to) issue('must differ from from_account_id', 'to_account_id')
  if (p.kind === 'transfer' && from === null && to === null) issue('a transfer needs a from account, a to account or both', 'from_account_id')
  if (p.kind === 'income' && from !== null) issue('income has no from account', 'from_account_id')
  if (p.kind === 'income' && to === null) issue('income needs the account it lands in', 'to_account_id')
  if (p.kind === 'bill' || p.kind === 'allowance' || p.kind === 'installment') {
    if (from === null) issue(`${OUTGOING[p.kind]} needs the account it leaves`, 'from_account_id')
    if (to !== null) issue(`${OUTGOING[p.kind]} has no to account`, 'to_account_id')
  }
  if (p.kind === 'allowance' && p.category_id === null) issue('an allowance needs the category it budgets', 'category_id')
  if (p.kind === 'allowance' && p.every === 'quarter') issue('an allowance is a monthly budget, so it never repeats every 3 months', 'every')
  if (p.kind !== 'allowance' && p.category_id !== null) issue('only an allowance takes a category', 'category_id')
  if (p.kind === 'allowance' ? p.amount_minor === 0 : p.amount_minor <= 0) issue(p.kind === 'allowance' ? 'must not be 0' : 'must be more than 0; only an allowance may be negative', 'amount_minor')
  if (p.ends_on !== null && p.ends_on < p.starts_on) issue('must not be before starts_on', 'ends_on')
  if (p.stops_with_income && p.kind !== 'bill' && p.kind !== 'allowance') issue('only a bill or an allowance takes it: income and transfers always stop with income, an installment never does', 'stops_with_income')
  if (p.kind === 'installment') {
    if (p.every !== 'month') issue('an installment bills every month', 'every')
    if (!p.starts_on.endsWith('-01')) issue('an installment starts on its first billed month, as the first of the month', 'starts_on')
    if (p.ends_on === null) issue('an installment needs its last billed month', 'ends_on')
    else if (!p.ends_on.endsWith('-01')) issue('an installment ends on its last billed month, as the first of the month', 'ends_on')
  }
})

const STATEMENT_PARTS = ['previous_balance_minor', 'payments_and_credits_minor', 'charges_minor', 'installments_minor', 'interest_minor', 'fees_minor'] as const

const part = minorUnits.min(0, 'must not be negative').nullable().default(null)

export const statementRow = strictKeys({
  id: docId,
  account_id: docId,
  cut_date: isoDay,
  due_date: isoDay,
  previous_balance_minor: minorUnits.nullable().default(null),
  payments_and_credits_minor: part,
  charges_minor: part,
  installments_minor: part,
  interest_minor: part,
  fees_minor: part,
  total_due_minor: minorUnits,
  minimum_due_minor: minorUnits.min(0, 'must not be negative'),
  available_credit_minor: minorUnits.nullable().default(null),
}).superRefine((s, ctx) => {
  if (s.due_date < s.cut_date) ctx.addIssue({ code: 'custom', message: 'must not be before cut_date', path: ['due_date'] })
  if (s.minimum_due_minor > Math.max(s.total_due_minor, 0)) ctx.addIssue({ code: 'custom', message: 'must not exceed the total due', path: ['minimum_due_minor'] })
  const missing = STATEMENT_PARTS.filter((key) => s[key] === null)
  if (missing.length > 0 && missing.length < STATEMENT_PARTS.length) {
    ctx.addIssue({ code: 'custom', message: `the six parts come together or not at all; missing ${missing.join(', ')}`, path: [missing[0] ?? 'total_due_minor'] })
    return
  }
  const gap = statementGap(s)
  if (gap !== null && gap !== 0) {
    const sum = s.total_due_minor - gap
    ctx.addIssue({ code: 'custom', message: `previous − payments and credits + charges + installments + interest + fees = ${sum}, but total_due_minor is ${s.total_due_minor}: off by ${gap}`, path: ['total_due_minor'] })
  }
})

export type Household = z.output<typeof householdRow>
export type FloorWindow = z.output<typeof floorWindow>
export type Account = z.output<typeof accountRow>
export type CashAccount = z.output<typeof cashAccountRow>
export type CardAccount = z.output<typeof cardAccountRow>
export type LoanAccount = z.output<typeof loanAccountRow>
export type AccountKind = Account['kind']
export type Category = z.output<typeof categoryRow>
export type Transaction = z.output<typeof transactionRow>
export type BatchTransaction = z.output<typeof batchTransactionRow>
export type TransactionKind = Transaction['kind']
export type PlanItem = z.output<typeof planItemRow>
export type PlanItemKind = PlanItem['kind']
export type Statement = z.output<typeof statementRow>

// total_due − (previous − payments and credits + charges + installments + interest + fees); null for a total-only statement.
export function statementGap(s: Pick<Statement, (typeof STATEMENT_PARTS)[number] | 'total_due_minor'>): number | null {
  const { previous_balance_minor: previous, payments_and_credits_minor: paid, charges_minor: charges, installments_minor: installments, interest_minor: interest, fees_minor: fees } = s
  if (previous === null || paid === null || charges === null || installments === null || interest === null || fees === null) return null
  return s.total_due_minor - (previous - paid + charges + installments + interest + fees)
}

// In a month the floor is the smallest covering window and the target the largest, both 0 with none.
export function floorAndTarget(windows: readonly FloorWindow[], month: string): { floor: number; target: number } {
  const key = monthKey(month)
  const covering = windows.filter((w) => w.from_month <= key && (w.to_month === null || key <= w.to_month)).map((w) => w.amount_minor)
  return covering.length === 0 ? { floor: 0, target: 0 } : { floor: Math.min(...covering), target: Math.max(...covering) }
}
