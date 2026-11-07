import { z } from 'zod'
import { LINK_MAX_LEVERS } from './compare-levers'
import { minorDigits } from './money'
import { docId, isoDay, isoMonth, rollRule, strictKeys, uuid } from './schema/common'
import { patchSchema } from './schema/patch'
import { batchTransactionRow, planItemRow } from './schema/rows'

// The agent's read tools (spec §9); like every input, an unknown key is refused by name (rule 207).
export const getOverviewInput = strictKeys({})
export const listOpenInput = strictKeys({ through_month: isoMonth.optional() })
export const listPlanInput = strictKeys({ include_ended: z.boolean().optional() })
export const getLedgerInput = strictKeys({ account_id: docId, month: isoMonth.optional() })
export const getDebtInput = strictKeys({ account_id: docId })

export type ListOpenInput = z.output<typeof listOpenInput>
export type ListPlanInput = z.output<typeof listPlanInput>
export type GetLedgerInput = z.output<typeof getLedgerInput>
export type GetDebtInput = z.output<typeof getDebtInput>

// The agent writes amounts as decimal text, read once in the account's currency (rule 15).
export const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string such as -12.40: an optional minus, digits and a dot, with no grouping or currency sign')

// Whole minor units of the currency; null when the text is not decimal text, has more decimals than the currency takes, or is too large.
export function decimalMinor(text: string, currency: string): number | null {
  const found = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!found) return null
  const digits = minorDigits(currency)
  const [, sign = '', whole = '0', fraction = ''] = found
  if (/[1-9]/.test(fraction.slice(digits))) return null
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.slice(0, digits).padEnd(digits, '0') || '0')
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null
  if (minor === 0n) return 0
  return sign === '-' ? -Number(minor) : Number(minor)
}

// One row of post_batch's input with its amount as decimal text; a missing id is made from the batch id and the row's place, so the same call makes the same ids.
const batchRow = strictKeys({
  id: uuid.optional(),
  account_id: uuid,
  posted_on: isoDay,
  amount: decimalText,
  kind: batchTransactionRow.shape.kind,
  category_id: uuid.nullable().optional(),
  description: z.string().max(140, 'must be at most 140 characters').optional(),
  transfer_id: uuid.nullable().optional(),
  plan_item_id: uuid.nullable().optional(),
  period: isoDay.nullable().optional(),
  external_id: z.string().min(1, 'must not be empty').nullable().optional(),
})

const expected = z.record(uuid, decimalText)

export const postTransactionsInput = strictKeys({
  batch_id: uuid,
  rows: z.array(batchRow).min(1, 'must hold at least one row'),
  expect_before: expected.optional(),
  expect_after: expected.optional(),
  allow_over: z.boolean().optional(),
})

export const deleteTransactionsInput = strictKeys({
  ids: z.array(uuid).min(1, 'must name at least one row').optional(),
  batch_id: uuid.optional(),
}).superRefine((d, ctx) => {
  if ((d.ids === undefined) === (d.batch_id === undefined)) ctx.addIssue({ code: 'custom', message: 'give ids or batch_id, one of the two', path: [] })
})

export const LINK_ACTIONS = ['link', 'unlink', 'skip', 'unskip'] as const
const LINK_FIELDS = ['row_id', 'plan_item_id', 'period'] as const
const LINK_NEEDS: Record<(typeof LINK_ACTIONS)[number], readonly (typeof LINK_FIELDS)[number][]> = {
  link: ['row_id', 'plan_item_id', 'period'],
  unlink: ['row_id'],
  skip: ['plan_item_id', 'period'],
  unskip: ['plan_item_id', 'period'],
}

export const setLinkInput = strictKeys({
  action: z.enum(LINK_ACTIONS),
  row_id: uuid.optional(),
  plan_item_id: uuid.optional(),
  period: isoDay.optional(),
}).superRefine((s, ctx) => {
  const needs = LINK_NEEDS[s.action] ?? []
  for (const field of LINK_FIELDS) {
    const given = s[field] !== undefined
    if (needs.includes(field) && !given) ctx.addIssue({ code: 'custom', message: `${s.action} needs ${field}`, path: [field] })
    if (!needs.includes(field) && given) ctx.addIssue({ code: 'custom', message: `${s.action} takes no ${field}`, path: [field] })
  }
})

// A new item takes every field its kind needs; an update takes only what changes; change_from starts the change in that month (split_plan_item).
export const upsertPlanItemInput = strictKeys({
  id: uuid.optional(),
  kind: planItemRow.shape.kind.optional(),
  name: planItemRow.shape.name.optional(),
  from_account_id: uuid.nullable().optional(),
  to_account_id: uuid.nullable().optional(),
  category_id: uuid.nullable().optional(),
  amount: decimalText.optional(),
  every: planItemRow.shape.every.unwrap().optional(),
  starts_on: isoDay.optional(),
  ends_on: isoDay.nullable().optional(),
  roll: rollRule.optional(),
  confidence: planItemRow.shape.confidence.unwrap().optional(),
  stops_with_income: z.boolean().optional(),
  change_from: isoMonth.optional(),
  day: z.int().min(1, 'must be a day of the month, 1 to 31').max(31, 'must be a day of the month, 1 to 31').optional(),
}).superRefine((p, ctx) => {
  const issue = (message: string, field: string) => ctx.addIssue({ code: 'custom', message, path: [field] })
  if (p.change_from === undefined) {
    if (p.day !== undefined) issue('day moves an item from a month on; add change_from, or change starts_on', 'day')
    return
  }
  if (p.id === undefined) issue('change_from changes an item already in the plan; add its id', 'id')
  if (p.kind !== undefined) issue('change_from keeps the kind', 'kind')
  if (p.starts_on !== undefined) issue('change_from keeps the first date; give day to move the day from that month', 'starts_on')
})

const printed = decimalText.nullable().optional()

// A card statement as printed, amounts as decimal text in the card's currency; the six parts come together or not at all.
export const addStatementInput = strictKeys({
  id: uuid.optional(),
  account_id: uuid,
  cut_date: isoDay,
  due_date: isoDay,
  previous_balance: printed,
  payments_and_credits: printed,
  charges: printed,
  installments: printed,
  interest: printed,
  fees: printed,
  total_due: decimalText,
  minimum_due: decimalText,
  available_credit: printed,
})

// Compare's levers as core patches, each with the words a row and the link show for it.
export const compareInput = strictKeys({
  patches: z
    .array(strictKeys({ label: z.string().min(1, 'must not be empty').max(300, 'must be at most 300 characters'), patch: patchSchema }))
    .min(1, 'must hold at least one patch')
    .max(LINK_MAX_LEVERS, `must hold at most ${LINK_MAX_LEVERS} patches, as a Compare link does`),
})

export type PostTransactionsInput = z.output<typeof postTransactionsInput>
export type DeleteTransactionsInput = z.output<typeof deleteTransactionsInput>
export type SetLinkInput = z.output<typeof setLinkInput>
export type UpsertPlanItemInput = z.output<typeof upsertPlanItemInput>
export type AddStatementInput = z.output<typeof addStatementInput>
export type CompareInput = z.output<typeof compareInput>
