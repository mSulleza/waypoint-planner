import { afterEach, describe, expect, it, vi } from 'vitest'
import { abroad, markSize, mortgage, SAMPLES, usCardsCar } from '../fixtures'
import { relativeTo } from '../fixtures/relative'
import { expandPlan, spreadShares } from '../src/engine/events'
import { cutOnOrAfter, latestCut } from '../src/engine/occurrences'
import { ORDER, type ExpandedPlan } from '../src/engine/types'
import { buildSnapshot, ledgerMonth, ledgerSum, snapshotIndex } from '../src/snapshot'
import { CARDS } from '../src/engine/cards'
import { LOANS } from '../src/engine/loans'
import { advise } from './advice-helpers'
import { abroadAt, bare, counted, item, occurrence } from './plan-helpers'
import { balanceOn, walked } from './walk-helpers'

const DATES = ['2026-10-07', '2027-03-15'] as const
const ALL = [...SAMPLES.map((s) => s.build), markSize]
const cashIds = (plan: ExpandedPlan, snapshot: ReturnType<typeof abroadAt>) => {
  const accounts = snapshotIndex(snapshot).accounts
  return new Set(plan.events.map((e) => e.account_id).filter((id) => accounts.get(id)?.kind === 'cash'))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('what the current month still counts', () => {
  it('counts 2,000.00 of the 6,000.00 receivable with 4,000.00 linked on its date, and on the first of next month once that date has passed', () => {
    const plan = expandPlan(abroadAt('2026-10-07'))
    const receivable = occurrence(plan, 'receivable:2026-10-01')
    expect([receivable.amount_minor, receivable.linked_minor, receivable.state, receivable.open_minor]).toEqual([600000, 400000, 'partly_settled', 200000])
    expect(counted(plan, receivable.id)).toEqual([['2026-10-17', 'pesos', 200000]])

    const passed = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        const found = doc.plan_items.find((p) => p.id === 'receivable')
        if (found) found.starts_on = '2026-10-05'
      }),
    )
    const late = occurrence(passed, 'receivable:2026-10-01')
    expect([late.state, late.linked_minor, late.open_minor, late.carried_to, counted(passed, late.id)]).toEqual(['late', 400000, 200000, '2026-11-01', [['2026-11-01', 'pesos', 200000]]])
  })

  it('marks an unpaid bill overdue and lands it on as_of', () => {
    const water = item({ id: 'water', kind: 'bill', from_account_id: 'bank', amount_minor: 4000, starts_on: '2026-10-03' })
    const plan = expandPlan(bare('2026-10-07', { plan_items: [water] }))
    expect([occurrence(plan, 'water:2026-10-01').state, occurrence(plan, 'water:2026-11-01').state]).toEqual(['overdue', 'due'])
    expect(plan.events.filter((e) => e.id.startsWith('water')).slice(0, 2).map((e) => [e.id, e.date, e.amount_minor, e.overdue])).toEqual([
      ['water:2026-10-01', '2026-10-07', -4000, true],
      ['water:2026-11-01', '2026-11-03', -4000, false],
    ])
  })

  it('lands an unpaid bill from a closed month on as_of as overdue under its own period', () => {
    const water = item({ id: 'water', kind: 'bill', from_account_id: 'bank', amount_minor: 4000, starts_on: '2026-09-03' })
    const paidSeptember = { id: 'water-sep', account_id: 'bank', posted_on: '2026-09-03', amount_minor: -4000, kind: 'expense' as const, plan_item_id: 'water', period: '2026-09-01' }
    const plan = expandPlan(bare('2026-11-07', { plan_items: [water], transactions: [paidSeptember] }, '2026-09-01'))
    expect(plan.events.filter((e) => e.overdue).map((e) => [e.id, e.date, e.amount_minor])).toEqual([
      ['water:2026-10-01', '2026-11-07', -4000],
      ['water:2026-11-01', '2026-11-07', -4000],
    ])
    expect([occurrence(plan, 'water:2026-09-01').state, occurrence(plan, 'water:2026-10-01').period]).toEqual(['settled', '2026-10-01'])
  })

  it('counts what is left of an outflow paid in part', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.transactions.push({ id: 'mobile-part', account_id: 'pesos', posted_on: '2026-10-06', amount_minor: -70000, kind: 'expense', plan_item_id: 'mobile', period: '2026-10-01' })
      }),
    )
    expect(occurrence(plan, 'mobile:2026-10-01').state).toBe('partly_settled')
    expect(counted(plan, 'mobile:2026-10-01')).toEqual([['2026-10-10', 'pesos', -50000]])
  })

  it('bills a card charge dated between an entered cut and a provisional cut in that provisional statement, never overdue', () => {
    const snapshot = abroadAt('2026-10-25', (doc) => {
      doc.plan_items.push(item({ id: 'gym', kind: 'bill', from_account_id: 'rewards-card', amount_minor: 30000, starts_on: '2026-10-10' }))
    })
    const plan = expandPlan(snapshot)
    const entered = latestCut(snapshot, 'rewards-card')
    const billedAt = cutOnOrAfter(20, '2026-10-10')
    expect([entered, billedAt]).toEqual(['2026-09-20', '2026-10-20'])
    expect(snapshotIndex(snapshot).statementsByAccount.get('rewards-card')?.some((s) => s.cut_date === billedAt)).toBe(false)
    expect(occurrence(plan, 'gym:2026-10-01').state).toBe('due')
    expect(plan.events.filter((e) => e.id === 'gym:2026-10-01').map((e) => [e.kind, e.date, e.account_id, e.amount_minor, e.order, e.overdue])).toEqual([['card_bill', '2026-10-10', 'rewards-card', -30000, ORDER.spending, false]])
  })

  it('gives a debt-bound transfer item and extra for debts no cash event', () => {
    for (const asOf of DATES) {
      for (const [build, itemId] of [
        [mortgage, 'overpayment'],
        [usCardsCar, 'extra'],
      ] as const) {
        const { doc, rates } = build(asOf)
        const plan = expandPlan(buildSnapshot(doc, asOf, rates))
        const own = plan.occurrences.filter((o) => o.plan_item_id === itemId)
        expect(own.length).toBeGreaterThan(55)
        expect(new Set(own.map((o) => o.state))).toEqual(new Set([null]))
        expect(plan.events.filter((e) => e.occurrence_ids.some((id) => id.startsWith(`${itemId}:`)))).toEqual([])
        expect(plan.events.filter((e) => e.kind === 'transfer')).toEqual([])
      }
    }
  })

  it('credits a planned draw to its debt with no cash event', () => {
    const plan = expandPlan(abroadAt('2026-10-07'))
    expect(plan.events.filter((e) => e.id === 'cash-loan-draw:2026-10-01').map((e) => [e.kind, e.order, e.date, e.account_id, e.amount_minor])).toEqual([['draw', ORDER.money_in, '2026-10-18', 'rewards-card', 2000000]])
  })

  it('bills each installment once a month at its card cut, in the cut class', () => {
    const plan = expandPlan(abroadAt('2026-10-07'))
    const october = plan.events.filter((e) => e.kind === 'installment' && e.date <= '2026-10-31')
    expect(october.map((e) => [e.id, e.date, e.account_id, e.amount_minor, e.order])).toEqual([
      ['laptop:2026-10-01', '2026-10-20', 'rewards-card', -500000, ORDER.cut],
      ['conversion:2026-10-01', '2026-10-25', 'shopping-card', -800000, ORDER.cut],
    ])
    expect(plan.events.filter((e) => e.id.startsWith('laptop:')).map((e) => e.date)).toEqual(['2026-10-20', '2026-11-20', '2026-12-20', '2027-01-20', '2027-02-20', '2027-03-20', '2027-04-20', '2027-05-20'])
  })

  it('orders each day money in, cash transfers, spending, payments, then cuts, and keeps recorded rows after as_of', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.transactions.push(
          { id: 'z-refund', account_id: 'main', posted_on: '2026-10-20', amount_minor: 2000, kind: 'refund' },
          { id: 'a-shop', account_id: 'rewards-card', posted_on: '2026-10-20', amount_minor: -9000, kind: 'expense' },
          { id: 'pay-out', account_id: 'pesos', posted_on: '2026-10-20', amount_minor: -100000, kind: 'transfer', transfer_id: 'pay' },
          { id: 'pay-in', account_id: 'rewards-card', posted_on: '2026-10-20', amount_minor: 100000, kind: 'transfer', transfer_id: 'pay' },
          { id: 'move-out', account_id: 'main', posted_on: '2026-10-20', amount_minor: -1000, kind: 'transfer', transfer_id: 'move' },
          { id: 'move-in', account_id: 'tax', posted_on: '2026-10-20', amount_minor: 1000, kind: 'transfer', transfer_id: 'move' },
        )
      }),
    )
    expect(plan.events.filter((e) => e.date === '2026-10-20' && e.kind !== 'allowance').map((e) => [e.order, e.id])).toEqual([
      [ORDER.money_in, 'row:z-refund'],
      [ORDER.cash_transfer, 'row:move-in'],
      [ORDER.cash_transfer, 'row:move-out'],
      [ORDER.spending, 'row:a-shop'],
      [ORDER.payment, 'row:pay-in'],
      [ORDER.payment, 'row:pay-out'],
      [ORDER.cut, 'laptop:2026-10-01'],
    ])
    const sorted = [...plan.events].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || (a.id < b.id ? -1 : 1))
    expect(plan.events.map((e) => e.id)).toEqual(sorted.map((e) => e.id))
  })

  it('spreads an allowance from as_of to the month end in whole shares that sum exactly', () => {
    const plan = expandPlan(abroadAt('2026-10-07'))
    const groceries = plan.events.find((e) => e.id === 'allowance:main:cat-groceries:2026-10')
    expect([groceries?.date, groceries?.until, groceries?.amount_minor]).toEqual(['2026-10-07', '2026-10-31', -20000])
    const shares = spreadShares(groceries ?? { date: '', until: '', amount_minor: 0 })
    expect([shares.length, shares.reduce((a, b) => a + b, 0), shares[0], shares.at(-1)]).toEqual([25, -20000, -800, -800])
    expect(spreadShares({ date: '2026-11-01', until: '2026-11-30', amount_minor: -1000 }).slice(0, 11)).toEqual([-34, -33, -33, -34, -33, -33, -34, -33, -33, -34, -33])
    expect(spreadShares({ date: '2026-11-01', until: '2026-11-03', amount_minor: -1 })).toEqual([-1, 0, 0])
  })
})

describe('the rules that keep starting cash honest', () => {
  it('expands a snapshot once and hands every caller the same frozen plan', () => {
    const snapshot = abroadAt('2026-10-07')
    const plan = expandPlan(snapshot)
    expect(expandPlan(snapshot)).toBe(plan)
    expect(expandPlan(abroadAt('2026-10-07'))).not.toBe(plan)
    expect([Object.isFrozen(plan), Object.isFrozen(plan.events), Object.isFrozen(plan.occurrences[0])]).toEqual([true, true, true])
  })

  it('reads today from snapshot.as_of and never the clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2031-06-30T23:00:00Z'))
    const late = expandPlan(abroadAt('2026-10-07'))
    vi.setSystemTime(new Date('1999-01-01T00:00:00Z'))
    const early = expandPlan(abroadAt('2026-10-07'))
    expect(early).toEqual(late)
    expect([late.as_of, late.horizon_end, occurrence(late, 'mobile:2026-10-01').state]).toEqual(['2026-10-07', '2031-10-31', 'due'])
    expect(occurrence(expandPlan(abroadAt('2026-10-11')), 'mobile:2026-10-01').state).toBe('overdue')
  })

  it('lands no cash event before as_of while card charges after the last entered cut keep their dates', () => {
    for (const asOf of DATES) {
      for (const build of ALL) {
        const { doc, rates } = build(asOf)
        const snapshot = buildSnapshot(doc, asOf, rates)
        const plan = expandPlan(snapshot)
        const accounts = snapshotIndex(snapshot).accounts
        for (const e of plan.events) {
          if (accounts.get(e.account_id)?.kind === 'cash') expect(e.date >= asOf).toBe(true)
          else if (e.date < asOf) expect(e.date > latestCut(snapshot, e.account_id)).toBe(true)
        }
      }
    }
    const snapshot = abroadAt('2026-10-25', (doc) => {
      doc.plan_items.push(item({ id: 'gym', kind: 'bill', from_account_id: 'rewards-card', amount_minor: 30000, starts_on: '2026-10-10' }))
    })
    expect(expandPlan(snapshot).events.filter((e) => e.date < '2026-10-25').map((e) => e.id)).toEqual(['gym:2026-10-01', 'laptop:2026-10-01'])
  })

  it('moves no cash for an occurrence linked in full this month', () => {
    const plan = expandPlan(abroadAt('2026-10-07'))
    for (const id of ['rent:2026-10-01', 'streaming:2026-10-01']) {
      expect([occurrence(plan, id).state, counted(plan, id)]).toEqual(['settled', []])
    }
  })

  it('starts at as_of, with every row to as_of in the starting balance and none of them an event', () => {
    const snapshot = abroadAt('2026-10-07', (doc) => {
      doc.transactions.push({ id: 'later', account_id: 'main', posted_on: '2026-10-10', amount_minor: -2500, kind: 'expense' })
    })
    const plan = expandPlan(snapshot)
    const rows = plan.events.filter((e) => e.kind === 'row')
    expect(rows.map((e) => [e.id, e.date, e.amount_minor])).toEqual([['row:later', '2026-10-10', -2500]])
    expect(ledgerSum(snapshot, 'main', '2026-10-07')).toBe(ledgerSum(snapshot, 'main', '2026-10-09'))
    expect(ledgerSum(snapshot, 'main', '2026-10-10') - ledgerSum(snapshot, 'main', '2026-10-07')).toBe(-2500)
  })

  it('never turns a past row into an event, so no backward scan reaches the starting cash', () => {
    const base = expandPlan(abroadAt('2026-10-07'))
    const withPast = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.transactions.push(
          { id: 'gift', account_id: 'main', posted_on: '2026-09-12', amount_minor: 150000, kind: 'income' },
          { id: 'fix', account_id: 'pesos', posted_on: '2026-10-02', amount_minor: 7000, kind: 'adjustment' },
          { id: 'cab', account_id: 'main', posted_on: '2026-10-04', amount_minor: -3000, kind: 'expense' },
        )
      }),
    )
    expect(withPast.events).toEqual(base.events)
    expect(withPast.suggestions).toEqual([])
  })

  it('gives closed months no event, so they read only from the ledger, which opens at the opening balance', () => {
    for (const asOf of DATES) {
      const snapshot = abroadAt(asOf)
      const plan = expandPlan(snapshot)
      const cash = cashIds(plan, snapshot)
      const thisMonth = relativeTo(asOf).first(0)
      expect(plan.events.filter((e) => cash.has(e.account_id) && e.date < thisMonth)).toEqual([])
      const main = abroad(asOf).doc.accounts.find((a) => a.id === 'main')
      const first = ledgerMonth(snapshot, 'main', relativeTo(asOf).month(-1))[0]
      expect(first?.running_balance_minor).toBe((main?.opening_balance_minor ?? 0) + (first?.amount_minor ?? 0))
    }
  })

  it('counts only the unpaid rest of a card charge and leaves card payments to the payment figures', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.plan_items.push(
          item({ id: 'gym', kind: 'bill', from_account_id: 'rewards-card', amount_minor: 30000, starts_on: '2026-10-12', every: 'once' }),
          item({ id: 'pass', kind: 'bill', from_account_id: 'rewards-card', amount_minor: 12000, starts_on: '2026-10-02', every: 'once' }),
          item({ id: 'card-extra', kind: 'transfer', to_account_id: 'rewards-card', amount_minor: 100000, starts_on: '2026-10-05', every: 'once' }),
        )
        doc.transactions.push(
          { id: 'gym-part', account_id: 'rewards-card', posted_on: '2026-10-06', amount_minor: -10000, kind: 'expense', plan_item_id: 'gym', period: '2026-10-01' },
          { id: 'pass-paid', account_id: 'rewards-card', posted_on: '2026-10-02', amount_minor: -12000, kind: 'expense', plan_item_id: 'pass', period: '2026-10-01' },
          { id: 'extra-out', account_id: 'pesos', posted_on: '2026-10-05', amount_minor: -40000, kind: 'transfer', transfer_id: 'extra', plan_item_id: 'card-extra', period: '2026-10-01' },
          { id: 'extra-in', account_id: 'rewards-card', posted_on: '2026-10-06', amount_minor: 40000, kind: 'transfer', transfer_id: 'extra' },
        )
      }),
    )
    expect(counted(plan, 'gym:2026-10-01')).toEqual([['2026-10-12', 'rewards-card', -20000]])
    expect([occurrence(plan, 'pass:2026-10-01').state, counted(plan, 'pass:2026-10-01')]).toEqual(['settled', []])
    const extra = occurrence(plan, 'card-extra:2026-10-01')
    expect([extra.state, extra.linked_minor, counted(plan, extra.id)]).toEqual([null, 40000, []])
  })

  it('biases open cases low, counting overdue outflows and suggested bills and moving late inflows out of this month', () => {
    const plan = expandPlan(
      bare('2026-10-07', {
        plan_items: [
          item({ id: 'water', kind: 'bill', from_account_id: 'bank', amount_minor: 4000, starts_on: '2026-10-03', every: 'once' }),
          item({ id: 'phone', kind: 'bill', from_account_id: 'bank', amount_minor: 2000, starts_on: '2026-10-09', every: 'once' }),
          item({ id: 'deposit-back', kind: 'income', to_account_id: 'bank', amount_minor: 50000, starts_on: '2026-10-01', every: 'once' }),
          item({ id: 'side', kind: 'income', to_account_id: 'bank', amount_minor: 30000, starts_on: '2026-10-10', every: 'once' }),
        ],
        transactions: [
          { id: 'phone-maybe', account_id: 'bank', posted_on: '2026-10-07', amount_minor: -2000, kind: 'expense' },
          { id: 'side-maybe', account_id: 'bank', posted_on: '2026-10-06', amount_minor: 30000, kind: 'income' },
        ],
      }),
    )
    expect(plan.suggestions.map((s) => s.occurrence_id)).toEqual(['phone:2026-10-01', 'side:2026-10-01'])
    expect(plan.events.filter((e) => e.date <= '2026-10-31').map((e) => [e.id, e.date, e.amount_minor])).toEqual([
      ['water:2026-10-01', '2026-10-07', -4000],
      ['phone:2026-10-01', '2026-10-09', -2000],
    ])
    expect([occurrence(plan, 'deposit-back:2026-10-01').state, counted(plan, 'deposit-back:2026-10-01')]).toEqual(['late', [['2026-11-01', 'bank', 50000]]])
  })

  it('lapses a past month allowance while an unpaid one-off bill carries until linked or skipped', () => {
    const build = (skip: boolean) =>
      expandPlan(
        abroadAt('2026-10-07', (doc) => {
          doc.plan_items.push(item({ id: 'deposit', kind: 'bill', from_account_id: 'main', amount_minor: 80000, every: 'once', starts_on: '2026-09-15', skip_periods: skip ? ['2026-09-01'] : [] }))
        }),
      )
    const plan = build(false)
    const groceries = occurrence(plan, 'groceries:2026-09-01')
    expect([groceries.state, groceries.open_minor, plan.events.filter((e) => e.id.endsWith(':2026-09'))]).toEqual(['lapsed', 0, []])
    expect(plan.events.filter((e) => e.id.startsWith('deposit')).map((e) => [e.date, e.amount_minor, e.overdue])).toEqual([['2026-10-07', -80000, true]])
    expect([occurrence(build(true), 'deposit:2026-09-01').state, counted(build(true), 'deposit:2026-09-01')]).toEqual(['settled', []])
  })

  it('emits one event for each occurrence that still counts, from the same occurrences the review reads', () => {
    for (const asOf of DATES) {
      for (const build of ALL) {
        const { doc, rates } = build(asOf)
        const plan = expandPlan(buildSnapshot(doc, asOf, rates))
        const suggested = new Set(plan.suggestions.map((s) => s.occurrence_id))
        const heldOut = (flow: string, id: string) => (flow === 'income' || flow === 'draw' || flow === 'transfer') && suggested.has(id)
        for (const o of plan.occurrences) {
          const own = plan.events.filter((e) => e.kind !== 'allowance' && e.occurrence_ids.includes(o.id))
          const counts = o.flow !== 'allowance' && o.open_minor > 0 && (o.state === 'due' || o.state === 'overdue' || o.state === 'late' || o.state === 'partly_settled') && !heldOut(o.flow, o.id)
          expect([o.id, own.length]).toEqual([o.id, counts ? 1 : 0])
          if (counts) expect(Math.abs(own[0]?.amount_minor ?? 0)).toBe(o.open_minor)
          if (counts && o.state === 'late') expect([o.id, own[0]?.date]).toEqual([o.id, o.carried_to])
        }
        for (const e of plan.events) {
          if (e.kind === 'row') expect(e.occurrence_ids).toEqual([])
          else expect(e.occurrence_ids.every((id) => plan.byId.has(id))).toBe(true)
        }
      }
    }
  })

  it('drops settled occurrences, shrinks partial ones and keeps overdue ones under their own period in the due list', () => {
    const plan = expandPlan(
      abroadAt('2026-11-07', (doc) => {
        doc.transactions = doc.transactions.filter((t) => t.id !== 'mobile-last')
      }),
    )
    const due = plan.occurrences.filter((o) => o.date < '2026-12-01' && o.state !== null && o.open_minor > 0 && o.flow !== 'allowance')
    expect(due.map((o) => [o.id, o.state, o.open_minor])).toEqual([
      ['mobile:2026-10-01', 'overdue', 120000],
      ['mobile:2026-11-01', 'due', 120000],
      ['receivable:2026-11-01', 'partly_settled', 200000],
      ['cash-loan-draw:2026-11-01', 'due', 2000000],
      ['laptop:2026-11-01', 'due', 500000],
      ['insurance:2026-11-01', 'due', 350000],
      ['conversion:2026-11-01', 'due', 800000],
      ['salary:2026-11-01', 'due', 400000],
      ['tax-set-aside:2026-11-01', 'due', 60000],
    ])
    expect(['rent:2026-11-01', 'streaming:2026-11-01', 'insurance:2026-10-01'].map((id) => occurrence(plan, id).state)).toEqual(['settled', 'settled', 'settled'])
    expect(counted(plan, 'mobile:2026-10-01')).toEqual([['2026-11-07', 'pesos', -120000]])
  })
})

describe('late income moves to the first of next month', () => {
  const side = { ...item({ id: 'side', kind: 'income', to_account_id: 'bank', amount_minor: 150000, every: 'once', starts_on: '2026-09-15' }), name: 'Side income' }

  it('counts a September inflow on 1 Nov when today is 10 Oct, and on 1 Dec when today is 2 Nov, marked late', () => {
    const october = bare('2026-10-10', { plan_items: [side] })
    const plan = expandPlan(october)
    const late = occurrence(plan, 'side:2026-09-01')
    expect([late.state, late.open_minor, late.carried_to, counted(plan, late.id)]).toEqual(['late', 150000, '2026-11-01', [['2026-11-01', 'bank', 150000]]])
    const w = walked(october, { cards: CARDS, loans: LOANS })
    expect(w.lines.filter((l) => l.occurrence_ids.includes(late.id)).map((l) => [l.date, l.account_id, l.amount_minor, l.state])).toEqual([['2026-11-01', 'bank', 150000, 'late']])
    // October never counts it, so the money lands between the last day of October and the first of November.
    expect([w.start.get('bank'), balanceOn(w, 'bank', '2026-11-01') - balanceOn(w, 'bank', '2026-10-31')]).toEqual([500000, 150000])

    const november = expandPlan(bare('2026-11-02', { plan_items: [side] }))
    const still = occurrence(november, 'side:2026-09-01')
    expect([still.state, still.carried_to, counted(november, still.id)]).toEqual(['late', '2026-12-01', [['2026-12-01', 'bank', 150000]]])
  })

  it('carries only the remainder of a late inflow paid in part, and nothing once links reach it', () => {
    const part = { id: 'side-part', account_id: 'bank', posted_on: '2026-10-05', amount_minor: 60000, kind: 'income' as const, plan_item_id: 'side', period: '2026-09-01' }
    const plan = expandPlan(bare('2026-10-10', { plan_items: [side], transactions: [part] }))
    const late = occurrence(plan, 'side:2026-09-01')
    expect([late.state, late.linked_minor, late.open_minor, counted(plan, late.id)]).toEqual(['late', 60000, 90000, [['2026-11-01', 'bank', 90000]]])

    const rest = { ...part, id: 'side-rest', posted_on: '2026-10-08', amount_minor: 90000 }
    const paid = occurrence(expandPlan(bare('2026-10-10', { plan_items: [side], transactions: [part, rest] })), 'side:2026-09-01')
    expect([paid.state, paid.open_minor, paid.carried_to]).toEqual(['settled', 0, null])
  })

  it('counts nothing for a late inflow skipped as won’t come', () => {
    const plan = expandPlan(bare('2026-10-10', { plan_items: [{ ...side, skip_periods: ['2026-09-01'] }] }))
    const skipped = occurrence(plan, 'side:2026-09-01')
    expect([skipped.state, skipped.skipped, skipped.open_minor, skipped.carried_to, counted(plan, skipped.id)]).toEqual(['settled', true, 0, null, []])
  })

  it('holds a late inflow out while an unlinked row may be it, and asks about that row instead', async () => {
    const arrived = { id: 'side-in', account_id: 'bank', posted_on: '2026-09-17', amount_minor: 150000, kind: 'income' as const }
    const snapshot = bare('2026-10-10', { plan_items: [side], transactions: [arrived] })
    const plan = expandPlan(snapshot)
    expect([occurrence(plan, 'side:2026-09-01').state, plan.suggestions.map((s) => s.id), counted(plan, 'side:2026-09-01')]).toEqual(['late', ['side-in>side:2026-09-01'], []])
    const a = await advise(snapshot)
    expect(a.review.filter((r) => r.occurrence_id === 'side:2026-09-01').map((r) => r.id)).toEqual(['suggestion:side-in>side:2026-09-01'])
  })

  it('asks whether late income arrived, saying where it now counts', async () => {
    const a = await advise(bare('2026-10-10', { plan_items: [side] }))
    const asked = a.review.filter((r) => r.occurrence_id === 'side:2026-09-01')
    expect(asked.map((r) => [r.id, r.kind, r.title, r.act_by, a.say(r.body)])).toEqual([
      ['unconfirmed_inflow:side:2026-09-01', 'unconfirmed_inflow', 'Check whether expected money arrived', '2026-09-15', 'Side income: €1,500.00 into Bank was expected on 2026-09-15 and has no linked transaction, so it now counts on 2026-11-01.'],
    ])
  })

  it('keeps a planned draw whose date passed unconfirmed and an inflow before track_from out of the plan', () => {
    const draw = item({ id: 'draw', kind: 'income', to_account_id: 'card', amount_minor: 200000, every: 'once', starts_on: '2026-09-15' })
    const plan = expandPlan(bare('2026-10-10', { plan_items: [draw] }))
    const unconfirmed = occurrence(plan, 'draw:2026-09-01')
    expect([unconfirmed.flow, unconfirmed.state, unconfirmed.carried_to, counted(plan, unconfirmed.id)]).toEqual(['draw', 'unconfirmed', null, []])

    const untracked = expandPlan(bare('2026-10-10', { plan_items: [side] }, '2026-10-01'))
    expect([untracked.occurrences.filter((o) => o.plan_item_id === 'side'), untracked.events.filter((e) => e.id.startsWith('side'))]).toEqual([[], []])
  })
})
