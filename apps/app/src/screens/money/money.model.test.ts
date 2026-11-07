import { addDays, buildSnapshot, daysBetween, ledgerSum, type Snapshot } from '@waypoint/core'
import { abroad, mortgage, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { moneyModel, nameRoom, sparkFrom, sparkOf, sparkWidth } from './money.model'

const AS_OF = '2026-10-09'

function snapshotOf(build: (asOf: string) => Sample, edit?: (sample: Sample) => void): Snapshot {
  const sample = build(AS_OF)
  edit?.(sample)
  return buildSnapshot(sample.doc, AS_OF, sample.rates)
}

const account = (doc: SampleDoc, id: string) => doc.accounts.find((a) => a.id === id)!

describe('Money', () => {
  it('lists open cash accounts by currency with a total each, and cards and loans apart', () => {
    const m = moneyModel(snapshotOf(abroad))
    expect(m.groups.map((g) => [g.currency, g.total_minor, g.accounts.map((a) => [a.account_id, a.live_minor])])).toEqual([
      ['EUR', 825000, [['main', 645000], ['tax', 180000]]],
      ['PHP', 3000000, [['pesos', 3000000]]],
    ])
    // A debt keeps its balance below zero here; the screen shows it as owed.
    expect(m.debts.map((a) => [a.account_id, a.kind, a.live_minor])).toEqual([
      ['rewards-card', 'credit_card', -4200000],
      ['shopping-card', 'credit_card', 750000],
    ])
  })

  it('leaves archived accounts out of the list and the totals', () => {
    const m = moneyModel(snapshotOf(abroad, (s) => void (account(s.doc, 'tax').archived_at = '2026-10-01T00:00:00Z')))
    expect(m.groups[0]).toMatchObject({ currency: 'EUR', total_minor: 645000 })
    expect(m.groups[0]!.accounts.map((a) => a.account_id)).toEqual(['main'])
  })

  it('reads the live balance as the bank does: rows entered for later days wait', () => {
    const later = moneyModel(snapshotOf(abroad, (s) => s.doc.transactions.push({ id: 'later', account_id: 'main', posted_on: addDays(AS_OF, 3), amount_minor: -50000, kind: 'expense', description: 'Booked ahead' })))
    expect(later.groups[0]!.accounts[0]).toMatchObject({ account_id: 'main', live_minor: 645000 })
  })

  it('gives one base-currency total, approximate and dated by the oldest rate it used', () => {
    // 8,250.00 euros plus 30,000.00 pesos at 70 to the euro.
    expect(moneyModel(snapshotOf(abroad)).base).toEqual({ kind: 'approx', minor: 825000 + 42857, currency: 'EUR', day: AS_OF })
    const older = snapshotOf(abroad, (s) => (s.rates = s.rates.map((r) => (r.quote === 'PHP' ? { ...r, day: '2026-10-07' } : r))))
    expect(moneyModel(older).base).toMatchObject({ kind: 'approx', day: '2026-10-07' })
  })

  it('never shows a base total of zero when a rate is missing', () => {
    const none = snapshotOf(abroad, (s) => (s.rates = s.rates.filter((r) => r.quote !== 'PHP')))
    expect(moneyModel(none).base).toEqual({ kind: 'missing', currency: 'EUR', missing: ['PHP'] })
  })

  it('needs no converted total when every cash account is in the base currency', () => {
    expect(moneyModel(snapshotOf(mortgage)).base).toEqual({ kind: 'single' })
  })

  it('draws each sparkline from full history: every point is the opening balance plus every row to that day', () => {
    const snapshot = snapshotOf(abroad)
    for (const a of snapshot.doc.accounts) {
      const spark = sparkOf(snapshot, a)
      const from = sparkFrom(AS_OF, a.opening_date)
      expect(spark.length).toBe(daysBetween(from, AS_OF) + 1)
      const sign = a.kind === 'cash' ? 1 : -1
      for (let i = 0; i < spark.length; i += 7) expect(spark[i]).toBe(sign * ledgerSum(snapshot, a.id, addDays(from, i)))
      expect(spark.at(-1)).toBe(sign * ledgerSum(snapshot, a.id, AS_OF))
    }
  })

  it('spans the last 12 months, or less for an account opened since', () => {
    expect(sparkFrom(AS_OF, '2024-01-01')).toBe('2025-10-10')
    expect(daysBetween(sparkFrom(AS_OF, '2024-01-01'), AS_OF) + 1).toBe(365)
    expect(sparkFrom(AS_OF, '2026-09-01')).toBe('2026-09-01')
    // Rows from before the window still count in its first point.
    const old = snapshotOf(abroad, (s) => {
      for (const a of s.doc.accounts) a.opening_date = '2025-01-01'
      s.doc.transactions.push({ id: 'old', account_id: 'main', posted_on: '2025-03-01', amount_minor: 100000, kind: 'income', description: 'Old income' })
    })
    const main = old.doc.accounts.find((a) => a.id === 'main')!
    expect(sparkOf(old, main)[0]).toBe(646000 + 100000)
  })
})

describe('a row’s sparkline', () => {
  const names = ['Main', 'Tax', 'Pesos', 'Rewards card', 'Shopping card']

  it('leaves the name what the tile, the amount column, the chevron and the gaps do not take', () => {
    // 390 wide: a 358 card, less its edges 2, padding 32, tile 36, an 88 amount column, chevron 18 and three 12 gaps.
    expect([nameRoom(390, 88), nameRoom(320, 88), nameRoom(1280, 88)]).toEqual([146, 76, 508])
  })

  it('narrows to 40, then leaves out, so a whole name (Shopping card, 124 at 17 pt) never wraps', () => {
    expect([sparkWidth(nameRoom(1280, 88), names, 17), sparkWidth(nameRoom(390, 88), names, 17), sparkWidth(nameRoom(320, 88), names, 17)]).toEqual([64, 0, 0])
    // Car loan is 77 at 17 pt: 146 less a 40 line and its 12 gap leaves 94.
    expect([sparkWidth(nameRoom(390, 88), ['Main', 'Tax'], 17), sparkWidth(nameRoom(390, 88), ['Main', 'Car loan'], 17)]).toEqual([64, 40])
  })
})
