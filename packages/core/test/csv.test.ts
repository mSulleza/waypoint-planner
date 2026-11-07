/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import {
  csvDrafts,
  csvMappingDraft,
  descriptionKey,
  guessCsvMapping,
  readCsv,
  readCsvAmount,
  readCsvDay,
  readCsvMappingDraft,
  savedMapping,
  type CsvMapping,
  type CsvTable,
} from '../src/csv'
import { fnv1a64 } from '../src/hash'
import paidOutIn from './fixtures/csv/paid-out-in.csv?raw'
import semicolons from './fixtures/csv/semicolons.csv?raw'
import wise from './fixtures/csv/wise-statement.csv?raw'

const EUR = { currency: 'EUR', opening_date: '2026-09-01' }
const GBP = { currency: 'GBP', opening_date: '2026-09-01' }

function table(text: string): CsvTable {
  const file = readCsv(text)
  if (!file.ok) throw new Error(file.error)
  return file.table
}

function drafts(text: string, mapping: CsvMapping, account = EUR) {
  const read = csvDrafts(table(text), mapping, account)
  if (!read.ok) throw new Error(read.errors.join('; '))
  return read.value
}

const WISE: CsvMapping = { date: 'Date', date_order: 'dmy', amount: { column: 'Amount' }, decimal: '.', description: 'Description', reference: 'TransferWise ID' }
const PAID: CsvMapping = { date: 'Date', date_order: 'dmy', amount: { debit: 'Paid out', credit: 'Paid in' }, decimal: '.', description: 'Description', reference: null }
const hashId = (key: string) => `csv:${fnv1a64(key)}`

describe('readCsv', () => {
  it('reads a Wise statement: its header, quoted cells and every row', () => {
    const t = table(wise)
    expect(t.header.slice(0, 5)).toEqual(['TransferWise ID', 'Date', 'Amount', 'Currency', 'Description'])
    expect(t.rows).toHaveLength(8)
    expect(t.rows[0]?.[4]).toBe('Card transaction of 4.60 EUR issued by Corner Bakery')
  })

  it('drops a byte order mark, keeps a comma inside quotes, and finds semicolons', () => {
    expect(table(paidOutIn).header[0]).toBe('Date')
    expect(table(paidOutIn).rows[3]?.[2]).toBe('EXAMPLE LTD, SALARY')
    expect(table(semicolons).header).toEqual(['Buchungstag', 'Valutadatum', 'Verwendungszweck', 'Betrag', 'Saldo'])
  })

  it('names blank and repeated header cells so a mapping can tell them apart', () => {
    expect(table('Date,,Amount,Amount\n2026-10-01,x,1.00,2.00').header).toEqual(['Date', 'Column 2', 'Amount', 'Amount (2)'])
  })

  it('refuses a file with no rows, one column or an open quote', () => {
    expect(readCsv('Date,Amount\n')).toEqual({ ok: false, error: 'The file has a header and no rows under it.' })
    expect(readCsv('just one column\nanother line').ok).toBe(false)
    expect(readCsv('Date,Amount\n2026-10-01,"1.00\n').ok).toBe(false)
  })
})

describe('readCsvDay', () => {
  it.each([
    ['2026-10-07', 'ymd', '2026-10-07'],
    ['2026/10/07', 'ymd', '2026-10-07'],
    ['20261007', 'ymd', '2026-10-07'],
    ['2026-10-07T14:33:05Z', 'ymd', '2026-10-07'],
    ['2026-10-07 14:33:05', 'ymd', '2026-10-07'],
    ['07-10-2026', 'dmy', '2026-10-07'],
    ['7.10.2026', 'dmy', '2026-10-07'],
    ['07/10/26', 'dmy', '2026-10-07'],
    ['10/07/2026', 'mdy', '2026-10-07'],
    ['10/7/26 9:15 AM', 'mdy', '2026-10-07'],
  ] as const)('reads %s in %s order as %s', (text, order, day) => {
    expect(readCsvDay(text, order)).toBe(day)
  })

  it.each([
    ['31/02/2026', 'dmy'],
    ['07-13-2026', 'dmy'],
    ['2026-10-07', 'dmy'],
    ['07-10-2026', 'ymd'],
    ['26-10-07', 'ymd'],
    ['07-10-20261', 'dmy'],
    ['Oct 7, 2026', 'mdy'],
    ['', 'ymd'],
  ] as const)('does not read %s in %s order', (text, order) => {
    expect(readCsvDay(text, order)).toBeNull()
  })
})

describe('readCsvAmount', () => {
  it.each([
    ['-4.60', '.', 'EUR', -460],
    ['1,250.00', '.', 'EUR', 125000],
    ['+12.40', '.', 'EUR', 1240],
    ['(18.75)', '.', 'EUR', -1875],
    ['18.75-', '.', 'EUR', -1875],
    ['€ 12.40', '.', 'EUR', 1240],
    ['-4,60', ',', 'EUR', -460],
    ['2.100,00', ',', 'EUR', 210000],
    ['1 234,56', ',', 'EUR', 123456],
    ['1500', '.', 'JPY', 1500],
  ] as const)('reads %s with %s as the decimal mark in %s as %d', (text, decimal, currency, minor) => {
    expect(readCsvAmount(text, decimal, currency)).toBe(minor)
  })

  it('does not read text, a third decimal in EUR, or a comma decimal under a point mapping', () => {
    expect(readCsvAmount('n/a', '.', 'EUR')).toBeNull()
    expect(readCsvAmount('4.605', '.', 'EUR')).toBeNull()
    expect(readCsvAmount('4,60', '.', 'EUR')).toBeNull()
  })
})

describe('csvDrafts', () => {
  it('drafts each Wise row with its amount read once, its kind by sign and the bank id as external id', () => {
    const { drafts: rows, skipped } = drafts(wise, WISE)
    expect(skipped).toEqual([])
    expect(rows.map((r) => [r.row, r.posted_on, r.amount_minor, r.kind, r.external_id])).toEqual([
      [2, '2026-10-08', -460, 'expense', 'CARD-900000108'],
      [3, '2026-10-07', -2315, 'expense', 'CARD-900000107'],
      [4, '2026-10-05', -3500, 'expense', 'TRANSFER-900000106'],
      [5, '2026-10-04', -240, 'expense', 'CARD-900000105'],
      [6, '2026-10-04', -240, 'expense', 'CARD-900000104'],
      [7, '2026-10-02', -50000, 'expense', 'TRANSFER-900000103'],
      [8, '2026-10-01', 1240, 'income', 'CARD-900000102'],
      [9, '2026-09-30', 150000, 'income', 'TRANSFER-900000101'],
    ])
    expect(rows[0]?.description).toBe('Card transaction of 4.60 EUR issued by Corner Bakery')
  })

  it('reads money out and money in from two columns, with or without a minus on money out', () => {
    const { drafts: rows } = drafts(paidOutIn, PAID, GBP)
    expect(rows.map((r) => [r.posted_on, r.amount_minor, r.kind, r.description])).toEqual([
      ['2026-10-03', -320, 'expense', 'CORNER SHOP'],
      ['2026-10-03', -320, 'expense', 'CORNER SHOP'],
      ['2026-10-03', -320, 'expense', 'CORNER SHOP'],
      ['2026-10-04', 125000, 'income', 'EXAMPLE LTD, SALARY'],
      ['2026-10-05', -1875, 'expense', 'CITY WATER'],
    ])
  })

  it('tells identical rows apart by their place among them, the same way on every read', () => {
    const ids = drafts(paidOutIn, PAID, GBP).drafts.map((r) => r.external_id)
    expect(ids.slice(0, 3)).toEqual([hashId('2026-10-03|-320|CORNER SHOP|0'), hashId('2026-10-03|-320|CORNER SHOP|1'), hashId('2026-10-03|-320|CORNER SHOP|2')])
    expect(new Set(ids).size).toBe(ids.length)
    expect(drafts(paidOutIn, PAID, GBP).drafts.map((r) => r.external_id)).toEqual(ids)
    // A later export that overlaps this one names the same rows the same way.
    const later = `${paidOutIn.trimEnd()}\n07/10/2026,DEB,CORNER SHOP,3.20,,987.20\n`
    expect(drafts(later, PAID, GBP).drafts.map((r) => r.external_id).slice(0, 5)).toEqual(ids)
  })

  it('leaves out rows whose date or amount does not read, a 0, and a row before the account opens', () => {
    expect(drafts(paidOutIn, PAID, GBP).skipped).toEqual([
      { row: 7, problem: 'amount', text: '' },
      { row: 8, problem: 'date', text: '31/02/2026' },
    ])
    const { drafts: rows, skipped } = drafts('Date,Amount,Note\n2026-08-31,-1.00,Before\n2026-09-01,0.00,Zero\n2026-09-01,-x,Text\n2026-09-01,-2.00,Kept', {
      date: 'Date',
      date_order: 'ymd',
      amount: { column: 'Amount' },
      decimal: '.',
      description: 'Note',
      reference: null,
    })
    expect(skipped).toEqual([
      { row: 2, problem: 'before_opening', text: '2026-08-31' },
      { row: 3, problem: 'zero', text: '' },
      { row: 4, problem: 'amount', text: '-x' },
    ])
    expect(rows.map((r) => r.description)).toEqual(['Kept'])
  })

  it('hashes rows whose reference repeats in the file, since it names neither alone, and keeps the printed reference beside each', () => {
    const text = 'Date,Amount,Note,Ref\n2026-10-01,-5.00,Rent share,RENT\n2026-10-02,-6.00,Rent share,RENT\n2026-10-03,-7.00,Other,X1\n2026-10-04,-8.00,No ref,'
    const { drafts: rows } = drafts(text, { date: 'Date', date_order: 'ymd', amount: { column: 'Amount' }, decimal: '.', description: 'Note', reference: 'Ref' })
    expect(rows.map((r) => r.external_id)).toEqual([hashId('2026-10-01|-500|Rent share|0'), hashId('2026-10-02|-600|Rent share|0'), 'X1', hashId('2026-10-04|-800|No ref|0')])
    expect(rows.map((r) => r.reference)).toEqual(['RENT', 'RENT', 'X1', ''])
  })

  it('reads a semicolon file with comma decimals and dotted dates', () => {
    const { drafts: rows } = drafts(semicolons, { date: 'Buchungstag', date_order: 'dmy', amount: { column: 'Betrag' }, decimal: ',', description: 'Verwendungszweck', reference: null })
    expect(rows.map((r) => [r.posted_on, r.amount_minor, r.description])).toEqual([
      ['2026-10-07', -460, 'Bäckerei Beispiel'],
      ['2026-10-06', 210000, 'Gehalt Beispiel GmbH'],
    ])
  })

  it('collapses spaces and keeps at most 140 characters of a description', () => {
    const long = 'A'.repeat(150)
    const { drafts: rows } = drafts(`Date,Amount,Note\n2026-10-01,-1.00,"  Two   words "\n2026-10-01,-1.00,${long}`, { date: 'Date', date_order: 'ymd', amount: { column: 'Amount' }, decimal: '.', description: 'Note', reference: null })
    expect(rows.map((r) => r.description)).toEqual(['Two words', 'A'.repeat(140)])
  })

  it('names the columns a mapping wants that the file lacks', () => {
    expect(csvDrafts(table(paidOutIn), WISE, EUR)).toEqual({ ok: false, errors: ['The file has no column named Amount.', 'The file has no column named TransferWise ID.'] })
  })
})

describe('mappings', () => {
  it('guesses a Wise statement: day first, one signed column, points, and the id as reference', () => {
    expect(guessCsvMapping(table(wise), 'en-US')).toEqual({ ...csvMappingDraft(WISE) })
  })

  it('guesses money out and money in, and a comma decimal from the figures', () => {
    expect(guessCsvMapping(table(paidOutIn), 'en-GB')).toEqual(csvMappingDraft(PAID))
    expect(guessCsvMapping(table(semicolons), 'en-US')).toMatchObject({ date: 'Buchungstag', date_order: 'dmy', amount: 'Betrag', decimal: ',', description: 'Verwendungszweck', reference: null })
  })

  it('settles day or month first by the dates that read, then the shorter span, then the household locale', () => {
    const t = table('Date,Amount,Note\n05/10/2026,-1.00,x')
    expect(guessCsvMapping(t, 'en-US').date_order).toBe('mdy')
    expect(guessCsvMapping(t, 'en-GB').date_order).toBe('dmy')
    // 3 to 6 October is four days; 10 March to 10 June would be three months.
    expect(guessCsvMapping(table('Date,Amount,Note\n03/10/2026,-1.00,x\n06/10/2026,-2.00,y'), 'en-US').date_order).toBe('dmy')
    expect(guessCsvMapping(table('Date,Amount,Note\n10/03/2026,-1.00,x\n10/06/2026,-2.00,y'), 'en-GB').date_order).toBe('mdy')
    expect(guessCsvMapping(table('Date,Amount,Note\n13/10/2026,-1.00,x'), 'en-US').date_order).toBe('dmy')
    expect(guessCsvMapping(table('Date,Amount,Note\nsoon,-1.00,x'), 'en-US').date_order).toBeNull()
  })

  it('never guesses a free-text Reference column', () => {
    expect(guessCsvMapping(table('Date,Amount,Description,Reference\n2026-10-01,-1.00,Rent,RENT'), 'en-GB').reference).toBeNull()
  })

  it('reads a draft back as a mapping and names each field still missing or in conflict', () => {
    expect(readCsvMappingDraft(csvMappingDraft(PAID))).toEqual({ ok: true, value: PAID })
    const fields = (draft: Parameters<typeof readCsvMappingDraft>[0]) => {
      const read = readCsvMappingDraft(draft)
      return read.ok ? [] : read.errors.map((e) => e.split(':')[0])
    }
    expect(fields({ ...csvMappingDraft(PAID), description: null, date_order: null })).toEqual(['date_order', 'description'])
    expect(fields({ ...csvMappingDraft(PAID), credit: 'Paid out' })).toEqual(['amount.credit'])
    expect(fields({ ...csvMappingDraft(WISE), amount: null })).toEqual(['amount.column'])
  })

  it('reuses a saved mapping only while every column it names is in the file', () => {
    expect(savedMapping(WISE, table(wise))).toEqual(WISE)
    expect(savedMapping(WISE, table(paidOutIn))).toBeNull()
    expect(savedMapping({ date: 'Date' }, table(wise))).toBeNull()
    expect(savedMapping(null, table(wise))).toBeNull()
  })
})

describe('descriptionKey', () => {
  it('matches one shop at two amounts, ignoring case, figures and punctuation', () => {
    expect(descriptionKey('Card transaction of 4.60 EUR issued by Corner Bakery')).toBe('card transaction of eur issued by corner bakery')
    expect(descriptionKey('CARD TRANSACTION of 12,40 eur issued by Corner  Bakery')).toBe(descriptionKey('Card transaction of 4.60 EUR issued by Corner Bakery'))
    expect(descriptionKey('Refunded by Corner Bakery')).not.toBe(descriptionKey('Issued by Corner Bakery'))
  })
})
