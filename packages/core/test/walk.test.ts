import { afterEach, describe, expect, it, vi } from 'vitest'
import { markSize, mortgage, SAMPLES, usCardsCar } from '../fixtures'
import { addDays, addMonths, firstOfMonth, lastDayOfMonth, monthKey } from '../src/dates'
import type { CardModule } from '../src/engine/debts'
import { expandPlan, spreadShares } from '../src/engine/events'
import { fundingCurrency, realisedRate } from '../src/engine/fx'
import { horizonEnd } from '../src/engine/occurrences'
import { monthFigures } from '../src/engine/rollup'
import { walk } from '../src/engine/walk'
import { netOf } from '../src/money'
import { termsFromPreset } from '../src/presets'
import { buildSnapshot, ledgerSum } from '../src/snapshot'
import { abroadAt, item } from './plan-helpers'
import { account, balanceOn, cashHousehold, payEnteredStatements, topUpPairs, walked } from './walk-helpers'

const DATES = ['2026-10-07', '2027-03-15'] as const
const ALL = [...SAMPLES.map((s) => s.build), markSize]
const window = (amount_minor: number, from_month = '2026-10', to_month: string | null = null) => ({ from_month, to_month, amount_minor })

afterEach(() => {
  vi.useRealTimers()
})

describe('the day walk', () => {
  it('starts every account at its ledger sum on as_of and never walks a past day', () => {
    for (const asOf of DATES) {
      for (const build of ALL) {
        const { doc, rates } = build(asOf)
        const snapshot = buildSnapshot(doc, asOf, rates)
        const w = walked(snapshot, { cards: payEnteredStatements })
        for (const a of snapshot.doc.accounts) expect([a.id, w.start.get(a.id)]).toEqual([a.id, ledgerSum(snapshot, a.id, asOf)])
        expect([w.days[0], w.days.at(-1), w.months[0], w.lines.filter((l) => l.date < asOf)]).toEqual([asOf, horizonEnd(asOf), monthKey(asOf), []])
      }
    }
    // Anything gated by cash follows the starting cash: with 50,000.00 more in Pesos, abroad needs no top-up this month.
    const richer = walked(
      abroadAt('2026-10-07', (doc) => {
        account(doc, 'pesos').opening_balance_minor = 8225000
      }),
      { cards: payEnteredStatements },
    )
    expect([richer.start.get('pesos'), topUpPairs(richer).filter(([day]) => day <= '2026-10-31')]).toEqual([8000000, []])
  })

  it('keeps a month for every month from this one to the 60th after it', () => {
    for (const asOf of DATES) {
      const w = walked(abroadAt(asOf))
      expect(w.months).toEqual(Array.from({ length: 61 }, (_, k) => monthKey(addMonths(firstOfMonth(asOf), k))))
      for (const [id, list] of w.figures) {
        expect([id, list.map((f) => f.month)]).toEqual([id, w.months])
        expect(list.map((f) => [f.first_day, f.last_day])).toEqual(w.months.map((m, k) => [k === 0 ? asOf : `${m}-01`, lastDayOfMonth(m)]))
      }
      expect([...w.figures.keys()]).toEqual(['main', 'pesos', 'tax'])
      expect(monthFigures(w, 'main', addMonths(asOf, 60))?.month).toBe(w.months[60])
      expect(monthFigures(w, 'main', addMonths(asOf, -1))).toBeNull()
      expect(() => monthFigures(w, 'main', addMonths(asOf, 61))).toThrow(RangeError)
      expect(() => monthFigures(w, 'rewards-card', asOf)).toThrow(RangeError)
    }
  })

  it('credits the net of a cross-currency transfer at the source fee and posts both legs the same day', () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      doc.plan_items.push(
        item({ id: 'send', kind: 'transfer', from_account_id: 'bank', to_account_id: 'pesos', amount_minor: 10000, starts_on: '2026-10-15', every: 'once' }),
        item({ id: 'back', kind: 'transfer', from_account_id: 'pesos', to_account_id: 'bank', amount_minor: 70000, starts_on: '2026-10-15', every: 'once' }),
      )
    })
    const w = walked(snapshot)
    // Bank pays its 0.5% fee on the way out; Pesos has no fee set, so its money moves at the bare rate.
    expect(w.lines.filter((l) => l.kind === 'transfer').map((l) => [l.id, l.date, l.account_id, l.amount_minor, l.pair_id])).toEqual([
      ['back:2026-10-01#in', '2026-10-15', 'bank', 1000, 'back:2026-10-01#out'],
      ['back:2026-10-01#out', '2026-10-15', 'pesos', -70000, 'back:2026-10-01#in'],
      ['send:2026-10-01#in', '2026-10-15', 'pesos', 696500, 'send:2026-10-01#out'],
      ['send:2026-10-01#out', '2026-10-15', 'bank', -10000, 'send:2026-10-01#in'],
    ])
    expect([balanceOn(w, 'bank', '2026-10-14'), balanceOn(w, 'bank', '2026-10-15'), balanceOn(w, 'pesos', '2026-10-14'), balanceOn(w, 'pesos', '2026-10-15')]).toEqual([500000, 491000, 1000000, 1626500])
  })

  it('derives a recorded transfer rate from its two legs, fee included', () => {
    const snapshot = abroadAt('2026-10-07')
    expect(realisedRate(snapshot, 'topup-last')).toEqual({ sent: { minor: 60000, currency: 'EUR' }, received: { minor: 4170000, currency: 'PHP' }, rate: 69.5 })
    expect(realisedRate(snapshot, 'topup-now').rate).toBe(69.5)
    expect(() => realisedRate(snapshot, 'nope')).toThrow(RangeError)
    // A recorded transfer still in flight moves each account on its own leg's date, at the amounts the bank gave.
    const w = walked(
      cashHousehold('2026-10-07', (doc) => {
        doc.transactions.push(
          { id: 'away-out', account_id: 'bank', posted_on: '2026-10-10', amount_minor: -10000, kind: 'transfer', transfer_id: 'away' },
          { id: 'away-in', account_id: 'pesos', posted_on: '2026-10-12', amount_minor: 690000, kind: 'transfer', transfer_id: 'away' },
        )
      }),
    )
    expect([balanceOn(w, 'bank', '2026-10-10'), balanceOn(w, 'pesos', '2026-10-11'), balanceOn(w, 'pesos', '2026-10-12')]).toEqual([490000, 1000000, 1690000])
  })

  it('sums two inflows on one day and converts a cross-currency one net of fee', () => {
    const w = walked(
      cashHousehold('2026-10-07', (doc) => {
        doc.plan_items.push(
          item({ id: 'lodger', kind: 'income', to_account_id: 'pesos', amount_minor: 100000, starts_on: '2026-10-20' }),
          item({ id: 'refund', kind: 'income', to_account_id: 'pesos', amount_minor: 50000, starts_on: '2026-10-20', every: 'once' }),
          item({ id: 'send', kind: 'transfer', from_account_id: 'bank', to_account_id: 'pesos', amount_minor: 10000, starts_on: '2026-10-20', every: 'once' }),
        )
      }),
    )
    expect(balanceOn(w, 'pesos', '2026-10-20') - balanceOn(w, 'pesos', '2026-10-19')).toBe(100000 + 50000 + 696500)
    expect([monthFigures(w, 'pesos', '2026-10')?.in_minor, monthFigures(w, 'pesos', '2026-11')?.in_minor]).toEqual([846500, 100000])
  })

  it('spends each allowance share the plan expanded, so screens and the walk read the same data', () => {
    const snapshot = abroadAt('2026-10-07')
    const plan = expandPlan(snapshot)
    const w = walked(snapshot)
    const budget = plan.budgets.find((b) => b.category_id === 'cat-groceries' && b.month === '2026-10')
    const event = plan.events.find((e) => e.id === 'allowance:main:cat-groceries:2026-10')
    if (!event) throw new Error('abroad has no October groceries allowance')
    const line = w.lines.find((l) => l.id === event.id)
    expect([line?.amount_minor, line?.date, line?.until, line?.kind]).toEqual([-(budget?.shares[0]?.amount_minor ?? 0), '2026-10-07', '2026-10-31', 'allowance'])
    const shares = spreadShares(event)
    // Main has nothing else from the 8th until payday on the 28th.
    for (let k = 1; k < 21; k++) {
      const day = addDays('2026-10-07', k)
      expect([day, balanceOn(w, 'main', day) - balanceOn(w, 'main', addDays(day, -1))]).toEqual([day, shares[k]])
    }
  })

  it('lets a card payment drive cash below zero and reports the lowest day', () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      doc.accounts.push({
        id: 'card',
        name: 'Card',
        kind: 'credit_card',
        currency: 'EUR',
        opening_balance_minor: -900000,
        opening_date: '2026-01-01',
        funded_from_account_id: 'bank',
        terms: termsFromPreset('US-generic', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' }),
      })
      doc.statements.push({ id: 'september', account_id: 'card', cut_date: '2026-09-20', due_date: '2026-10-16', total_due_minor: 900000, minimum_due_minor: 27000 })
    })
    const w = walked(snapshot, { cards: payEnteredStatements })
    const bank = monthFigures(w, 'bank', '2026-10')
    expect([bank?.lowest_minor, bank?.lowest_on, bank?.closing_minor, bank?.word, balanceOn(w, 'card', '2026-10-16')]).toEqual([-400000, '2026-10-16', -400000, 'Short', 0])
    expect(w.lines.filter((l) => l.kind === 'payment').map((l) => [l.id, l.source, l.account_id, l.amount_minor])).toEqual([
      ['pay:card:2026-09-20#in', 'card', 'card', 900000],
      ['pay:card:2026-09-20#out', 'card', 'bank', -900000],
    ])
  })

  it('counts days under the floor and the lowest day, so moving payday from the 28th to the 30th adds two short days', () => {
    const october = (payday: number) =>
      monthFigures(
        walked(
          cashHousehold('2026-10-07', (doc) => {
            account(doc, 'bank').floor_windows = [window(450000)]
            doc.plan_items.push(
              item({ id: 'rent', kind: 'bill', from_account_id: 'bank', amount_minor: 100000, starts_on: '2026-10-20', every: 'once' }),
              item({ id: 'pay', kind: 'income', to_account_id: 'bank', amount_minor: 200000, starts_on: `2026-10-${payday}`, every: 'once' }),
            )
          }),
        ),
        'bank',
        '2026-10',
      )
    const [early, late] = [october(28), october(30)]
    expect([early?.days_under_floor, late?.days_under_floor, early?.lowest_minor, early?.lowest_on, early?.closing_minor, late?.closing_minor]).toEqual([8, 10, 400000, '2026-10-20', 600000, 600000])
  })

  it('labels a funding cycle, a non-cash funder, a statement on a cash account, a row before opening and a missing rate', () => {
    const card = { id: 'card', name: 'Card', kind: 'credit_card' as const, currency: 'EUR', opening_date: '2026-01-01', funded_from_account_id: 'bank', terms: termsFromPreset('US-generic', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' }) }
    const errors = (edit: Parameters<typeof cashHousehold>[1]) => {
      const result = walk(cashHousehold('2026-10-07', edit))
      return result.ok ? [] : result.errors.map((e) => [e.code, e.ids, e.message])
    }
    expect(
      errors((doc) => {
        account(doc, 'bank').funded_from_account_id = 'savings'
        account(doc, 'savings').funded_from_account_id = 'bank'
      }),
    ).toEqual([['funding_cycle', ['bank', 'savings'], "'bank', 'savings' fund each other in a circle; funding runs one way"]])
    expect(
      errors((doc) => {
        doc.accounts.push(card)
        account(doc, 'savings').funded_from_account_id = 'card'
      }),
    ).toEqual([['non_cash_funder', ['savings', 'card'], "'savings' is funded from 'card', which is not a cash account"]])
    expect(
      errors((doc) => {
        doc.statements.push({ id: 'st', account_id: 'bank', cut_date: '2026-09-20', due_date: '2026-10-05', total_due_minor: 1000, minimum_due_minor: 0 })
      }),
    ).toEqual([['statement_not_on_card', ['st', 'bank'], "Statement 'st' is on 'bank', which is not a credit card"]])
    expect(
      errors((doc) => {
        doc.transactions.push({ id: 'old', account_id: 'bank', posted_on: '2025-12-31', amount_minor: -100, kind: 'expense' })
      }),
    ).toEqual([['row_before_opening', ['old', 'bank'], "Transaction 'old' on 'bank' is dated 2025-12-31, before the account opens on 2026-01-01"]])
    expect(
      errors((doc) => {
        doc.accounts.push({ id: 'pounds', name: 'Pounds', kind: 'cash', currency: 'GBP', opening_date: '2026-01-01', funded_from_account_id: 'bank' })
      }),
    ).toEqual([['missing_rate', ['bank', 'pounds'], "No reference rate for GBP, so money cannot move between 'bank', 'pounds'"]])
    expect(walk(cashHousehold('2026-10-07'))).toMatchObject({ ok: true })
  })

  it('moves the funding currency by fx_shift_pct', () => {
    const asOf = '2026-10-07'
    expect([fundingCurrency(abroadAt(asOf)), ...[usCardsCar, mortgage].map((b) => fundingCurrency(buildSnapshot(b(asOf).doc, asOf, b(asOf).rates)))]).toEqual(['EUR', null, null])
    const funder = (base: string, savingsFirst: boolean) =>
      cashHousehold(asOf, (doc) => {
        doc.household.base_currency = base
        Object.assign(account(doc, 'savings'), { sort_order: savingsFirst ? 1 : 3 })
        account(doc, 'bank').funded_from_account_id = 'pesos'
        doc.plan_items.push(item({ id: 'move', kind: 'transfer', from_account_id: 'savings', to_account_id: 'pesos', amount_minor: 1000, starts_on: '2026-11-01' }))
      })
    // Pesos funds Bank and Savings sends into pesos: the base currency wins when it is among them, else the first sender by sort order.
    expect([funder('PHP', true), funder('EUR', false), funder('USD', true), funder('USD', false)].map(fundingCurrency)).toEqual(['PHP', 'EUR', 'EUR', 'PHP'])

    const weaker = walked(abroadAt(asOf), { cards: payEnteredStatements, fx_shift_pct: -0.1 })
    expect([weaker.funding_currency, weaker.rates.EUR, weaker.rates.PHP]).toEqual(['EUR', 1, 63])
    expect(topUpPairs(weaker)[0]).toEqual(['2026-10-16', 'main', 'pesos', 37000, netOf(37000, 63, 0.007)])
    const pesoWeaker = walked(funder('PHP', true), { fx_shift_pct: -0.1 })
    expect([pesoWeaker.funding_currency, pesoWeaker.rates.PHP]).toEqual(['PHP', 77.7777777778])
    expect(walked(cashHousehold(asOf), { fx_shift_pct: -0.1 }).rates).toEqual({ EUR: 1, PHP: 70 })
    expect(() => walk(abroadAt(asOf), { fx_shift_pct: -1 })).toThrow(RangeError)
  })

  it('gives the same result for the same input, whatever the clock says', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2031-06-30T23:00:00Z'))
    const late = walked(abroadAt('2026-10-07'), { cards: payEnteredStatements })
    vi.setSystemTime(new Date('1999-01-01T00:00:00Z'))
    const early = walked(abroadAt('2026-10-07'), { cards: payEnteredStatements })
    expect(early).not.toBe(late)
    expect(early).toEqual(late)
  })

  it('skips line items in metrics mode and keeps the same balances and figures', () => {
    const snapshot = abroadAt('2026-10-07')
    const full = walked(snapshot, { cards: payEnteredStatements })
    const metrics = walked(snapshot, { cards: payEnteredStatements, mode: 'metrics' })
    expect([metrics.mode, metrics.lines, full.lines.length > 400]).toEqual(['metrics', [], true])
    expect([metrics.start, metrics.balances, metrics.figures]).toEqual([full.start, full.balances, full.figures])
  })

  it('puts every event the plan counts on a line, two for a transfer', () => {
    for (const asOf of DATES) {
      for (const build of ALL) {
        const { doc, rates } = build(asOf)
        const snapshot = buildSnapshot(doc, asOf, rates)
        const plan = expandPlan(snapshot)
        const w = walked(snapshot)
        const lines = new Map(w.lines.map((l) => [l.id, l]))
        let expected = 0
        for (const e of plan.events) {
          if (e.kind === 'transfer') {
            expect([lines.get(`${e.id}#out`)?.amount_minor, lines.get(`${e.id}#in`)?.account_id]).toEqual([e.amount_minor, e.to_account_id])
            expected += 2
          } else {
            expect([e.id, lines.get(e.id)?.amount_minor, lines.get(e.id)?.account_id]).toEqual([e.id, e.amount_minor, e.account_id])
            expected += 1
          }
        }
        expect(w.lines.filter((l) => l.source !== 'top_up').length).toBe(expected)
      }
    }
  })

  it('walks with cards and loans removed through modules that still take their events', () => {
    const snapshot = abroadAt('2026-10-07')
    const cards = new Set(snapshot.doc.accounts.filter((a) => a.kind === 'credit_card').map((a) => a.id))
    const seen: string[] = []
    const watcher: CardModule = {
      kind: 'credit_card',
      walk: ({ events, accounts }) => {
        seen.push(...events.map((e) => e.id))
        return { moves: [], summary: accounts.map((a) => a.id) }
      },
    }
    const w = walked(snapshot, { cards: watcher })
    expect(seen).toEqual(expandPlan(snapshot).events.filter((e) => cards.has(e.account_id)).map((e) => e.id))
    expect([w.cards, w.loans, walked(snapshot).cards]).toEqual([['rewards-card', 'shopping-card'], null, null])
    // With no card module a card moves only by its events: charges dated before as_of land on as_of.
    const before = expandPlan(snapshot).events.filter((e) => e.account_id === 'rewards-card' && e.date <= '2026-10-07')
    expect(balanceOn(w, 'rewards-card', '2026-10-07')).toBe(ledgerSum(snapshot, 'rewards-card', '2026-10-07') + before.reduce((sum, e) => sum + e.amount_minor, 0))
    const stray: CardModule = { kind: 'credit_card', walk: () => ({ moves: [{ id: 'x', kind: 'payment', order: 4, date: '2040-01-01', account_id: 'rewards-card', from_account_id: 'pesos', amount_minor: 1, overdue: false, occurrence_ids: [] }], summary: null }) }
    expect(() => walk(snapshot, { cards: stray })).toThrow('outside the walk')
  })
})
