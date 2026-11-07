import { checkInput, horizonEnd, itemSchedule, lastDayOfMonth, monthKey, planItemRow, snapshotIndex, validatePlanItem, type PlanItem, type Snapshot } from '@waypoint/core'
import { upsertPlanItemInput, type UpsertPlanItemInput } from '@waypoint/core/agent'
import { randomUUID } from 'node:crypto'
import { Refusal } from '../../errors'
import { accountOf, AMOUNTS, countedIn, DATA_TEXT, link } from '../read/shape'
import { categoryOf, changed, itemOf, minorOf, ownerOf, refusal, WRITES, type WriteIO, type Written, type WriteTool } from './shape'

// The columns an update sets; skip_periods stays as the table holds it (set_link skips).
const ITEM_VALUES = ['kind', 'name', 'from_account_id', 'to_account_id', 'category_id', 'amount_minor', 'every', 'starts_on', 'ends_on', 'roll', 'confidence', 'stops_with_income'] as const
// What split_plan_item carries into the row it starts, besides day.
const SPLIT_KEYS = ['amount_minor', 'name', 'from_account_id', 'to_account_id', 'category_id', 'every', 'roll', 'confidence', 'stops_with_income', 'ends_on'] as const
const FIELDS = ['kind', 'name', 'from_account_id', 'to_account_id', 'category_id', 'every', 'starts_on', 'ends_on', 'roll', 'confidence', 'stops_with_income'] as const

type Values = Partial<Pick<PlanItem, (typeof FIELDS)[number]>>

const fieldsOf = (args: UpsertPlanItemInput): Values => Object.fromEntries(FIELDS.flatMap((f) => (args[f] === undefined ? [] : [[f, args[f]]])))

// The amount in the currency the item counts in, or the saved one when that currency stays.
function amountOf(snapshot: Snapshot, args: UpsertPlanItemInput, route: Pick<PlanItem, 'kind' | 'from_account_id' | 'to_account_id'>, loaded: PlanItem | null): number {
  const currency = countedIn(snapshot, route)
  if (args.amount !== undefined) return minorOf(args.amount, currency, 'amount')
  if (loaded === null) throw new Refusal('bad_input', 'Nothing was saved: amount: a new item needs its amount.')
  if (countedIn(snapshot, loaded) !== currency) throw new Refusal('bad_input', `Nothing was saved: amount: the item now counts in ${currency}, not ${countedIn(snapshot, loaded)}; give its amount in ${currency}.`)
  return loaded.amount_minor
}

// planItemRow plus the accounts, the category and check_plan_item's routing, as the database will check them.
function checked(snapshot: Snapshot, row: unknown): PlanItem {
  const result = checkInput(planItemRow, row)
  if (!result.ok) throw new Refusal('bad_input', `Nothing was saved: ${result.errors.map((e) => e.replace(/^amount_minor:/, 'amount:')).join('; ')}`, { issues: result.errors })
  const item = result.value
  for (const id of [item.from_account_id, item.to_account_id]) if (id !== null) accountOf(snapshot, id)
  if (item.category_id !== null) categoryOf(snapshot, item.category_id)
  const routing = validatePlanItem(item, snapshot.doc.accounts)
  if (routing.length > 0) throw new Refusal('check_plan_item', `Nothing was saved: ${routing.join('; ')}.`)
  return item
}

const linksOf = (snapshot: Snapshot, itemId: string) => snapshot.doc.transactions.filter((t) => t.plan_item_id === itemId && t.period !== null)

// A linked or skipped period the item would no longer have, counted from its first date.
function orphanPeriod(item: PlanItem, periods: readonly string[]): string | null {
  if (periods.length === 0) return null
  const sorted = [...periods].sort()
  const first = sorted[0] as string
  const from = first < item.starts_on ? first : item.starts_on
  const kept = new Set(itemSchedule(item, null, from, `${monthKey(sorted.at(-1) as string)}-31`).map(([period]) => period))
  return sorted.find((p) => !kept.has(p)) ?? null
}

const editorLink = (io: WriteIO, id: string) => link(io.before, `/plan/item/${encodeURIComponent(id)}`)

async function create(io: WriteIO, args: UpsertPlanItemInput): Promise<Written> {
  const { snapshot } = io.before
  const values = fieldsOf(args)
  const route = { kind: values.kind ?? 'bill', from_account_id: values.from_account_id ?? null, to_account_id: values.to_account_id ?? null }
  const item = checked(snapshot, { id: args.id ?? randomUUID(), ...values, amount_minor: amountOf(snapshot, args, route, null) })
  const reply = await io.send(async (db) => db.from('plan_items').insert({ ...item, household_id: await ownerOf(db) }).select('id'))
  if (reply.error) throw refusal(reply.error, io.before)
  return { status: 'created', batch_id: null, plan_item_id: item.id, link: editorLink(io, item.id) }
}

async function update(io: WriteIO, loaded: PlanItem, args: UpsertPlanItemInput): Promise<Written> {
  const { snapshot } = io.before
  const merged = { ...loaded, ...fieldsOf(args) }
  const item = checked(snapshot, { ...merged, amount_minor: amountOf(snapshot, args, merged, loaded) })
  const after = Object.fromEntries(ITEM_VALUES.flatMap((c) => (item[c] === loaded[c] ? [] : [[c, item[c]]])))
  if (Object.keys(after).length === 0) return { status: 'already_applied', batch_id: null, plan_item_id: loaded.id, link: editorLink(io, loaded.id) }
  const links = linksOf(snapshot, loaded.id)
  if (links.length > 0 && ('kind' in after || 'from_account_id' in after || 'to_account_id' in after)) {
    throw new Refusal(
      'linked',
      `Nothing was saved: plan item ${loaded.id} has ${links.length} linked transaction${links.length === 1 ? '' : 's'}, which fix its kind and accounts. To use another account from a month on, call upsert_plan_item again with its id, the new account and change_from: the first month (YYYY-MM) the change applies.`,
      { plan_item_id: loaded.id, linked_row_ids: links.map((t) => t.id) },
    )
  }
  const orphan = orphanPeriod(item, [...links.map((t) => t.period as string), ...loaded.skip_periods])
  if (orphan !== null) {
    throw new Refusal('orphan_period', `Nothing was saved: ${orphan} is linked or skipped, and the changed item has no occurrence there. Use change_from to change it from a later month, or unlink or unskip that period first.`, { period: orphan })
  }
  // Only while every column reads as this call found it, so a change made elsewhere is never written over.
  await changed(io, (db) => {
    let query = db.from('plan_items').update(after).eq('id', loaded.id)
    for (const c of ITEM_VALUES) query = loaded[c] === null ? query.is(c, null) : query.eq(c, loaded[c] as string | number | boolean)
    return query.select('id')
  })
  return { status: 'updated', batch_id: null, plan_item_id: loaded.id, changed: Object.keys(after).map((c) => (c === 'amount_minor' ? 'amount' : c)), link: editorLink(io, loaded.id) }
}

// split_plan_item ends the item the day before the month and starts a copy with what changed, moving that month's links and skips and later ones to it.
async function split(io: WriteIO, loaded: PlanItem, args: UpsertPlanItemInput & { change_from: string }): Promise<Written> {
  const { snapshot } = io.before
  if (loaded.every === 'once') throw new Refusal('bad_split', `Nothing was saved: plan item ${loaded.id} happens once; change it without change_from.`)
  const from = `${args.change_from}-01`
  const merged = { ...loaded, ...fieldsOf(args) }
  const amount_minor = amountOf(snapshot, args, merged, loaded)
  const start = itemSchedule(loaded, null, from, horizonEnd(snapshot.as_of))[0]?.[1] ?? from
  // The copy's first date as split_plan_item makes it: the day moved within that month, clamped to its end.
  const starts_on = args.day === undefined ? start : `${start.slice(0, 8)}${String(Math.min(args.day, Number(lastDayOfMonth(start).slice(8)))).padStart(2, '0')}`
  const copy = checked(snapshot, { ...merged, amount_minor, starts_on, skip_periods: [] })
  const patch: Record<string, unknown> = Object.fromEntries(SPLIT_KEYS.flatMap((k) => (copy[k] === loaded[k] ? [] : [[k, copy[k]]])))
  if (args.day !== undefined) patch.day = args.day
  if (Object.keys(patch).length === 0) throw new Refusal('bad_input', `Nothing was saved: change_from needs a field that changes from ${args.change_from}, such as amount or from_account_id.`, { field: 'change_from' })
  const moving = 'from_account_id' in patch || 'to_account_id' in patch ? linksOf(snapshot, loaded.id).find((t) => (t.period as string) >= from) : undefined
  if (moving) {
    throw new Refusal('linked', `Nothing was saved: ${moving.period} has transaction ${moving.id} linked on the old account, and the change would move it. Change from a later month, or unlink it first.`, { row_id: moving.id, period: moving.period })
  }
  const reply = await io.send((db) => db.rpc('split_plan_item', { p_id: loaded.id, p_from: from, p_patch: patch }))
  if (reply.error) throw refusal(reply.error, io.before)
  const created = String(reply.data)
  return { status: 'split', batch_id: null, plan_item_id: loaded.id, new_plan_item_id: created, from_month: args.change_from, link: editorLink(io, created) }
}

export const upsertPlanItem: WriteTool<typeof upsertPlanItemInput> = {
  name: 'upsert_plan_item',
  description: [
    'Adds or changes one plan item. With an id the household lacks (or none) it adds the item: kind, name, amount (a decimal string in the currency it counts in: the receiving account for income and a payment into a debt, else the paying one), starts_on and the accounts its kind needs; pass your own new uuid as id so a retry adds nothing twice.',
    'With an existing id it changes only the fields given, for every occurrence. An item with linked transactions keeps its kind and accounts: change those with change_from.',
    'change_from (YYYY-MM) ends the item before that month and starts a copy with the fields given, moving that month’s links and skips and later ones to it (split_plan_item); day moves its day from that month. Skips are set_link’s.',
    'stops_with_income true marks a bill or allowance that would not be paid while income is stopped, such as tax on that income; Months the money lasts and the income_gap lever skip it, as they skip income and transfers.',
    'Changing nothing answers already_applied.',
    WRITES,
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: upsertPlanItemInput,
  destructive: false,
  idempotent: false,
  async run(io, args) {
    const loaded = args.id === undefined ? null : (snapshotIndex(io.before.snapshot).planItems.get(args.id) ?? null)
    if (args.change_from !== undefined) return split(io, loaded ?? itemOf(io.before.snapshot, args.id ?? ''), { ...args, change_from: args.change_from })
    return loaded === null ? create(io, args) : update(io, loaded, args)
  },
}
