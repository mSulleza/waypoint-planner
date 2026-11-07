import { addMonths, firstOfMonth, lastDayOfMonth, monthKey } from '../dates'
import type { ImportDoc } from '../schema/import-doc'
import type { Patch } from '../schema/patch'
import { buildSnapshot, snapshotIndex, type Snapshot } from '../snapshot'
import { cardModule, type CardPayer } from './cards'
import type { CardModule, LoanModule } from './debts'
import { expandPlan } from './events'
import { yieldToScreen } from './fx-breakeven'
import { LOANS } from './loans'
import { itemSchedule } from './occurrences'
import { paymentFigures, payLeft } from './payments'
import type { WalkFailure } from './types'
import { firstBelowZero, type BelowZero, type BelowZeroResult } from './walk'

export type IncomeGap = NonNullable<Patch['income_gap']>

const monthIndex = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1

// The gap's first and last day: from the first of from_month to the end of its last month.
export function gapDays(gap: IncomeGap): { from: string; to: string } {
  const from = firstOfMonth(gap.from_month)
  return { from, to: lastDayOfMonth(addMonths(from, gap.months - 1)) }
}

// The plan with the income_gap lever applied: income items (every one, planned draws included, or item_ids), every transfer item, extra for debts included, and every item that stops with income skip their periods in the gap.
export function incomeGapDoc(snapshot: Snapshot, gap: IncomeGap): ImportDoc {
  const index = snapshotIndex(snapshot)
  const named = gap.item_ids ? new Set(gap.item_ids) : null
  const issues: string[] = []
  for (const id of named ?? []) {
    const item = index.planItems.get(id)
    if (!item) issues.push(`income_gap.item_ids: no plan item '${id}'`)
    else if (item.kind !== 'income') issues.push(`income_gap.item_ids: '${id}' is a plan item of kind ${item.kind}, not income`)
  }
  if (issues.length > 0) throw new RangeError(issues.join('; '))
  const stops = (item: (typeof snapshot.doc.plan_items)[number]) => item.kind === 'transfer' || item.stops_with_income || (item.kind === 'income' && (named === null || named.has(item.id)))
  const { from, to } = gapDays(gap)
  const plan_items = snapshot.doc.plan_items.map((item) => {
    if (!stops(item)) return item
    const skipped = new Set(item.skip_periods)
    for (const [period] of itemSchedule(item, null, from, to)) skipped.add(period)
    return { ...item, skip_periods: [...skipped].sort() }
  })
  return { ...snapshot.doc, plan_items }
}

// Inside the gap every card pays its minimum and nothing more; outside it `payer` decides.
export function gapPayer(gap: IncomeGap, payer: CardPayer = payLeft): CardPayer {
  const { from, to } = gapDays(gap)
  return (context) => {
    if (context.pay_on < from || context.pay_on > to) return payer(context)
    const { terms } = context.card
    const card = { ...context.card, terms: { ...terms, pay: { ...terms.pay, mode: 'minimum' as const } } }
    return paymentFigures({ ...context, card, items_minor: 0, extra_minor: 0 }).left_to_pay_minor
  }
}

// The snapshot and card module a walk under the gap takes (spec §6.8).
export function withIncomeGap(snapshot: Snapshot, gap: IncomeGap, payer: CardPayer = payLeft): { snapshot: Snapshot; cards: CardModule } {
  return { snapshot: buildSnapshot(incomeGapDoc(snapshot, gap), snapshot.as_of, snapshot.rates), cards: cardModule(gapPayer(gap, payer)) }
}

// The first month a cash account ends a day below zero with every income item stopped and every floor spent from next month: the plan breaks then.
export interface MoneyLasts extends BelowZero {
  ok: true
  month: string
  // Whole months from the gap's first month to that month; 0 when it breaks before the gap starts.
  months: number
}

export interface MoneyLastsOptions {
  payer?: CardPayer
  loans?: LoanModule
}

function answer(result: BelowZeroResult, from_month: string): MoneyLasts | WalkFailure | null {
  if (!result.ok) return result
  if (result.first === null) return null
  const month = result.first.date.slice(0, 7)
  return Object.freeze({ ok: true as const, ...result.first, month, months: Math.max(0, monthIndex(month) - monthIndex(from_month)) })
}

// The gap monthsMoneyLasts walks: every income item and transfer item stopped from next month, for 60 months.
function gapFrom(asOf: string): IncomeGap {
  return { from_month: monthKey(addMonths(firstOfMonth(asOf), 1)), months: 60 }
}

// withIncomeGap with every floor spent from the gap's first month: floors are held back as cover for when income stops.
function lastingGap(snapshot: Snapshot, gap: IncomeGap, payer?: CardPayer): { snapshot: Snapshot; cards: CardModule } {
  const last = monthKey(addMonths(firstOfMonth(gap.from_month), -1))
  const doc = incomeGapDoc(snapshot, gap)
  const accounts = doc.accounts.map((a) => (a.kind === 'cash' ? { ...a, floor_windows: a.floor_windows.flatMap((w) => (w.from_month > last ? [] : [{ ...w, to_month: w.to_month === null || w.to_month > last ? last : w.to_month }])) } : a))
  return { snapshot: buildSnapshot({ ...doc, accounts }, snapshot.as_of, snapshot.rates), cards: cardModule(gapPayer(gap, payer)) }
}

// Months the money lasts if income stops: one metrics walk with income_gap {next month, 60 months} and every floor spent in it; null when no cash account ends a day below zero to the horizon end.
export function monthsMoneyLasts(snapshot: Snapshot, options: MoneyLastsOptions = {}): MoneyLasts | WalkFailure | null {
  const gap = gapFrom(snapshot.as_of)
  const gapped = lastingGap(snapshot, gap, options.payer)
  return answer(firstBelowZero(gapped.snapshot, { cards: gapped.cards, loans: options.loans ?? LOANS }), gap.from_month)
}

// The same answer as monthsMoneyLasts, handing the thread back to the screen after building the gapped plan and after expanding it, so no step holds it for long (spec §6.9).
export async function monthsMoneyLastsYielding(snapshot: Snapshot, options: MoneyLastsOptions & { pause?: () => Promise<void> } = {}): Promise<MoneyLasts | WalkFailure | null> {
  const pause = options.pause ?? yieldToScreen
  const gap = gapFrom(snapshot.as_of)
  const gapped = lastingGap(snapshot, gap, options.payer)
  await pause()
  expandPlan(gapped.snapshot)
  await pause()
  return answer(firstBelowZero(gapped.snapshot, { cards: gapped.cards, loans: options.loans ?? LOANS }), gap.from_month)
}
