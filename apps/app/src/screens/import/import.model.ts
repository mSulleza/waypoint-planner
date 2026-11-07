import { canonical, daysBetween, expandPlan, MASK, snapshotIndex, suggestFor, type Account, type Category, type PostBatchInput, type Snapshot } from '@waypoint/core'
import { CSV_DATE_ORDERS, csvDrafts, descriptionKey, readCsvDay, readCsvMappingDraft, type CsvDateOrder, type CsvDraft, type CsvMapping, type CsvMappingDraft, type CsvSkip, type CsvTable } from '@waypoint/core/csv'
import type { RecordedRow } from '../../data/imports'
import { maskFigures } from '../../ui/mask-text'

// Spec §7 Import: a bank's CSV file into one account, its columns mapped once per account, rows already saved greyed, categories and links suggested, and one batch that Undo deletes.

const KIND_ORDER: Record<Account['kind'], number> = { cash: 0, credit_card: 1, loan: 2 }

// The accounts a file can go into: open ones, cash first, then cards and loans, each in the household's order.
export function importAccounts(snapshot: Snapshot): Account[] {
  return snapshot.doc.accounts.filter((a) => a.archived_at === null).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.sort_order - b.sort_order || a.name.localeCompare(b.name))
}

export type MappingField = 'date' | 'date_order' | 'amount' | 'debit' | 'credit' | 'description'

const FIELD_OF: Record<string, MappingField> = { date: 'date', date_order: 'date_order', 'amount.column': 'amount', 'amount.debit': 'debit', 'amount.credit': 'credit', description: 'description' }

const MISSING: Record<MappingField, string> = {
  date: 'Pick the column with each row’s date.',
  date_order: 'Pick how the dates are written.',
  amount: 'Pick the column with each row’s amount.',
  debit: 'Pick the column with money out.',
  credit: 'Pick the column with money in.',
  description: 'Pick the column that says what each row was.',
}

export type MappingRead = { ok: true; mapping: CsvMapping } | { ok: false; errors: Partial<Record<MappingField, string>> }

// The mapping form as a mapping, or a sentence for each choice still to make.
export function readMapping(draft: CsvMappingDraft): MappingRead {
  const read = readCsvMappingDraft(draft)
  if (read.ok) return { ok: true, mapping: read.value }
  const errors: Partial<Record<MappingField, string>> = {}
  for (const issue of read.errors) {
    const field = FIELD_OF[issue.split(':')[0] ?? '']
    if (!field || errors[field]) continue
    errors[field] = field === 'credit' && draft.credit !== null && draft.credit === draft.debit ? 'Money out and money in need two different columns.' : MISSING[field]
  }
  return { ok: false, errors }
}

// The first value under a column, for a picker's detail line.
export function firstValue(table: CsvTable, column: string | null): string {
  const i = column === null ? -1 : table.header.indexOf(column)
  if (i < 0) return ''
  for (const r of table.rows) {
    const value = (r[i] ?? '').trim()
    if (value !== '') return value
  }
  return ''
}

const FIGURES = /^[^A-Za-z]*[0-9][^A-Za-z]*$/
const SAMPLE_MAX = 40

// Each column with its first value, so the person can tell them apart; under the privacy mask a value of figures alone that is not a date reads •••, as does a figure beside a currency in words.
export function columnChoices(table: CsvTable, masked: boolean): { value: string; title: string; detail: string }[] {
  return table.header.map((name) => {
    const value = firstValue(table, name)
    const date = CSV_DATE_ORDERS.some((order) => readCsvDay(value, order) !== null)
    const shown = !masked ? value : !date && FIGURES.test(value) ? MASK : maskFigures(value)
    return { value: name, title: name, detail: shown === '' ? 'Empty in every row' : shown.length > SAMPLE_MAX ? `${shown.slice(0, SAMPLE_MAX - 1)}…` : shown }
  })
}

const ORDER_WORDS: Record<CsvDateOrder, string> = { ymd: 'Year, month, day', dmy: 'Day, month, year', mdy: 'Month, day, year' }

// The three ways a date can be written, each saying how the file's first date reads that way.
export function dateOrderChoices(sample: string, longDay: (day: string) => string): { value: CsvDateOrder; title: string; detail: string }[] {
  return CSV_DATE_ORDERS.map((order) => {
    const day = sample === '' ? null : readCsvDay(sample, order)
    return { value: order, title: ORDER_WORDS[order], detail: sample === '' ? 'No date in the first rows' : day === null ? `${sample} does not read this way` : `${sample} is ${longDay(day)}` }
  })
}

export interface Settles {
  plan_item_id: string
  period: string
  name: string
}

export interface ReviewRow {
  // The row's external id, unique in the file.
  key: string
  // The transaction id post_batch saves it under, made once per file, so a retry saves it once.
  id: string
  draft: CsvDraft
  // Already on the account: saved by an earlier import, or by another device while this one reviewed.
  recorded: boolean
  // A row entered by hand on the account, with no bank reference, the same amount and a day within ENTERED_DAYS: likely this one, so it starts unticked.
  entered: { row_id: string; posted_on: string } | null
  // The category last used for this description; for money out, or a refund.
  category: string | null
  // The open plan occurrence it would settle, from core's pairing rule.
  link: Settles | null
}

// How far apart a hand-entered row and the bank's posting of it can fall.
export const ENTERED_DAYS = 2

const HINTS = new WeakMap<Snapshot, ReadonlyMap<string, string>>()

// For each description, the category its latest row carried, leaving out archived categories.
export function categoryHints(snapshot: Snapshot): ReadonlyMap<string, string> {
  const known = HINTS.get(snapshot)
  if (known) return known
  const open = new Set(snapshot.doc.categories.filter((c) => c.archived_at === null).map((c) => c.id))
  const latest = new Map<string, { day: string; category: string }>()
  for (const t of snapshot.doc.transactions) {
    if (t.category_id === null || !open.has(t.category_id)) continue
    const key = descriptionKey(t.description)
    const seen = latest.get(key)
    if (key !== '' && (!seen || t.posted_on >= seen.day)) latest.set(key, { day: t.posted_on, category: t.category_id })
  }
  const hints = new Map([...latest].map(([key, v]) => [key, v.category]))
  HINTS.set(snapshot, hints)
  return hints
}

// The external ids already on the account, each with its day and amount, or null where a refusal named the id alone.
export type Recorded = ReadonlyMap<string, RecordedRow | null>

// Each draft with the review's suggestions. An occurrence goes to one row at most, the earliest, so two rows never settle one bill twice.
export function reviewRows(snapshot: Snapshot, accountId: string, drafts: readonly CsvDraft[], recorded: Recorded, idOf: (key: string) => string): ReviewRow[] {
  const plan = expandPlan(snapshot)
  const items = snapshotIndex(snapshot).planItems
  const hints = categoryHints(snapshot)
  const taken = new Set<string>()
  const links = new Map<string, Settles>()
  const byDay = [...drafts].sort((a, b) => (a.posted_on < b.posted_on ? -1 : a.posted_on > b.posted_on ? 1 : a.row - b.row))
  const onAccount = snapshotIndex(snapshot).rowsByAccount.get(accountId) ?? []
  // A reference this file repeats is hashed, but an earlier file may have saved one of its rows under the bare reference: the row with that day and amount is the one already there.
  const already = new Set(drafts.filter((d) => recorded.has(d.external_id)).map((d) => d.external_id))
  const byReference = new Map(onAccount.flatMap((t) => (t.external_id === null ? [] : [[t.external_id, t] as const])))
  const claimed = new Set<string>()
  for (const d of byDay) {
    if (d.reference === '' || d.external_id === d.reference || already.has(d.external_id) || claimed.has(d.reference)) continue
    const saved = byReference.get(d.reference) ?? recorded.get(d.reference)
    if (!saved || saved.amount_minor !== d.amount_minor || saved.posted_on !== d.posted_on) continue
    claimed.add(d.reference)
    already.add(d.external_id)
  }
  // Each hand-entered row pairs with one file row at most, the nearest day first.
  const hand = onAccount.filter((t) => t.external_id === null && t.transfer_id === null)
  const used = new Set<string>()
  const entered = new Map<string, { row_id: string; posted_on: string }>()
  for (const d of byDay) {
    if (already.has(d.external_id)) continue
    const near = hand
      .filter((t) => !used.has(t.id) && t.amount_minor === d.amount_minor && Math.abs(daysBetween(t.posted_on, d.posted_on)) <= ENTERED_DAYS)
      .sort((a, b) => Math.abs(daysBetween(a.posted_on, d.posted_on)) - Math.abs(daysBetween(b.posted_on, d.posted_on)) || (a.id < b.id ? -1 : 1))[0]
    if (!near) continue
    used.add(near.id)
    entered.set(d.external_id, { row_id: near.id, posted_on: near.posted_on })
  }
  for (const d of byDay) {
    if (already.has(d.external_id) || entered.has(d.external_id)) continue
    const found = suggestFor(plan.occurrences, { id: d.external_id, account_id: accountId, kind: d.kind, amount_minor: d.amount_minor, posted_on: d.posted_on, plan_item_id: null })
    const occurrence = found ? plan.byId.get(found.occurrence_id) : undefined
    const item = occurrence ? items.get(occurrence.plan_item_id) : undefined
    if (!occurrence || !item || taken.has(occurrence.id)) continue
    taken.add(occurrence.id)
    links.set(d.external_id, { plan_item_id: item.id, period: occurrence.period, name: item.name })
  }
  return drafts.map((d) => ({
    key: d.external_id,
    id: idOf(d.external_id),
    draft: d,
    recorded: already.has(d.external_id),
    entered: entered.get(d.external_id) ?? null,
    category: hints.get(descriptionKey(d.description)) ?? null,
    link: links.get(d.external_id) ?? null,
  }))
}

// What the person has set on a row; a row they have not touched takes its defaults.
export interface RowChoice {
  include: boolean
  // Money in that is money back, which can carry a category.
  refund: boolean
  category: string | null
  link: boolean
}

export function defaultChoice(row: ReviewRow): RowChoice {
  return { include: !row.recorded && row.entered === null, refund: false, category: row.category, link: row.link !== null }
}

export function choiceOf(row: ReviewRow, choices: ReadonlyMap<string, RowChoice>): RowChoice {
  const set = choices.get(row.key)
  // A row saved elsewhere since it was ticked is never sent.
  return set ? { ...set, include: set.include && !row.recorded } : defaultChoice(row)
}

export type RowKind = 'expense' | 'income' | 'refund'

export function kindOf(row: ReviewRow, choice: RowChoice): RowKind {
  return row.draft.amount_minor < 0 ? 'expense' : choice.refund ? 'refund' : 'income'
}

export const takesCategory = (kind: RowKind) => kind !== 'income'

// The ticked rows as one post_batch: one batch id, so Undo deletes exactly them. null when nothing is ticked.
export function importBatch(accountId: string, rows: readonly ReviewRow[], choices: ReadonlyMap<string, RowChoice>, batchId: string, categories: readonly Category[]): PostBatchInput | null {
  const open = new Set(categories.filter((c) => c.archived_at === null).map((c) => c.id))
  const sent = rows.flatMap((row) => {
    const choice = choiceOf(row, choices)
    if (!choice.include) return []
    const kind = kindOf(row, choice)
    const category = takesCategory(kind) && choice.category !== null && open.has(choice.category) ? choice.category : null
    const link = choice.link ? row.link : null
    return [
      {
        id: row.id,
        account_id: accountId,
        posted_on: row.draft.posted_on,
        amount_minor: row.draft.amount_minor,
        kind,
        category_id: category,
        description: row.draft.description,
        transfer_id: null,
        plan_item_id: link?.plan_item_id ?? null,
        period: link?.period ?? null,
        external_id: row.draft.external_id,
      },
    ]
  })
  return sent.length === 0 ? null : { batch_id: batchId, rows: sent }
}

export interface ReviewSummary {
  ticked: number
  recorded: number
  // Rows that look like ones entered by hand, left unticked unless the person ticks them.
  entered: number
  in_minor: number
  out_minor: number
}

// The counts and the money in and out of the ticked rows, to check against the bank before importing.
export function reviewSummary(rows: readonly ReviewRow[], choices: ReadonlyMap<string, RowChoice>): ReviewSummary {
  const summary = { ticked: 0, recorded: 0, entered: 0, in_minor: 0, out_minor: 0 }
  for (const row of rows) {
    if (row.recorded) summary.recorded++
    else if (row.entered) summary.entered++
    if (!choiceOf(row, choices).include) continue
    summary.ticked++
    if (row.draft.amount_minor > 0) summary.in_minor += row.draft.amount_minor
    else summary.out_minor -= row.draft.amount_minor
  }
  return summary
}

// first and last round a group's corners, so each group reads as one card.
interface Place {
  first: boolean
  last: boolean
}

export type ReviewItem = ({ type: 'row'; key: string; row: ReviewRow } & Place) | { type: 'heading'; key: string; title: string } | ({ type: 'skip'; key: string; skip: CsvSkip } & Place)

// Newest first, as the ledger reads; then the rows left out, by their place in the file.
export function reviewItems(rows: readonly ReviewRow[], skipped: readonly CsvSkip[]): ReviewItem[] {
  const sorted = [...rows].sort((a, b) => (a.draft.posted_on > b.draft.posted_on ? -1 : a.draft.posted_on < b.draft.posted_on ? 1 : a.draft.row - b.draft.row))
  const place = (i: number, n: number): Place => ({ first: i === 0, last: i === n - 1 })
  const items: ReviewItem[] = sorted.map((row, i) => ({ type: 'row', key: row.key, row, ...place(i, sorted.length) }))
  if (skipped.length > 0) {
    items.push({ type: 'heading', key: 'skipped', title: `Not read (${skipped.length})` })
    skipped.forEach((skip, i) => items.push({ type: 'skip', key: `skip-${skip.row}`, skip, ...place(i, skipped.length) }))
  }
  return items
}

// Why a row was left out, in words; an amount that did not read is not shown under the mask.
export function skipWords(skip: CsvSkip, account: Pick<Account, 'name' | 'opening_date'>, masked: boolean, day: (iso: string) => string): string {
  if (skip.problem === 'date') return skip.text.trim() === '' ? 'No date.' : `The date ${skip.text.trim()} does not read in the order chosen.`
  if (skip.problem === 'zero') return 'The amount is 0.'
  if (skip.problem === 'before_opening') return `Dated ${day(skip.text)}, before ${account.name} opens on ${day(account.opening_date)}.`
  if (skip.text.trim() === '') return 'No amount.'
  return masked ? 'The amount does not read.' : `The amount ${skip.text.trim()} does not read.`
}

// The first rows as the mapping reads them, to check it before going on.
export function previewOf(table: CsvTable, mapping: CsvMapping, account: Pick<Account, 'currency' | 'opening_date'>, count = 3): { drafts: CsvDraft[]; skipped: CsvSkip[] } | null {
  const read = csvDrafts({ header: table.header, rows: table.rows.slice(0, count) }, mapping, account)
  return read.ok ? read.value : null
}

// The day range a file covers, for the one request that finds rows already saved.
export function fileDays(drafts: readonly CsvDraft[]): { from: string; to: string } | null {
  if (drafts.length === 0) return null
  let [from, to] = [drafts[0]?.posted_on ?? '', drafts[0]?.posted_on ?? '']
  for (const d of drafts) {
    if (d.posted_on < from) from = d.posted_on
    if (d.posted_on > to) to = d.posted_on
  }
  return { from, to }
}

// Whether the mapping differs from the account's saved one, keys in any order as jsonb returns them, so Continue saves it only when it changed.
export function mappingChanged(saved: unknown, mapping: CsvMapping): boolean {
  return canonical(saved ?? null) !== canonical(mapping)
}
