import { buildSnapshot, type Snapshot } from '@waypoint/core'
import { csvDrafts, descriptionKey, readCsv, type CsvMapping, type CsvRead, type CsvTable } from '@waypoint/core/csv'
import { abroad, type Sample } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import {
  categoryHints,
  choiceOf,
  columnChoices,
  dateOrderChoices,
  fileDays,
  importAccounts,
  importBatch,
  mappingChanged,
  readMapping,
  reviewItems,
  reviewRows,
  reviewSummary,
  skipWords,
  type Recorded,
  type RowChoice,
} from './import.model'

const AS_OF = '2026-10-09'
const BATCH = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const MAPPING: CsvMapping = { date: 'Date', date_order: 'dmy', amount: { column: 'Amount' }, decimal: '.', description: 'Description', reference: 'ID' }

// Made-up statement rows for Main (EUR), newest first as many banks write them.
const FILE = [
  'ID,Date,Amount,Description,Balance',
  'T-6,08-10-2026,-4.60,Card transaction of 4.60 EUR issued by Corner Bakery,1944.85',
  'T-5,05-10-2026,-35.00,Sent money to Gym Club,1949.45',
  'T-4,05-10-2026,-35.00,Sent money to Gym Club,1984.45',
  'T-3,02-10-2026,12.40,Card transaction of 12.40 EUR refunded by Corner Bakery,2019.45',
  'T-2,30-09-2026,1500.00,Received money from Example Ltd,2007.05',
  'T-1,31-08-2026,-1.00,Before Main opened,507.05',
].join('\n')

function snapshotOf(edit?: (sample: Sample) => void): Snapshot {
  const sample = abroad(AS_OF)
  // A gym bill paid from Main on the 5th, and a bakery visit filed under Groceries last month.
  sample.doc.plan_items.push({ id: 'gym', kind: 'bill', name: 'Gym', from_account_id: 'main', amount_minor: 3500, starts_on: '2026-09-05' })
  sample.doc.transactions.push({ id: 'bakery-sep', account_id: 'main', posted_on: '2026-09-12', amount_minor: -390, kind: 'expense', description: 'Card transaction of 3.90 EUR issued by Corner Bakery', category_id: 'cat-groceries' })
  edit?.(sample)
  return buildSnapshot(sample.doc, AS_OF, sample.rates)
}

function table(text = FILE): CsvTable {
  const read = readCsv(text)
  if (!read.ok) throw new Error(read.error)
  return read.table
}

function drafts(snapshot: Snapshot): CsvRead {
  const main = snapshot.doc.accounts.find((a) => a.id === 'main')
  if (!main) throw new Error('no main')
  const read = csvDrafts(table(), MAPPING, main)
  if (!read.ok) throw new Error(read.errors.join('; '))
  return read.value
}

const idOf = (key: string) => `id-${key}`
const NONE: Recorded = new Map()
// Ids a refusal named, with no day or amount.
const known = (...ids: string[]): Recorded => new Map(ids.map((id) => [id, null]))

describe('Import review', () => {
  it('suggests the category last used for a description, at any amount, and never an archived one', () => {
    const snapshot = snapshotOf()
    const rows = reviewRows(snapshot, 'main', drafts(snapshot).drafts, NONE, idOf)
    expect(rows.map((r) => [r.key, r.category])).toEqual([
      ['T-6', 'cat-groceries'],
      ['T-5', null],
      ['T-4', null],
      ['T-3', null],
      ['T-2', null],
    ])
    const archived = snapshotOf((s) => {
      const groceries = s.doc.categories.find((c) => c.id === 'cat-groceries')
      if (groceries) groceries.archived_at = '2026-10-01T00:00:00+00:00'
    })
    const bakery = descriptionKey('Card transaction of 3.90 EUR issued by Corner Bakery')
    expect([categoryHints(snapshot).get(bakery), categoryHints(archived).get(bakery)]).toEqual(['cat-groceries', undefined])
  })

  it('links one open bill to the earliest matching row only, and none to rows already imported', () => {
    const snapshot = snapshotOf()
    const rows = reviewRows(snapshot, 'main', drafts(snapshot).drafts, NONE, idOf)
    // Two Gym-sized payments on the 5th: the one earlier in the file settles October; the other is left for the person.
    expect(rows.filter((r) => r.link).map((r) => [r.key, r.link])).toEqual([['T-5', { plan_item_id: 'gym', period: '2026-10-01', name: 'Gym' }]])
    const later = reviewRows(snapshot, 'main', drafts(snapshot).drafts, known('T-5'), idOf)
    expect(later.filter((r) => r.link).map((r) => r.key)).toEqual(['T-4'])
    expect(later.find((r) => r.key === 'T-5')).toMatchObject({ recorded: true, link: null })
  })

  it('greys the row an earlier file saved under a reference this file repeats, and only that one', () => {
    // The bank reuses R-9 for a purchase and its reversal; an earlier file had the purchase alone, saved under R-9.
    const repeated = ['ID,Date,Amount,Description,Balance', 'R-9,07-10-2026,20.00,Reversal of Bookshop,1964.85', 'R-9,06-10-2026,-20.00,Card transaction of 20.00 EUR issued by Bookshop,1944.85'].join('\n')
    const read = (snapshot: Snapshot) => {
      const main = snapshot.doc.accounts.find((a) => a.id === 'main')
      const found = main ? csvDrafts(table(repeated), MAPPING, main) : null
      if (!found?.ok) throw new Error('no drafts')
      return found.value.drafts
    }
    const saved = snapshotOf((sample) => {
      sample.doc.transactions.push({ id: 'bookshop', account_id: 'main', posted_on: '2026-10-06', amount_minor: -2000, kind: 'expense', description: 'Card transaction of 20.00 EUR issued by Bookshop', external_id: 'R-9' })
    })
    const rows = reviewRows(saved, 'main', read(saved), known('R-9'), idOf)
    expect(rows.map((r) => [r.draft.reference, r.draft.amount_minor, r.recorded])).toEqual([
      ['R-9', 2000, false],
      ['R-9', -2000, true],
    ])
    // Known only from the server's list, the saved row's day and amount pick it out, whichever of the two it was.
    const plain = snapshotOf()
    const server = (posted_on: string, amount_minor: number): Recorded => new Map([['R-9', { posted_on, amount_minor }]])
    expect(reviewRows(plain, 'main', read(plain), server('2026-10-06', -2000), idOf).map((r) => r.recorded)).toEqual([false, true])
    expect(reviewRows(plain, 'main', read(plain), server('2026-10-07', 2000), idOf).map((r) => r.recorded)).toEqual([true, false])
    // With the id alone, neither is guessed at: both stay open to tick.
    expect(reviewRows(plain, 'main', read(plain), known('R-9'), idOf).map((r) => r.recorded)).toEqual([false, false])
    expect(reviewRows(plain, 'main', read(plain), NONE, idOf).map((r) => r.recorded)).toEqual([false, false])
  })

  it('makes one checked post_batch of the ticked rows: kind by sign, refunds on request, categories only where they belong', () => {
    const snapshot = snapshotOf()
    const rows = reviewRows(snapshot, 'main', drafts(snapshot).drafts, known('T-4'), idOf)
    const choices = new Map<string, RowChoice>([
      ['T-3', { include: true, refund: true, category: 'cat-groceries', link: false }],
      ['T-2', { include: true, refund: false, category: 'cat-home', link: false }],
      ['T-6', { include: false, refund: false, category: 'cat-groceries', link: false }],
    ])
    const batch = importBatch('main', rows, choices, BATCH, snapshot.doc.categories)
    expect(batch?.batch_id).toBe(BATCH)
    expect(batch?.rows.map((r) => [r.id, r.kind, r.amount_minor, r.category_id, r.plan_item_id, r.period, r.external_id])).toEqual([
      ['id-T-5', 'expense', -3500, null, 'gym', '2026-10-01', 'T-5'],
      ['id-T-3', 'refund', 1240, 'cat-groceries', null, null, 'T-3'],
      // Income takes no category, whatever the person picked before switching it back.
      ['id-T-2', 'income', 150000, null, null, null, 'T-2'],
    ])
    expect(importBatch('main', rows, new Map(rows.map((r) => [r.key, { include: false, refund: false, category: null, link: false }])), BATCH, snapshot.doc.categories)).toBeNull()
  })

  it('never sends a row saved elsewhere since it was ticked', () => {
    const snapshot = snapshotOf()
    const ticked = new Map<string, RowChoice>([['T-6', { include: true, refund: false, category: null, link: false }]])
    const rows = reviewRows(snapshot, 'main', drafts(snapshot).drafts, known('T-6'), idOf)
    const row = rows.find((r) => r.key === 'T-6')
    expect(row && choiceOf(row, ticked).include).toBe(false)
    expect(importBatch('main', rows, ticked, BATCH, snapshot.doc.categories)?.rows.map((r) => r.external_id)).toEqual(['T-5', 'T-4', 'T-3', 'T-2'])
  })

  it('sums the ticked rows to check against the bank, and counts the greyed ones', () => {
    const snapshot = snapshotOf()
    const rows = reviewRows(snapshot, 'main', drafts(snapshot).drafts, known('T-4'), idOf)
    expect(reviewSummary(rows, new Map())).toEqual({ ticked: 4, recorded: 1, entered: 0, in_minor: 151240, out_minor: 3960 })
  })

  it('leaves unticked a row that looks like one entered by hand: same account and amount, no bank reference, within two days', () => {
    // The bakery visit on the 8th was typed in on the 7th; another for the same amount on the 1st is too far off to be it.
    const snapshot = snapshotOf((s) => {
      s.doc.transactions.push({ id: 'by-hand', account_id: 'main', posted_on: '2026-10-07', amount_minor: -460, kind: 'expense', description: 'Bakery' })
      s.doc.transactions.push({ id: 'too-early', account_id: 'main', posted_on: '2026-10-01', amount_minor: -3500, kind: 'expense', description: 'Gym' })
    })
    const rows = reviewRows(snapshot, 'main', drafts(snapshot).drafts, NONE, idOf)
    const bakery = rows.find((r) => r.key === 'T-6')
    expect(bakery?.entered).toEqual({ row_id: 'by-hand', posted_on: '2026-10-07' })
    expect(choiceOf(bakery as (typeof rows)[number], new Map()).include).toBe(false)
    expect(rows.filter((r) => r.key === 'T-5' || r.key === 'T-4').map((r) => r.entered)).toEqual([null, null])
    expect(reviewSummary(rows, new Map())).toMatchObject({ ticked: 4, recorded: 0, entered: 1 })
    // Ticked by hand, it imports anyway.
    const choices = new Map<string, RowChoice>([['T-6', { include: true, refund: false, category: null, link: false }]])
    expect(importBatch('main', rows, choices, BATCH, snapshot.doc.categories)?.rows.map((r) => r.external_id)).toContain('T-6')
  })

  it('lists rows newest first, then the rows left out, each group with its ends marked', () => {
    const snapshot = snapshotOf()
    const read = drafts(snapshot)
    const items = reviewItems(reviewRows(snapshot, 'main', read.drafts, NONE, idOf), read.skipped)
    expect(items.map((i) => [i.type, i.key, 'first' in i ? i.first : null, 'last' in i ? i.last : null])).toEqual([
      ['row', 'T-6', true, false],
      ['row', 'T-5', false, false],
      ['row', 'T-4', false, false],
      ['row', 'T-3', false, false],
      ['row', 'T-2', false, true],
      ['heading', 'skipped', null, null],
      ['skip', 'skip-7', true, true],
    ])
  })

  it('says why a row was left out, without the amount under the mask', () => {
    const main = { name: 'Main', opening_date: '2026-09-01' }
    const day = (iso: string) => iso
    expect(skipWords({ row: 7, problem: 'before_opening', text: '2026-08-31' }, main, false, day)).toBe('Dated 2026-08-31, before Main opens on 2026-09-01.')
    expect(skipWords({ row: 3, problem: 'amount', text: '12,40' }, main, false, day)).toBe('The amount 12,40 does not read.')
    expect(skipWords({ row: 3, problem: 'amount', text: '12,40' }, main, true, day)).toBe('The amount does not read.')
    expect(skipWords({ row: 4, problem: 'date', text: '31/02/2026' }, main, true, day)).toBe('The date 31/02/2026 does not read in the order chosen.')
    expect(skipWords({ row: 5, problem: 'zero', text: '' }, main, false, day)).toBe('The amount is 0.')
  })
})

describe('Import columns', () => {
  it('names each choice still to make in words, and two columns that must differ', () => {
    const blank = { date: null, date_order: null, two_columns: true, amount: null, debit: 'Out', credit: 'Out', decimal: '.', description: null, reference: null } as const
    expect(readMapping(blank)).toEqual({
      ok: false,
      errors: { date: 'Pick the column with each row’s date.', date_order: 'Pick how the dates are written.', description: 'Pick the column that says what each row was.' },
    })
    expect(readMapping({ ...blank, date: 'Date', date_order: 'dmy', description: 'Note' })).toEqual({ ok: false, errors: { credit: 'Money out and money in need two different columns.' } })
    expect(readMapping({ ...blank, date: 'Date', date_order: 'dmy', description: 'Note', credit: 'In' })).toMatchObject({ ok: true })
  })

  it('shows each column’s first value, masking figures that are not a date under the eye', () => {
    expect(columnChoices(table(), false).map((c) => c.detail)).toEqual(['T-6', '08-10-2026', '-4.60', 'Card transaction of 4.60 EUR issued by …', '1944.85'])
    expect(columnChoices(table(), true).map((c) => c.detail)).toEqual(['T-6', '08-10-2026', '•••', 'Card transaction of ••• EUR issued by C…', '•••'])
    expect(columnChoices(table(`Date,Note\n2026-10-01,${'x'.repeat(60)}`), false)[1]?.detail).toBe(`${'x'.repeat(39)}…`)
  })

  it('says how the first date reads in each order', () => {
    expect(dateOrderChoices('08-10-2026', (d) => d).map((c) => c.detail)).toEqual(['08-10-2026 does not read this way', '08-10-2026 is 2026-10-08', '08-10-2026 is 2026-08-10'])
  })

  it('saves a mapping only when it differs from the saved one, keys in any order', () => {
    const saved = { reference: 'ID', description: 'Description', decimal: '.', amount: { column: 'Amount' }, date_order: 'dmy', date: 'Date' }
    expect(mappingChanged(saved, MAPPING)).toBe(false)
    expect(mappingChanged(null, MAPPING)).toBe(true)
    expect(mappingChanged({ ...saved, decimal: ',' }, MAPPING)).toBe(true)
  })

  it('offers open accounts, cash first, and the days a file covers', () => {
    const snapshot = snapshotOf((s) => {
      const tax = s.doc.accounts.find((a) => a.id === 'tax')
      if (tax) tax.archived_at = '2026-10-01T00:00:00+00:00'
    })
    expect(importAccounts(snapshot).map((a) => a.id)).toEqual(['main', 'pesos', 'rewards-card', 'shopping-card'])
    expect(fileDays(drafts(snapshotOf()).drafts)).toEqual({ from: '2026-09-30', to: '2026-10-08' })
    expect(fileDays([])).toBeNull()
  })
})
