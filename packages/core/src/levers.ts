import { addDays, addMonths, dayInMonth, firstOfMonth, lastDayOfMonth, monthKey } from './dates'
import { CARDS, cardModule, type CardPayer } from './engine/cards'
import type { CardModule, LoanModule } from './engine/debts'
import { gapPayer, incomeGapDoc } from './engine/income-gap'
import { LOANS } from './engine/loans'
import { itemSchedule } from './engine/occurrences'
import { checkInput, type Checked } from './schema/common'
import type { ImportDoc } from './schema/import-doc'
import { parsePatch, patchSchema, type ItemPatch, type Patch } from './schema/patch'
import { MONTHS_APART, type Account, type PlanItem, type PlanItemKind, type Transaction } from './schema/rows'
import { buildSnapshot, snapshotIndex, SnapshotError, type Snapshot } from './snapshot'

// One option to try: a patch and the words Compare shows for it.
export interface Lever {
  label: string
  patch: Patch
}

// What a walk of a patched world takes besides its snapshot.
export interface WorldOptions {
  // The patch's FX shift, 0 when it sets none.
  fx_shift_pct: number
  // Under an income gap, cards pay only their minimum inside it.
  cards: CardModule
  loans: LoanModule
}

export interface PatchedWorld {
  snapshot: Snapshot
  patch: Patch
  options: WorldOptions
}

export interface WorldModules {
  // Sizes card payments outside an income gap; left to pay by default.
  payer?: CardPayer
  loans?: LoanModule
}

const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7))

// The item's first occurrence on or after `from`, counted from starts_on as split_plan_item counts it.
function firstOnOrAfter(item: PlanItem, from: string): string {
  if (item.every === 'week' || item.every === '2weeks') {
    const step = item.every === 'week' ? 7 : 14
    let day = item.starts_on
    while (day < from) day = addDays(day, step)
    return day
  }
  if (item.every === 'once') return item.starts_on
  const months = MONTHS_APART[item.every]
  const steps = Math.trunc(monthsBetween(item.starts_on, from) / months)
  const anchor = addMonths(item.starts_on, months * steps)
  return anchor < from ? addMonths(item.starts_on, months * (steps + 1)) : anchor
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}#${n}`
  taken.add(id)
  return id
}

interface ItemChange {
  item: PlanItem
  // The copy that carries the change from `from` on, as split_plan_item adds it; null for a change made in place.
  copy: PlanItem | null
  from: string | null
}

// One item's patch: an amount or day from a month ends the item the day before that month and adds a copy from its next occurrence (split_plan_item), unless the month reaches back to its first occurrence, which changes the item itself.
function changeItem(item: PlanItem, change: ItemPatch, links: readonly Transaction[], taken: Set<string>): ItemChange | string[] {
  const at = `items.${item.id}`
  const errors: string[] = []
  let base = item
  if (change.include_upside === true) {
    if (item.confidence !== 'upside') errors.push(`${at}.include_upside: '${item.id}' is not an upside item`)
    else base = { ...base, confidence: 'estimated' }
  }
  const { amount_minor: amount, day, from_month: month } = change
  if (amount !== undefined && amount < 0 && item.kind !== 'allowance') errors.push(`${at}.amount_minor: must be more than 0; only an allowance may be negative`)
  if (day !== undefined && (item.kind === 'installment' || item.kind === 'allowance' || item.every === 'week' || item.every === '2weeks')) {
    errors.push(`${at}.day: day moves an item that happens once or repeats monthly, every 3 months or yearly; an installment bills at the cut, an allowance spreads over its month and a weekly item keeps its weekday`)
  }
  const ended = (row: PlanItem): PlanItem => (change.ends_on === undefined ? row : { ...row, ends_on: change.ends_on })
  if (month === undefined) return errors.length > 0 ? errors : { item: ended(base), copy: null, from: null }

  const from = firstOfMonth(month)
  if (item.every === 'once' && monthKey(item.starts_on) < month) errors.push(`${at}.from_month: '${item.id}' happens once, on ${item.starts_on}, before ${month}`)
  if (item.every !== 'once' && from > item.starts_on && item.ends_on !== null && from > item.ends_on) errors.push(`${at}.from_month: '${item.id}' ends ${item.ends_on}, before ${month}`)
  if (errors.length > 0) return errors
  const changed = (row: PlanItem, start: string): PlanItem => ({ ...row, amount_minor: amount ?? row.amount_minor, starts_on: day === undefined ? start : dayInMonth(start, day) })
  if (item.every === 'once' || from <= item.starts_on) return { item: ended(changed(base, base.starts_on)), copy: null, from: null }

  const start = changed(base, firstOnOrAfter(item, from)).starts_on
  const end = change.ends_on === undefined ? item.ends_on : change.ends_on
  if (end !== null && start > end) return [`${at}.ends_on: the changed item would start ${start} but end ${end}`]
  const copy: PlanItem = { ...changed(base, start), id: uniqueId(`${item.id}@${month}`, taken), ends_on: end, skip_periods: base.skip_periods.filter((p) => p >= from) }
  const moved = [...links.filter((t) => t.period !== null && t.period >= from).map((t) => t.period as string), ...copy.skip_periods].sort()
  const last = moved.at(-1)
  if (last !== undefined) {
    const periods = new Set(itemSchedule(copy, null, copy.starts_on, lastDayOfMonth(last)).map(([period]) => period))
    const orphan = moved.find((p) => !periods.has(p))
    if (orphan !== undefined) return [`${at}: the occurrence ${orphan} is linked or skipped, and the changed item has no occurrence to take it`]
  }
  const before: PlanItem = { ...base, ends_on: item.kind === 'installment' ? addMonths(from, -1) : addDays(from, -1), skip_periods: base.skip_periods.filter((p) => p < from) }
  return { item: before, copy, from }
}

type Tables = Pick<ImportDoc, 'accounts' | 'plan_items' | 'transactions'>

// buildSnapshot names a bad row by its place in the document; the patch's author knows it by id.
function byId(issues: readonly string[], doc: Tables): string[] {
  return issues.map((issue) =>
    issue.replace(/^doc\.(accounts|plan_items|transactions)\[(\d+)\]/, (whole, table: keyof Tables, i: string) => {
      const row = doc[table][Number(i)]
      return row ? `${table}['${row.id}']` : whole
    }),
  )
}

function build(doc: ImportDoc, snapshot: Snapshot): Snapshot | string[] {
  try {
    return buildSnapshot(doc, snapshot.as_of, snapshot.rates)
  } catch (error) {
    if (error instanceof SnapshotError) return byId(error.issues, doc)
    throw error
  }
}

// The world a patch describes, on a copy of the snapshot (spec §6.8): strict on keys and on the ids it names, every error at once, and the snapshot itself back when the patch changes no row.
export function applyPatch(snapshot: Snapshot, input: unknown, modules: WorldModules = {}): Checked<PatchedWorld> {
  const parsed = parsePatch(input)
  if (!parsed.ok) return parsed
  const patch = parsed.value
  const index = snapshotIndex(snapshot)
  const errors: string[] = []
  const added = patch.add ?? []
  const taken = new Set([...index.planItems.keys(), ...added.map((p) => p.id)])
  for (const [i, row] of added.entries()) if (index.planItems.has(row.id)) errors.push(`add[${i}].id: plan item '${row.id}' already exists`)

  const linksOf = new Map<string, Transaction[]>()
  for (const t of snapshot.doc.transactions) {
    if (t.plan_item_id === null) continue
    const list = linksOf.get(t.plan_item_id)
    if (list) list.push(t)
    else linksOf.set(t.plan_item_id, [t])
  }
  const removed = new Set<string>()
  const replaced = new Map<string, PlanItem>()
  const splits = new Map<string, { copy: PlanItem; from: string }>()
  for (const [id, change] of Object.entries(patch.items ?? {})) {
    const item = index.planItems.get(id)
    if (!item) {
      errors.push(`items.${id}: no plan item '${id}'`)
      continue
    }
    if (change.removed === true) {
      removed.add(id)
      continue
    }
    const result = changeItem(item, change, linksOf.get(id) ?? [], taken)
    if (Array.isArray(result)) {
      errors.push(...result)
      continue
    }
    if (result.item !== item) replaced.set(id, result.item)
    if (result.copy && result.from) splits.set(id, { copy: result.copy, from: result.from })
  }

  for (const id of Object.keys(patch.accounts ?? {})) {
    const account = index.accounts.get(id)
    if (!account) errors.push(`accounts.${id}: no account '${id}'`)
    else if (account.kind !== 'cash') errors.push(`accounts.${id}.floor_windows: floor windows are for cash accounts only, and '${id}' is a ${account.kind === 'loan' ? 'loan' : 'card'}`)
  }

  const gap = patch.income_gap
  const kinds = new Map<string, PlanItemKind>([...snapshot.doc.plan_items, ...added].map((p) => [p.id, p.kind]))
  for (const id of gap?.item_ids ?? []) {
    const kind = kinds.get(id)
    if (kind === undefined) errors.push(`income_gap.item_ids: no plan item '${id}'`)
    else if (kind !== 'income') errors.push(`income_gap.item_ids: '${id}' is a plan item of kind ${kind}, not income`)
  }
  if (errors.length > 0) return { ok: false, errors }

  const cards = gap ? cardModule(gapPayer(gap, modules.payer)) : modules.payer ? cardModule(modules.payer) : CARDS
  const options: WorldOptions = Object.freeze({ fx_shift_pct: patch.fx_shift_pct ?? 0, cards, loans: modules.loans ?? LOANS })
  const floors = patch.accounts ?? {}
  const rowsChange = removed.size > 0 || replaced.size > 0 || added.length > 0 || Object.keys(floors).length > 0
  let world = snapshot
  if (rowsChange) {
    const plan_items = snapshot.doc.plan_items.filter((p) => !removed.has(p.id)).map((p) => replaced.get(p.id) ?? p)
    for (const { copy } of splits.values()) plan_items.push(copy)
    plan_items.push(...added)
    // Posted rows stay; only their links follow the item, and a removed item's rows lose theirs.
    const transactions = snapshot.doc.transactions.map((t) => {
      if (t.plan_item_id === null || t.period === null) return t
      if (removed.has(t.plan_item_id)) return { ...t, plan_item_id: null, period: null }
      const split = splits.get(t.plan_item_id)
      return split && t.period >= split.from ? { ...t, plan_item_id: split.copy.id } : t
    })
    const accounts = snapshot.doc.accounts.map((a): Account => {
      const windows = floors[a.id]?.floor_windows
      return windows && a.kind === 'cash' ? { ...a, floor_windows: windows } : a
    })
    const built = build({ ...snapshot.doc, accounts, plan_items, transactions }, snapshot)
    if (Array.isArray(built)) return { ok: false, errors: built }
    world = built
  }
  if (gap) {
    // A named income item that was split stops through its copy too; a removed one has nothing left to stop.
    const item_ids = gap.item_ids?.flatMap((id) => {
      const split = splits.get(id)
      return removed.has(id) ? [] : split ? [id, split.copy.id] : [id]
    })
    world = buildSnapshot(incomeGapDoc(world, { ...gap, ...(item_ids ? { item_ids } : {}) }), world.as_of, world.rates)
  }
  return { ok: true, value: Object.freeze({ snapshot: world, patch, options }) }
}

// Key-sorted JSON, so the same value reads the same whatever order its keys were written in.
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v))
}

// Every lever at once as one patch, for Compare's “All together”: two levers may touch one item or account only with keys that agree.
export function combinePatches(inputs: readonly unknown[]): Checked<Patch> {
  const errors: string[] = []
  const patches: Patch[] = []
  inputs.forEach((input, i) => {
    const parsed = parsePatch(input)
    if (parsed.ok) patches.push(parsed.value)
    else errors.push(...parsed.errors.map((e) => `levers[${i}]: ${e}`))
  })
  if (errors.length > 0) return { ok: false, errors }
  const clash = (path: string) => errors.push(`${path}: more than one lever sets it differently; try them as one lever`)
  const merged: { fx_shift_pct?: number; items: Record<string, Record<string, unknown>>; add: PlanItem[]; accounts: Record<string, unknown>; income_gap?: Patch['income_gap'] } = { items: {}, add: [], accounts: {} }
  for (const p of patches) {
    if (p.fx_shift_pct !== undefined) {
      if (merged.fx_shift_pct !== undefined && merged.fx_shift_pct !== p.fx_shift_pct) clash('fx_shift_pct')
      merged.fx_shift_pct = p.fx_shift_pct
    }
    for (const [id, change] of Object.entries(p.items ?? {})) {
      const into = (merged.items[id] ??= {})
      for (const [key, value] of Object.entries(change)) {
        if (key in into && canonical(into[key]) !== canonical(value)) clash(`items.${id}.${key}`)
        into[key] = value
      }
    }
    for (const row of p.add ?? []) {
      if (merged.add.some((r) => r.id === row.id)) errors.push(`add: more than one lever adds plan item '${row.id}'`)
      else merged.add.push(row)
    }
    for (const [id, windows] of Object.entries(p.accounts ?? {})) {
      if (id in merged.accounts && canonical(merged.accounts[id]) !== canonical(windows)) clash(`accounts.${id}`)
      merged.accounts[id] = windows
    }
    if (p.income_gap) {
      if (merged.income_gap && canonical(merged.income_gap) !== canonical(p.income_gap)) clash('income_gap')
      merged.income_gap = p.income_gap
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const out: Record<string, unknown> = {}
  if (merged.fx_shift_pct !== undefined) out.fx_shift_pct = merged.fx_shift_pct
  if (Object.keys(merged.items).length > 0) out.items = merged.items
  if (merged.add.length > 0) out.add = merged.add
  if (Object.keys(merged.accounts).length > 0) out.accounts = merged.accounts
  if (merged.income_gap) out.income_gap = merged.income_gap
  return checkInput(patchSchema, out)
}

