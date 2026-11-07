import { z } from 'zod'
import { checkInput, docId, isoDay, isoMonth, minorUnits, strictKeys, type Checked } from './common'
import { floorWindow, planItemRow } from './rows'

// amount_minor and day apply from from_month by ending the row and adding a copy, as split_plan_item does.
export const itemPatch = strictKeys({
  amount_minor: minorUnits.refine((n) => n !== 0, 'must not be 0').optional(),
  day: z.int().min(1, 'must be a day of the month, 1 to 31').max(31, 'must be a day of the month, 1 to 31').optional(),
  from_month: isoMonth.optional(),
  ends_on: isoDay.nullable().optional(),
  removed: z.boolean().optional(),
  include_upside: z.boolean().optional(),
}).superRefine((p, ctx) => {
  const changes = p.amount_minor !== undefined || p.day !== undefined
  if (changes && p.from_month === undefined) ctx.addIssue({ code: 'custom', message: 'amount_minor and day apply from a month; add from_month', path: ['from_month'] })
  if (!changes && p.from_month !== undefined) ctx.addIssue({ code: 'custom', message: 'from_month needs amount_minor or day', path: ['from_month'] })
  if (p.removed === true && Object.keys(p).length > 1) ctx.addIssue({ code: 'custom', message: 'a removed item takes no other change', path: ['removed'] })
})

// fx_shift_pct is a fraction: −0.1 makes the funding currency worth 10% less.
export const patchSchema = strictKeys({
  fx_shift_pct: z.number().gt(-1, 'must be a fraction above −1, such as −0.1 for 10% weaker').lt(1, 'must be a fraction below 1, such as 0.1 for 10% stronger').optional(),
  items: z.record(docId, itemPatch).optional(),
  add: z.array(planItemRow).optional(),
  accounts: z.record(docId, strictKeys({ floor_windows: z.array(floorWindow) })).optional(),
  income_gap: strictKeys({
    from_month: isoMonth,
    months: z.int().min(1, 'must be 1 to 60').max(60, 'must be 1 to 60'),
    item_ids: z.array(docId).min(1, 'must name at least one item, or be left out to stop every income item').optional(),
  }).optional(),
})

export type ItemPatch = z.output<typeof itemPatch>
export type Patch = z.output<typeof patchSchema>

// Lenient on shape (JSON text, or the levers wrapped in {patch}) and strict on content, with every error at once.
export function parsePatch(input: unknown): Checked<Patch> {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (error) {
      return { ok: false, errors: [`bad_json: ${error instanceof Error ? error.message : String(error)}`] }
    }
  }
  if (value === undefined) return { ok: true, value: {} }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && 'patch' in value) value = value.patch
  return checkInput(patchSchema, value)
}
