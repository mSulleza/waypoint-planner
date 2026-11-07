import { describe, expect, it } from 'vitest'
import { abroad, markSize, mortgage, SAMPLE_LIST, SAMPLES, usCardsCar, type Sample } from '../fixtures'
import { relativeTo } from '../fixtures/relative'
import { addDays, addMonths, firstOfMonth, lastDayOfMonth, monthKey } from '../src/dates'
import { fxTerms, grossFor, netOf } from '../src/money'
import { missingRates, toRatesPerEur } from '../src/rates'
import { checkInput } from '../src/schema/common'
import { importDoc } from '../src/schema/import-doc'
import { floorAndTarget, type CardAccount, type CashAccount, type LoanAccount } from '../src/schema/rows'
import type { LoanTerms } from '../src/schema/terms'
import { buildSnapshot, ledgerMonth, ledgerSum, occurrenceId, snapshotIndex, type Snapshot } from '../src/snapshot'

const DATES = ['2026-10-07', '2027-03-15'] as const
const ALL = [...SAMPLES, { id: 'mark-size', title: 'Mark-size household', build: markSize }]
const TABLES = ['accounts', 'categories', 'plan_items', 'statements', 'transactions'] as const

const build = (sample: (asOf: string) => Sample, asOf: string): Snapshot => {
  const { doc, rates } = sample(asOf)
  return buildSnapshot(doc, asOf, rates)
}

function cash(snapshot: Snapshot, id: string): CashAccount {
  const account = snapshotIndex(snapshot).accounts.get(id)
  if (account?.kind !== 'cash') throw new Error(`${id} is not a cash account`)
  return account
}

function loan(snapshot: Snapshot, id: string): LoanAccount {
  const account = snapshotIndex(snapshot).accounts.get(id)
  if (account?.kind !== 'loan') throw new Error(`${id} is not a loan`)
  return account
}

// Payments from the opening balance until the loan is paid, interest rounded half up each month.
function paymentsToClear(balance: number, terms: LoanTerms, extra = 0): number {
  let owed = -balance
  let months = 0
  while (owed > 0) {
    owed += Math.round((owed * terms.annual_rate) / 12)
    owed -= Math.min(owed, terms.payment_minor + extra)
    months += 1
  }
  return months
}

describe('sample households', () => {
  it('offers abroad, us-cards-car and mortgage, and keeps the Mark-size household off the list', () => {
    expect(SAMPLES.map((s) => [s.id, s.title])).toEqual([
      ['abroad', 'EUR income paying PHP debts'],
      ['us-cards-car', 'USD with two cards and a car loan'],
      ['mortgage', 'GBP with a mortgage'],
    ])
    expect(SAMPLES.map((s) => s.build)).toEqual([abroad, usCardsCar, mortgage])
    expect(SAMPLE_LIST.map((s) => [s.id, s.title])).toEqual(SAMPLES.map((s) => [s.id, s.title]))
  })

  it('parses every fixture as an import document on both dates', () => {
    for (const asOf of DATES) {
      for (const sample of ALL) {
        const checked = checkInput(importDoc, sample.build(asOf).doc)
        expect(checked.ok ? [] : checked.errors).toEqual([])
      }
    }
  })

  it('builds a snapshot on both dates with the same row count in every table', () => {
    const counts = (asOf: string) => Object.fromEntries(ALL.map((s) => [s.id, TABLES.map((t) => build(s.build, asOf).doc[t].length)]))
    expect(counts(DATES[0])).toEqual({ abroad: [5, 3, 14, 2, 33], 'us-cards-car': [5, 1, 5, 2, 17], mortgage: [3, 2, 7, 0, 22], 'mark-size': [8, 9, 150, 4, 400] })
    expect(counts(DATES[1])).toEqual(counts(DATES[0]))
  })

  it('sorts every table by id', () => {
    for (const asOf of DATES) {
      for (const sample of ALL) {
        const snapshot = build(sample.build, asOf)
        for (const table of TABLES) {
          const ids = snapshot.doc[table].map((r) => r.id)
          expect(ids).toEqual([...new Set(ids)].sort())
        }
      }
    }
  })

  it('gives each account opening plus its rows up to asOf as its ledger sum', () => {
    for (const asOf of DATES) {
      for (const sample of ALL) {
        const { doc } = sample.build(asOf)
        const snapshot = build(sample.build, asOf)
        for (const account of doc.accounts) {
          const rows = doc.transactions.filter((t) => t.account_id === account.id && t.posted_on <= asOf)
          expect(ledgerSum(snapshot, account.id, asOf)).toBe((account.opening_balance_minor ?? 0) + rows.reduce((sum, t) => sum + t.amount_minor, 0))
        }
      }
    }
  })

  it("ends each ledger month at opening plus every row to the month's end", () => {
    for (const asOf of DATES) {
      for (const sample of ALL) {
        const { doc } = sample.build(asOf)
        const snapshot = build(sample.build, asOf)
        let months = 0
        for (const account of doc.accounts) {
          for (let month = firstOfMonth(account.opening_date); month <= asOf; month = addMonths(month, 1)) {
            const rows = ledgerMonth(snapshot, account.id, monthKey(month))
            const expected = (account.opening_balance_minor ?? 0) + doc.transactions.filter((t) => t.account_id === account.id && t.posted_on <= lastDayOfMonth(month)).reduce((sum, t) => sum + t.amount_minor, 0)
            if (rows.length === 0) continue
            expect(rows.at(-1)?.running_balance_minor).toBe(expected)
            expect(rows.map((r) => r.posted_on + r.id)).toEqual(rows.map((r) => r.posted_on + r.id).sort())
            months += 1
          }
        }
        expect(months).toBe(new Set(doc.transactions.map((t) => t.account_id + t.posted_on.slice(0, 7))).size)
      }
    }
  })

  it('carries a made-up rate for every currency it holds', () => {
    for (const asOf of DATES) {
      for (const sample of ALL) {
        const { doc, rates } = sample.build(asOf)
        expect(missingRates([doc.household.base_currency, ...doc.accounts.map((a) => a.currency)], rates)).toEqual([])
      }
    }
  })

  it('builds on every day of a year with no row recorded after asOf', () => {
    for (let day = 0; day < 365; day++) {
      const asOf = addDays('2026-10-01', day)
      for (const sample of SAMPLES) {
        const snapshot = build(sample.build, asOf)
        expect(snapshot.doc.transactions.filter((t) => t.posted_on > asOf)).toEqual([])
      }
    }
  })
})

describe('abroad', () => {
  it('starts the month with Main just above its floor and a card part Pesos cannot cover from what Main can spare', () => {
    for (const asOf of DATES) {
      const snapshot = build(abroad, asOf)
      const index = snapshotIndex(snapshot)
      const { on } = relativeTo(asOf)
      const [main, pesos] = [cash(snapshot, 'main'), cash(snapshot, 'pesos')]
      const mainSpare = ledgerSum(snapshot, 'main', asOf) - floorAndTarget(main.floor_windows, asOf).floor
      const pesosAboveFloor = ledgerSum(snapshot, 'pesos', asOf) - floorAndTarget(pesos.floor_windows, asOf).floor
      const statement = index.statementsByAccount.get('rewards-card')?.at(-1)
      const paidSinceCut = (index.rowsByAccount.get('rewards-card') ?? []).filter((t) => statement && t.posted_on > statement.cut_date && t.amount_minor > 0)
      const secondPart = (statement?.total_due_minor ?? 0) - paidSinceCut.reduce((sum, t) => sum + t.amount_minor, 0)
      const terms = fxTerms('EUR', 'PHP', toRatesPerEur(snapshot.rates), main.fx_fee_pct ?? 0)
      if (!terms) throw new Error('abroad has no EUR to PHP rate')
      const spareInPesos = netOf(mainSpare, terms.rate, terms.feePct)

      expect([mainSpare, pesosAboveFloor, statement?.total_due_minor, paidSinceCut.map((t) => t.amount_minor), secondPart, spareInPesos]).toEqual([45000, 1000000, 7000000, [2500000], 4500000, 3127950])
      expect(index.accounts.get('rewards-card')).toMatchObject({ terms: { preset: 'PH-daily-unpaid', pay: { mode: 'in_full' }, interest: { method: 'daily_on_unpaid' } } })
      expect(statement?.due_date).toBe(on(0, 16))
      expect([statement?.due_date && statement.due_date > asOf, index.planItems.get('salary')?.starts_on.slice(8)]).toEqual([true, '28'])
      expect(secondPart - pesosAboveFloor).toBeGreaterThan(spareInPesos)
      expect(ledgerSum(snapshot, 'pesos', asOf) - secondPart + spareInPesos).toBeGreaterThan(0)
      expect(grossFor(secondPart - pesosAboveFloor - spareInPesos, terms.rate, terms.feePct)).toBeLessThan(index.planItems.get('salary')?.amount_minor ?? 0)
    }
  })

  it('floors Main at 6,000.00 this month and 3,000.00 from next month to 24 months later, under a 6,000.00 target', () => {
    const snapshot = build(abroad, DATES[0])
    const main = cash(snapshot, 'main')
    expect([floorAndTarget(main.floor_windows, '2026-10'), floorAndTarget(main.floor_windows, '2026-11'), floorAndTarget(main.floor_windows, '2028-11'), floorAndTarget(main.floor_windows, '2028-12')]).toEqual([
      { floor: 600000, target: 600000 },
      { floor: 300000, target: 600000 },
      { floor: 300000, target: 600000 },
      { floor: 600000, target: 600000 },
    ])
    expect([main.fx_fee_pct, cash(snapshot, 'pesos').funded_from_account_id, snapshot.doc.household]).toEqual([
      0.007,
      'main',
      { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-PH', payoff_order: 'avalanche', track_from: '2026-09-01' },
    ])
  })

  it('has a 6,000.00 receivable 10 days out with 4,000.00 linked in slices and 2,000.00 open', () => {
    for (const asOf of DATES) {
      const index = snapshotIndex(build(abroad, asOf))
      const receivable = index.planItems.get('receivable')
      const slices = index.linksByOccurrence.get(occurrenceId('receivable', firstOfMonth(addDays(asOf, 10)))) ?? []
      expect([receivable?.starts_on, receivable?.amount_minor, slices.map((t) => t.amount_minor)]).toEqual([addDays(asOf, 10), 600000, [100000, 300000]])
      expect((receivable?.amount_minor ?? 0) - slices.reduce((sum, t) => sum + t.amount_minor, 0)).toBe(200000)
    }
  })

  it('clears the shopping card statement with a balance conversion credit larger than its total', () => {
    for (const asOf of DATES) {
      const snapshot = build(abroad, asOf)
      const index = snapshotIndex(snapshot)
      const statement = index.statementsByAccount.get('shopping-card')?.at(-1)
      const credits = (index.rowsByAccount.get('shopping-card') ?? []).filter((t) => statement && t.posted_on > statement.cut_date && t.amount_minor > 0)
      expect(credits.map((t) => [t.kind, t.amount_minor])).toEqual([['drawdown', 9000000]])
      expect([statement?.previous_balance_minor, statement?.total_due_minor, (statement?.total_due_minor ?? 0) - 9000000]).toEqual([null, 8000000, -1000000])
      expect(index.accounts.get('shopping-card')).toMatchObject({ terms: { preset: 'PH-round-up', interest: { method: 'average_daily_balance' } } })
    }
  })

  it('bills three installments on first-of-month dates, twelve months each, one of them the balance conversion', () => {
    const snapshot = build(abroad, DATES[0])
    const installments = snapshot.doc.plan_items.filter((p) => p.kind === 'installment')
    expect(installments.map((p) => [p.id, p.from_account_id, p.starts_on, p.ends_on])).toEqual([
      ['cash-loan', 'shopping-card', '2026-11-01', '2027-10-01'],
      ['conversion', 'shopping-card', '2026-10-01', '2027-09-01'],
      ['laptop', 'rewards-card', '2026-06-01', '2027-05-01'],
    ])
  })

  it('draws a cash loan onto the rewards card before its next cut, and bills a card bill before the last cut', () => {
    for (const asOf of DATES) {
      const snapshot = build(abroad, asOf)
      const { on } = relativeTo(asOf)
      const index = snapshotIndex(snapshot)
      expect(index.planItems.get('cash-loan-draw')).toMatchObject({ kind: 'income', to_account_id: 'rewards-card', every: 'once', starts_on: on(0, 18), amount_minor: 2000000 })
      expect([index.planItems.get('streaming')?.from_account_id, index.planItems.get('streaming')?.starts_on, index.statementsByAccount.get('rewards-card')?.at(-1)?.cut_date]).toEqual(['rewards-card', on(-1, 5), on(-1, 20)])
    }
  })

  it('has a one-month negative groceries credit, an estimated bill and one upside', () => {
    const items = build(abroad, DATES[0]).doc.plan_items
    expect(items.filter((p) => p.amount_minor < 0).map((p) => [p.id, p.kind, p.every, p.amount_minor, p.starts_on])).toEqual([['groceries-credit', 'allowance', 'once', -5000, '2026-10-01']])
    expect(items.filter((p) => p.confidence !== 'committed').map((p) => [p.id, p.confidence])).toEqual([
      ['camera-sale', 'upside'],
      ['insurance', 'estimated'],
    ])
  })
})

describe('us-cards-car', () => {
  it('pays an 80.00 minimum on the highest-rate card and sends 300.00 extra from Checking in avalanche order', () => {
    const snapshot = build(usCardsCar, DATES[0])
    const index = snapshotIndex(snapshot)
    const cards = snapshot.doc.accounts.filter((a): a is CardAccount => a.kind === 'credit_card')
    expect(cards.map((c) => [c.id, c.terms.interest.rate, c.terms.minimum.floor_minor, c.terms.pay.mode, index.statementsByAccount.get(c.id)?.at(-1)?.minimum_due_minor])).toEqual([
      ['store-card', 0.1999, 3500, 'minimum', 12211],
      ['travel-card', 0.2499, 8000, 'minimum', 8000],
    ])
    expect(index.planItems.get('extra')).toMatchObject({ kind: 'transfer', from_account_id: 'checking', to_account_id: null, amount_minor: 30000 })
    expect([snapshot.doc.household.payoff_order, index.planItems.get('paycheck')?.every, cash(snapshot, 'checking').funded_from_account_id]).toEqual(['avalanche', '2weeks', 'savings'])
  })

  it('pays the car loan off inside the horizon on its own 60-payment schedule', () => {
    for (const asOf of DATES) {
      const snapshot = build(usCardsCar, asOf)
      const car = loan(snapshot, 'car-loan')
      const lastPayment = addMonths(car.opening_date, paymentsToClear(car.opening_balance_minor, car.terms) - 1)
      expect(paymentsToClear(car.opening_balance_minor, car.terms)).toBe(60)
      expect(monthKey(lastPayment) <= monthKey(addMonths(firstOfMonth(asOf), 60))).toBe(true)
    }
  })
})

describe('mortgage', () => {
  it('pays the mortgage off after the horizon even with 200.00 extra a month', () => {
    const snapshot = build(mortgage, DATES[0])
    const home = loan(snapshot, 'mortgage')
    const index = snapshotIndex(snapshot)
    expect(index.planItems.get('overpayment')).toMatchObject({ kind: 'transfer', from_account_id: null, to_account_id: 'mortgage', amount_minor: 20000 })
    expect(paymentsToClear(home.opening_balance_minor, home.terms, 20000)).toBe(224)
  })

  it('bills escrow on the payment day and budgets two allowances', () => {
    const snapshot = build(mortgage, DATES[1])
    const index = snapshotIndex(snapshot)
    expect([index.planItems.get('escrow')?.starts_on.slice(8), loan(snapshot, 'mortgage').terms.payment_day]).toEqual(['01', 1])
    expect(snapshot.doc.plan_items.filter((p) => p.kind === 'allowance').map((p) => p.category_id)).toEqual(['cat-groceries', 'cat-transport'])
  })
})

describe('markSize', () => {
  it('has 8 accounts, 150 plan items, 4 cards, 25 installments and 400 transactions, 92 of them this month on Main', () => {
    for (const asOf of DATES) {
      const snapshot = build(markSize, asOf)
      const { doc } = snapshot
      expect([doc.accounts.length, doc.plan_items.length, doc.accounts.filter((a) => a.kind === 'credit_card').length, doc.plan_items.filter((p) => p.kind === 'installment').length, doc.transactions.length]).toEqual([8, 150, 4, 25, 400])
      expect(ledgerMonth(snapshot, 'main', monthKey(asOf)).length).toBe(92)
      expect(doc.accounts.filter((a) => a.id !== 'main').map((a) => ledgerMonth(snapshot, a.id, monthKey(asOf)).length).every((n) => n < 92)).toBe(true)
    }
  })
})
