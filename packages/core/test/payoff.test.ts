import { describe, expect, it } from 'vitest'
import { abroad, cardHousehold, mortgage, revolvingDaily, usCardsCar, type Sample, type SampleDoc } from '../fixtures'
import type { AccountInput, PlanItemInput, StatementInput } from '../fixtures/relative'
import { CARDS, cardsOf, type CardReplay, type CardStatement } from '../src/engine/cards'
import { debtFigures, debtMilestones, debtOn, debtPayoffs, horizonDebt, installmentProgress } from '../src/engine/debt-figures'
import type { ExtraOffer, LoanModule } from '../src/engine/debts'
import { expandPlan } from '../src/engine/events'
import { LOANS } from '../src/engine/loans'
import { annualRate, extraByMonth, payoffOrder } from '../src/engine/payoff'
import type { Walk } from '../src/engine/types'
import { fxTerms, grossFor } from '../src/money'
import { termsFromPreset } from '../src/presets'
import { toRatesPerEur } from '../src/rates'
import type { CardTerms } from '../src/schema/terms'
import { buildSnapshot, type Snapshot } from '../src/snapshot'
import { account, cashHousehold, topUpPairs, walked } from './walk-helpers'

const AS_OF = '2026-10-07'
const usTerms = termsFromPreset('US-generic', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })
const dailyTerms = termsFromPreset('PH-daily-unpaid', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })

function build(sample: (asOf: string) => Sample, asOf = AS_OF, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = sample(asOf)
  edit?.(doc)
  return buildSnapshot(doc, asOf, rates)
}

function replayOf(w: Walk, id: string): CardReplay {
  const found = cardsOf(w)?.get(id)
  if (!found) throw new Error(`The walk has no replay for '${id}'`)
  return found
}

function cut(replay: CardReplay, cutDate: string): CardStatement {
  const found = replay.statements.find((s) => s.cut_date === cutDate)
  if (!found) throw new Error(`No statement cut on ${cutDate}`)
  return found
}

const extraItem = (amount: number, from = 'cash', starts_on = '2026-10-01'): PlanItemInput => ({ id: 'extra', kind: 'transfer', name: 'Extra for debts', from_account_id: from, amount_minor: amount, starts_on })

// A US-generic card owing 3,000.00 on its September statement, with a 200.00 phone installment for twelve months and 1,000.00 extra a month.
function phoneCard(edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = cardHousehold({
    asOf: AS_OF,
    terms: usTerms,
    currency: 'USD',
    opening_balance_minor: -300000,
    opening_date: '2026-08-21',
    statements: [
      {
        id: 'sep',
        account_id: 'card',
        cut_date: '2026-09-20',
        due_date: '2026-10-16',
        previous_balance_minor: 300000,
        payments_and_credits_minor: 10000,
        charges_minor: 5000,
        installments_minor: 0,
        interest_minor: 5000,
        fees_minor: 0,
        total_due_minor: 300000,
        minimum_due_minor: 8000,
      },
    ],
    plan_items: [extraItem(100000), { id: 'phone', kind: 'installment', name: 'Phone', from_account_id: 'card', amount_minor: 20000, starts_on: '2026-10-01', ends_on: '2027-09-01' }],
  })
  edit?.(doc)
  return buildSnapshot(doc, AS_OF, rates)
}

// Two PH-daily-unpaid cards paid from 'cash' with the same rate, so only revolving balance and sort order rank them.
function twoCards(statements: StatementInput[], edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = cardHousehold({ asOf: AS_OF, terms: dailyTerms, opening_balance_minor: -2000000, opening_date: '2026-08-01', statements })
  const alpha = account(doc, 'card')
  doc.accounts = [doc.accounts[0] as AccountInput, { ...alpha, id: 'alpha', name: 'Alpha', sort_order: 1 }, { ...alpha, id: 'beta', name: 'Beta', sort_order: 2 }]
  edit?.(doc)
  return buildSnapshot(doc, AS_OF, rates)
}

const statement = (id: string, card: string, cut_date: string, total: number, installments?: number): StatementInput => ({
  id,
  account_id: card,
  cut_date,
  due_date: `${cut_date.slice(0, 5)}${String(Number(cut_date.slice(5, 7)) + 1).padStart(2, '0')}-16`,
  total_due_minor: total,
  minimum_due_minor: Math.ceil(total * 0.03),
  ...(installments === undefined ? {} : { previous_balance_minor: total - installments, payments_and_credits_minor: 0, charges_minor: 0, installments_minor: installments, interest_minor: 0, fees_minor: 0 }),
})

// Alpha owes nothing; Beta owes 3,000.00 on its September statement and Gamma 10,000.00; 5,000.00 of extra goes out once in September, in list order.
function threeCards(order: readonly string[], beta: { logged: boolean; pay?: CardTerms['pay'] }): Snapshot {
  const extra = { ...extraItem(500000, 'cash', '2026-09-15'), every: 'once' as const }
  const { doc, rates } = cardHousehold({ asOf: AS_OF, terms: dailyTerms, opening_balance_minor: 0, opening_date: '2026-08-21', plan_items: [extra] })
  const us = (id: string, terms: CardTerms): AccountInput => ({ id, name: id, kind: 'credit_card', currency: 'PHP', opening_balance_minor: -300000, opening_date: '2026-08-21', funded_from_account_id: 'cash', terms, sort_order: order.indexOf(id) + 1 })
  doc.household.payoff_order = 'list'
  doc.accounts = [doc.accounts[0] as AccountInput, { ...account(doc, 'card'), id: 'alpha', name: 'alpha', sort_order: order.indexOf('alpha') + 1 }, us('beta', { ...usTerms, pay: beta.pay ?? usTerms.pay }), us('gamma', usTerms)]
  doc.statements = [statement('beta-sep', 'beta', '2026-09-20', 300000), statement('gamma-sep', 'gamma', '2026-09-20', 1000000)]
  // 1,000.00 logged on Beta after its cut, well above its 90.00 minimum.
  if (beta.logged) {
    doc.transactions.push(
      { id: 'logged-out', account_id: 'cash', posted_on: '2026-09-25', amount_minor: -100000, kind: 'transfer', transfer_id: 'logged' },
      { id: 'logged-in', account_id: 'beta', posted_on: '2026-09-25', amount_minor: 100000, kind: 'transfer', transfer_id: 'logged' },
    )
  }
  return buildSnapshot(doc, AS_OF, rates)
}

describe('payoff order', () => {
  it('ranks 3% a month above 12% a year, and the list order by sort order', () => {
    const snapshot = (order: 'avalanche' | 'list') => {
      const { doc, rates } = cardHousehold({ asOf: AS_OF, terms: dailyTerms, opening_balance_minor: -100000, opening_date: '2026-08-21' })
      const monthly = account(doc, 'card')
      doc.household.payoff_order = order
      doc.accounts = [
        doc.accounts[0] as AccountInput,
        { ...monthly, id: 'monthly', name: 'Monthly rate', sort_order: 3 },
        { id: 'yearly', name: 'Yearly rate', kind: 'credit_card', currency: 'PHP', opening_balance_minor: -100000, opening_date: '2026-08-21', funded_from_account_id: 'cash', terms: { ...usTerms, interest: { ...usTerms.interest, rate: 0.12 } }, sort_order: 2 },
        { id: 'loan', name: 'Loan', kind: 'loan', currency: 'PHP', opening_balance_minor: -5000000, opening_date: '2026-08-21', funded_from_account_id: 'cash', terms: { annual_rate: 0.2, payment_minor: 100000, payment_day: 5 }, sort_order: 1 },
      ]
      return buildSnapshot(doc, AS_OF, rates)
    }
    const avalanche = snapshot('avalanche')
    expect(avalanche.doc.accounts.filter((a) => a.kind !== 'cash').map((a) => [a.id, annualRate(a)])).toEqual([
      ['loan', 0.2],
      ['monthly', 0.36],
      ['yearly', 0.12],
    ])
    expect([payoffOrder(avalanche).get('cash'), payoffOrder(snapshot('list')).get('cash')]).toEqual([
      ['monthly', 'loan', 'yearly'],
      ['loan', 'yearly', 'monthly'],
    ])
  })

  it('aims extra at the larger revolving balance between equal rates, measured from the latest statement each time', () => {
    // Alpha's latest statement prints 20,000.00 of which 5,000.00 is installments, against Beta's 18,000.00; Alpha's larger August total no longer counts.
    const august = statement('alpha-aug', 'alpha', '2026-08-20', 3000000)
    const first = [august, statement('alpha-sep', 'alpha', '2026-09-20', 2000000, 500000), statement('beta-sep', 'beta', '2026-09-20', 1800000)]
    const before = twoCards(first, (doc) => doc.plan_items.push(extraItem(100000)))
    expect(payoffOrder(before).get('cash')).toEqual(['beta', 'alpha'])
    const w = walked(before, { cards: CARDS })
    expect([cut(replayOf(w, 'beta'), '2026-10-20').payment?.extra_minor, cut(replayOf(w, 'alpha'), '2026-10-20').payment?.extra_minor]).toEqual([100000, 0])
    // A September statement with 30,000.00 of revolving flips the target; equal revolving falls back to sort order.
    const after = twoCards([august, statement('alpha-sep', 'alpha', '2026-09-20', 3000000), statement('beta-sep', 'beta', '2026-09-20', 1800000)])
    const even = twoCards([statement('alpha-sep', 'alpha', '2026-09-20', 1800000), statement('beta-sep', 'beta', '2026-09-20', 1800000)])
    expect([payoffOrder(after).get('cash'), payoffOrder(even).get('cash')]).toEqual([
      ['alpha', 'beta'],
      ['alpha', 'beta'],
    ])
  })
})

describe('extra for debts', () => {
  it('pays the US card with an 80.00 minimum 380.00 once the 300.00 extra starts', () => {
    const snapshot = build(usCardsCar)
    const w = walked(snapshot, { cards: CARDS })
    const travel = replayOf(w, 'travel-card')
    expect(payoffOrder(snapshot).get('checking')).toEqual(['travel-card', 'store-card', 'car-loan'])
    // September's cycle predates the extra, so it pays the minimum; October's pays the minimum plus the extra.
    expect([cut(travel, '2026-09-20').pay_on, cut(travel, '2026-09-20').paid_minor, cut(travel, '2026-10-20').pay_on, cut(travel, '2026-10-20').paid_minor, cut(travel, '2026-10-20').minimum_due_minor]).toEqual(['2026-10-16', 8000, '2026-11-16', 38000, 8000])
    expect(cut(replayOf(w, 'store-card'), '2026-10-24').payment?.extra_minor).toBe(0)
  })

  it('sends the extra the first US card does not need to the next debt on the day it clears', () => {
    const w = walked(build(usCardsCar), { cards: CARDS })
    const [travel, store] = [replayOf(w, 'travel-card'), replayOf(w, 'store-card')]
    const clearing = travel.statements.find((s) => (s.payment?.extra_minor ?? 0) > 0 && (s.payment?.extra_minor ?? 0) < 30000)
    if (!clearing?.pay_on || !clearing.payment) throw new Error('The travel card never clears inside the horizon')
    const day = clearing.pay_on
    const after = travel.statements[travel.statements.indexOf(clearing) + 1]
    const passed = 30000 - clearing.payment.extra_minor
    expect([clearing.paid_minor, after?.total_due_minor, travel.passed_on[0]]).toEqual([clearing.total_due_minor, 0, { account_id: 'store-card', from_account_id: 'checking', day, amount_minor: passed, occurrence_ids: [`extra:${clearing.cut_date.slice(0, 7)}-01`] }])
    expect(store.moves.find((m) => m.id === `extra:store-card:${day}`)?.amount_minor).toBe(passed)
    // The money leaves Checking once: the two payments that day add up to the minimum plus the extra.
    const out = w.lines.filter((l) => l.account_id === 'checking' && l.kind === 'payment' && l.date === day).reduce((sum, l) => sum - l.amount_minor, 0)
    expect(out).toBe(clearing.payment.base_minor + 30000)
  })

  it('gives a card with a logged payment above its base only the rise in left to pay from an offer, never past what it owes, and passes the rest on that day', () => {
    const split = (order: readonly string[]) => {
      const w = walked(threeCards(order, { logged: true }), { cards: CARDS })
      const beta = replayOf(w, 'beta')
      const out = w.lines.filter((l) => l.account_id === 'cash' && l.kind === 'payment' && l.date === '2026-10-16').reduce((sum, l) => sum - l.amount_minor, 0)
      return {
        posted: beta.moves.filter((m) => m.date === '2026-10-16').map((m) => m.amount_minor),
        passed: beta.passed_on.map((o) => [o.account_id, o.day, o.amount_minor]),
        figures: cut(beta, '2026-09-20').payment,
        totals: beta.statements.filter((s) => s.cut_date > '2026-09-20').map((s) => s.total_due_minor),
        gamma: replayOf(w, 'gamma').moves.filter((m) => m.date === '2026-10-16').map((m) => [m.id, m.amount_minor]),
        out,
      }
    }
    const second = split(['alpha', 'beta', 'gamma'])
    // The 1,000.00 logged is 910.00 above the base and already counts toward the share, so Beta needs 2,000.00 of cash to clear its 3,000.00.
    expect([second.posted, second.passed, second.figures]).toEqual([
      [200000],
      [['gamma', '2026-10-16', 500000 - 291000]],
      { base_minor: 9000, items_minor: 0, extra_minor: 291000, cap_minor: 300000, planned_gross_minor: 300000, paid_minor: 100000, left_to_pay_minor: 200000, state: 'to_pay' },
    ])
    // The model never pays Beta into credit, Gamma takes the rest the same day, and the cash leaving that day is the extra less what the logged payment already sent.
    expect([second.totals.every((t) => t === 0), second.gamma, second.out]).toEqual([
      true,
      [
        ['extra:gamma:2026-10-16', 209000],
        ['payment:gamma:2026-09-20', 30000],
      ],
      30000 + 500000 - (100000 - 9000),
    ])
    // First in order, Beta takes the month's extra on its own pay day with the same split.
    expect(split(['beta', 'gamma', 'alpha'])).toEqual(second)
  })

  it('shows extra that reaches a card after its pay day in that statement payment figures', () => {
    const snapshot = threeCards(['alpha', 'beta', 'gamma'], { logged: false, pay: { mode: 'minimum', on: { days_after_cut: 1 } } })
    const w = walked(snapshot, { cards: CARDS })
    const beta = debtFigures(snapshot, w).cards.find((c) => c.account_id === 'beta')
    // Beta pays its 90.00 minimum on as_of; the 2,910.00 it can still take arrives on the 16th and clears it, so left to pay is both.
    expect([beta?.pay_on, replayOf(w, 'beta').moves.map((m) => [m.id, m.date, m.amount_minor]), beta?.payment]).toEqual([
      AS_OF,
      [
        ['payment:beta:2026-09-20', AS_OF, 9000],
        ['extra:beta:2026-10-16', '2026-10-16', 291000],
      ],
      { base_minor: 9000, items_minor: 0, extra_minor: 291000, cap_minor: 300000, planned_gross_minor: 300000, paid_minor: 0, left_to_pay_minor: 300000, state: 'to_pay' },
    ])
  })

  it('offers the loan module what the cards do not need, on the day it is freed', () => {
    const seen: ExtraOffer[][] = []
    const watcher: LoanModule = {
      kind: 'loan',
      walk: ({ offers }) => {
        seen.push([...offers])
        return { moves: [], summary: null }
      },
    }
    const w = walked(build(usCardsCar), { cards: CARDS, loans: watcher })
    const offers = seen.at(-1) ?? []
    const store = replayOf(w, 'store-card')
    expect([seen.length, offers[0], offers.length > 12, offers.slice(1).every((o) => o.account_id === 'car-loan' && o.amount_minor === 30000)]).toEqual([1, store.passed_on[0], true, true])
    expect((offers[0]?.amount_minor ?? 0) < 30000 && (offers[0]?.amount_minor ?? 0) > 0).toBe(true)
  })

  it('passes extra from a loan ranked first to the card after it, walking the modules again until neither moves', () => {
    const { doc, rates } = cardHousehold({ asOf: AS_OF, terms: dailyTerms, opening_balance_minor: -3000000, opening_date: '2026-08-21', plan_items: [extraItem(50000)] })
    doc.accounts.push({ id: 'loan', name: 'Loan', kind: 'loan', currency: 'PHP', opening_balance_minor: -1000000, opening_date: '2026-08-21', funded_from_account_id: 'cash', terms: { annual_rate: 0.4, payment_minor: 100000, payment_day: 5 }, sort_order: 2 })
    const snapshot = buildSnapshot(doc, AS_OF, rates)
    let calls = 0
    // Stands in for the loan module: the loan needs nothing, so each month's extra goes on the 5th to the next debt.
    const passer: LoanModule = {
      kind: 'loan',
      walk: ({ snapshot: s, days }) => {
        calls++
        const order = payoffOrder(s).get('cash') ?? []
        const next = order[order.indexOf('loan') + 1]
        const overflow: ExtraOffer[] = []
        for (const [month, extra] of extraByMonth(s).get('cash') ?? []) {
          const day = `${month}-05`
          if (next && day >= (days[0] ?? '') && day <= (days.at(-1) ?? '')) overflow.push({ account_id: next, from_account_id: 'cash', day, amount_minor: extra.amount_minor, occurrence_ids: extra.occurrence_ids })
        }
        return { moves: [], summary: null, overflow }
      },
    }
    const w = walked(snapshot, { cards: CARDS, loans: passer })
    const extras = replayOf(w, 'card').moves.filter((m) => m.id.startsWith('extra:'))
    expect([payoffOrder(snapshot).get('cash'), calls, extras[0]?.id, extras[0]?.date, extras[0]?.amount_minor, extras[0]?.occurrence_ids]).toEqual([['loan', 'card'], 2, 'extra:card:2026-11-05', '2026-11-05', 50000, ['extra:2026-11-01']])
    // The card counts it as paid since its cut, so its own payment on the 16th is still its base, and left to pay is both.
    const october = cut(replayOf(w, 'card'), '2026-10-20')
    const base = october.payment?.base_minor ?? 0
    expect([october.payment?.extra_minor, october.payment?.paid_minor, october.payment?.left_to_pay_minor, october.paid_minor]).toEqual([50000, 0, base + 50000, base])
  })

  it('leaves extra in cash when no debt needs it', () => {
    const { doc, rates } = cardHousehold({ asOf: AS_OF, terms: dailyTerms, opening_balance_minor: 0, opening_date: '2026-08-21', plan_items: [extraItem(50000)] })
    const w = walked(buildSnapshot(doc, AS_OF, rates), { cards: CARDS })
    expect([replayOf(w, 'card').moves, replayOf(w, 'card').passed_on, w.balances.get('cash')?.at(-1)]).toEqual([[], [], w.start.get('cash')])
  })

  it('models an extra payment through the plan, so the payment is the base plus the extra and installments keep billing', () => {
    const plain = walked(phoneCard(), { cards: CARDS })
    const october = cut(replayOf(plain, 'card'), '2026-10-20')
    expect([october.installments_minor, october.payment?.extra_minor, october.paid_minor - (october.payment?.base_minor ?? 0), replayOf(plain, 'card').moves.find((m) => m.id === 'payment:card:2026-10-20')?.date]).toEqual([20000, 100000, 100000, '2026-11-16'])
    expect(replayOf(plain, 'card').statements.filter((s) => s.cut_date >= '2026-10-20' && s.cut_date <= '2027-09-20').every((s) => s.installments_minor === 20000)).toBe(true)
    // The same 1,000.00 forced in as a recorded payment only replaces part of the planned payment instead of adding to it.
    const forced = walked(
      phoneCard((doc) => {
        doc.plan_items = doc.plan_items.filter((p) => p.id !== 'extra')
        doc.transactions.push(
          { id: 'forced-out', account_id: 'cash', posted_on: '2026-10-25', amount_minor: -100000, kind: 'transfer', transfer_id: 'forced' },
          { id: 'forced-in', account_id: 'card', posted_on: '2026-10-25', amount_minor: 100000, kind: 'transfer', transfer_id: 'forced' },
        )
      }),
      { cards: CARDS },
    )
    const forcedOctober = cut(replayOf(forced, 'card'), '2026-10-20')
    expect([forcedOctober.payment?.left_to_pay_minor, forcedOctober.paid_minor]).toEqual([0, 0])
  })

  it('pulls a cross-currency top-up in the month a peso of extra goes out, a euro for every peso swept', () => {
    const household = (extra: boolean) =>
      cashHousehold(AS_OF, (doc) => {
        Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'bank', floor_windows: [{ from_month: '2026-10', to_month: null, amount_minor: 1000000 }] })
        doc.accounts.push({ id: 'card', name: 'Card', kind: 'credit_card', currency: 'PHP', opening_balance_minor: -5000000, opening_date: '2026-09-01', funded_from_account_id: 'pesos', terms: dailyTerms, sort_order: 3 })
        if (extra) doc.plan_items.push(extraItem(300000, 'pesos'))
      })
    const novemberTopUps = (s: Snapshot) =>
      topUpPairs(walked(s, { cards: CARDS }))
        .filter(([day]) => day.startsWith('2026-11'))
        .reduce((sum, [, , , sent]) => sum + sent, 0)
    const [withExtra, without] = [household(true), household(false)]
    const terms = fxTerms('EUR', 'PHP', toRatesPerEur(withExtra.rates), 0.005)
    if (!terms) throw new Error('No EUR to PHP rate')
    expect(Math.abs(novemberTopUps(withExtra) - novemberTopUps(without) - grossFor(300000, terms.rate, terms.feePct))).toBeLessThanOrEqual(1)
  })

  it('keeps a shared charge as two legs, so the card bills its installment whatever the payer does', () => {
    const share: PlanItemInput = { id: 'phone-share', kind: 'income', name: 'Phone share from a relative', to_account_id: 'cash', amount_minor: 10000, starts_on: '2026-10-25', ends_on: '2027-02-25' }
    const billed = (s: Snapshot) => replayOf(walked(s, { cards: CARDS }), 'card').statements.filter((x) => x.cut_date >= '2026-10-20' && x.cut_date <= '2027-09-20').map((x) => x.installments_minor)
    const withShare = phoneCard((doc) => doc.plan_items.push(share))
    expect(billed(withShare)).toEqual(billed(phoneCard()))
    expect(billed(withShare)).toEqual(Array.from({ length: 12 }, () => 20000))
    // The cash leg ends in February while the card bills to September, and a logged card payment leaves the cash leg expected.
    const paid = phoneCard((doc) => {
      doc.plan_items.push(share)
      doc.transactions.push(
        { id: 'pay-out', account_id: 'cash', posted_on: '2026-10-01', amount_minor: -8000, kind: 'transfer', transfer_id: 'pay' },
        { id: 'pay-in', account_id: 'card', posted_on: '2026-10-01', amount_minor: 8000, kind: 'transfer', transfer_id: 'pay' },
      )
    })
    const shares = expandPlan(paid).events.filter((e) => e.occurrence_ids.some((id) => id.startsWith('phone-share:')))
    expect([shares.length, shares.at(-1)?.date, shares.every((e) => e.amount_minor === 10000)]).toEqual([5, '2027-02-25', true])
  })
})

describe('debt figures', () => {
  it('gives remaining due, owed, unbilled installments as EMI times months left, and total debt per currency', () => {
    const snapshot = build(revolvingDaily)
    const figures = debtFigures(snapshot, walked(snapshot, { cards: CARDS }))
    const card = figures.cards[0]
    // The gadget bills 1,500.00 to December; September's is on the 'last' statement, so October to December are unbilled.
    expect([card?.statement_id, card?.remaining_due_minor, card?.owed_minor, card?.unbilled_installments_minor, card?.total_debt_minor]).toEqual(['last', 3000000, 3000000, 450000, 3450000])
    expect(figures.total_debt).toEqual([{ currency: 'PHP', minor: 3450000 }])
    const us = build(usCardsCar)
    const usFigures = debtFigures(us, walked(us, { cards: CARDS, loans: LOANS }))
    // The car loan's live balance: 18,000.00 plus September's 103.50 interest, less the 355.58 paid.
    expect([usFigures.loans, usFigures.total_debt]).toEqual([[{ account_id: 'car-loan', currency: 'USD', owed_minor: 1774792, total_debt_minor: 1774792 }], [{ currency: 'USD', minor: 459120 + 204250 + 1774792 }]])
    expect(() => debtFigures(us, walked(us, { cards: CARDS }))).toThrow('Debt figures need a walk that ran the loan module')
  })

  it('gives what each debt owes at the end of any walked day: today’s total debt on day 0, and the horizon’s on the last day', () => {
    for (const sample of [abroad, usCardsCar, mortgage]) {
      const snapshot = build(sample)
      const w = walked(snapshot, { cards: CARDS, loans: LOANS })
      const figures = debtFigures(snapshot, w)
      const today = [...figures.cards, ...figures.loans].map((d) => [d.account_id, d.total_debt_minor]).sort()
      expect(debtOn(snapshot, w, 0).map((d) => [d.account_id, d.total_debt_minor]).sort()).toEqual(today)
      expect(debtOn(snapshot, w, w.days.length - 1)).toEqual(horizonDebt(snapshot, w))
    }
    const us = build(usCardsCar)
    const w = walked(us, { cards: CARDS, loans: LOANS })
    // The travel card pays its minimum on 16 Oct and the car loan its payment on its day, so both owe less at October's end.
    const october = w.days.indexOf('2026-10-31')
    expect(debtOn(us, w, october).map((d) => [d.account_id, d.total_debt_minor])).toEqual([
      ['car-loan', 1749439],
      ['store-card', 454406],
      ['travel-card', 200418],
    ])
    expect(() => debtOn(us, w, w.days.length)).toThrow(RangeError)
  })

  it('leaves an archived debt out of total debt, while its own figures stay', () => {
    const us = build(usCardsCar, AS_OF, (doc) => {
      const store = doc.accounts.find((a) => a.id === 'store-card')
      if (store) store.archived_at = '2026-10-01T00:00:00+00:00'
    })
    const figures = debtFigures(us, walked(us, { cards: CARDS, loans: LOANS }))
    expect([figures.cards.find((c) => c.account_id === 'store-card')?.total_debt_minor, figures.total_debt]).toEqual([459120, [{ currency: 'USD', minor: 204250 + 1774792 }]])
  })

  it('counts installments as n of N against the current statement, the unbilled ones summing to unbilled installments', () => {
    const snapshot = build(abroad)
    const w = walked(snapshot, { cards: CARDS })
    const progress = (id: string) => installmentProgress(snapshot, w, id).map((i) => [i.plan_item_id, i.billed, i.total, i.first_month, i.last_month, i.unbilled_minor])
    // The laptop bills June to May; the September statement billed June to September.
    expect(progress('rewards-card')).toEqual([['laptop', 4, 12, '2026-06', '2027-05', 8 * 500000]])
    expect(progress('shopping-card')).toEqual([
      ['conversion', 0, 12, '2026-10', '2027-09', 12 * 800000],
      ['cash-loan', 0, 12, '2026-11', '2027-10', 12 * 180000],
    ])
    for (const card of debtFigures(snapshot, w).cards) {
      expect(installmentProgress(snapshot, w, card.account_id).reduce((sum, i) => sum + i.unbilled_minor, 0)).toBe(card.unbilled_installments_minor)
    }
    // The cut on 20 October, provisional until entered, bills the fifth.
    const later = build(abroad, '2026-10-23')
    expect(installmentProgress(later, walked(later, { cards: CARDS }), 'rewards-card').map((i) => [i.billed, i.total])).toEqual([[5, 12]])
  })

  it('keeps an installment whose last month the current statement billed, drops one that ended before it, and counts neither a skipped month', () => {
    const lastOn = (ends_on: string, skip: string[] = []) => {
      const snapshot = build(abroad, AS_OF, (doc) => {
        const laptop = doc.plan_items.find((p) => p.id === 'laptop')
        if (laptop) Object.assign(laptop, { ends_on, skip_periods: skip })
      })
      return installmentProgress(snapshot, walked(snapshot, { cards: CARDS }), 'rewards-card').map((i) => [i.billed, i.total, i.unbilled_minor])
    }
    expect([lastOn('2026-09-01'), lastOn('2026-08-01'), lastOn('2027-05-01', ['2026-07-01', '2027-01-01'])]).toEqual([[[4, 4, 0]], [], [[3, 10, 7 * 500000]]])
    expect(() => installmentProgress(build(abroad), walked(build(abroad), { cards: CARDS }), 'main')).toThrow("'main' is not a card")
  })

  it('flags over limit exactly when the latest statement prints negative available credit', () => {
    const overLimit = (available: number | null) => {
      const snapshot = build(revolvingDaily, AS_OF, (doc) => {
        const last = doc.statements.find((s) => s.id === 'last')
        if (last) last.available_credit_minor = available
      })
      const card = debtFigures(snapshot, walked(snapshot, { cards: CARDS })).cards[0]
      return [card?.over_limit, card?.available_credit_minor]
    }
    expect([overLimit(-1), overLimit(0), overLimit(2000000), overLimit(null)]).toEqual([
      [true, -1],
      [false, 0],
      [false, 2000000],
      [false, null],
    ])
  })
})

describe('debt milestones', () => {
  it('clears revolving before debt-free while installments still run, as two separate milestones', () => {
    const snapshot = phoneCard()
    const { revolving_cleared, debt_free } = debtMilestones(snapshot, walked(snapshot, { cards: CARDS }))
    expect([revolving_cleared, debt_free]).toEqual([
      { month: '2027-02', last_owed_month: '2027-01', after_horizon: false },
      { month: '2027-10', last_owed_month: '2027-09', after_horizon: false },
    ])
  })

  it('takes debt-free as the month after the last installment month from the same function', () => {
    const snapshot = phoneCard()
    const w = walked(snapshot, { cards: CARDS })
    const lastInstallment = snapshot.doc.plan_items.find((p) => p.id === 'phone')?.ends_on?.slice(0, 7)
    const { debt_free } = debtMilestones(snapshot, w)
    expect([debt_free.last_owed_month, debt_free.month]).toEqual([lastInstallment, '2027-10'])
    expect(debtFigures(snapshot, w).cards[0]?.unbilled_installments_minor).toBe(12 * 20000)
  })

  it('clears revolving at the final clear, never at the first zero carry before it comes back', () => {
    const repair: PlanItemInput = { id: 'repair', kind: 'bill', name: 'Roof repair', from_account_id: 'card', amount_minor: 1000000, every: 'once', starts_on: '2027-06-10' }
    const snapshot = phoneCard((doc) => doc.plan_items.push(repair))
    const w = walked(snapshot, { cards: CARDS })
    const carry = replayOf(w, 'card').statements.map((s) => [s.cut_date.slice(0, 7), s.carry_minor ?? 0] as const)
    const firstZero = carry.find(([, c]) => c === 0)?.[0]
    expect([firstZero, carry.some(([month, c]) => month > (firstZero ?? '') && c > 0)]).toEqual(['2027-02', true])
    expect(debtMilestones(snapshot, w).revolving_cleared).toEqual({ month: '2028-04', last_owed_month: '2028-03', after_horizon: false })
  })

  it('gives each debt its own payoff month by the same rule, the latest of them being debt-free', () => {
    const cases = [build(abroad), build(usCardsCar), build(mortgage), build(revolvingDaily), phoneCard()]
    const payoffs = cases.map((snapshot) => {
      const w = walked(snapshot, { cards: CARDS, loans: LOANS })
      const each = debtPayoffs(snapshot, w)
      const { debt_free } = debtMilestones(snapshot, w)
      const months = [...each.values()]
      // The household is debt-free once the last debt is, and unknown while any one is.
      expect(debt_free.after_horizon && debt_free.month === null).toBe(months.some((m) => m.after_horizon && m.month === null))
      if (debt_free.month !== null) expect(months.map((m) => m.month ?? '').sort().at(-1)).toBe(debt_free.month)
      return Object.fromEntries([...each].map(([id, m]) => [id, [m.month, m.after_horizon]]))
    })
    expect(payoffs).toEqual([
      { 'rewards-card': ['2027-06', false], 'shopping-card': ['2027-11', false] },
      { 'car-loan': ['2030-01', false], 'store-card': ['2028-05', false], 'travel-card': ['2027-04', false] },
      { mortgage: ['2045-04', true] },
      { card: [null, true] },
      { card: ['2027-10', false] },
    ])
  })

  it('leaves an archived debt out of debt-free, revolving cleared and the payoffs, as total debt does', () => {
    const open = build(usCardsCar)
    const closed = build(usCardsCar, AS_OF, (doc) => {
      const car = doc.accounts.find((a) => a.id === 'car-loan')
      if (car) car.archived_at = '2026-10-01T00:00:00+00:00'
    })
    const before = debtMilestones(open, walked(open, { cards: CARDS, loans: LOANS }))
    const w = walked(closed, { cards: CARDS, loans: LOANS })
    const after = debtMilestones(closed, w)
    expect([before.debt_free.month, after.debt_free.month, after.revolving_cleared.month]).toEqual(['2030-01', '2028-05', before.revolving_cleared.month])
    expect([...debtPayoffs(closed, w).keys()].sort()).toEqual(['store-card', 'travel-card'])
  })

  it('gives a card paid in full each cycle with no installments no payoff month, as nothing is carried', () => {
    const terms = termsFromPreset('generic-in-full', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })
    const { doc, rates } = cardHousehold({ asOf: AS_OF, terms, opening_balance_minor: -300000, opening_date: '2026-09-20' })
    const snapshot = buildSnapshot(doc, AS_OF, rates)
    const w = walked(snapshot, { cards: CARDS })
    expect([debtPayoffs(snapshot, w).get('card'), debtMilestones(snapshot, w).debt_free]).toEqual([
      { month: null, last_owed_month: null, after_horizon: false },
      { month: null, last_owed_month: null, after_horizon: false },
    ])
    expect(debtFigures(snapshot, w).cards[0]?.owed_minor).toBe(300000)
  })

  it('puts debt-free after the projection while a loan is still owed at the horizon end', () => {
    const snapshot = build(mortgage)
    const { revolving_cleared, debt_free } = debtMilestones(snapshot, walked(snapshot))
    expect([revolving_cleared, debt_free.month, debt_free.after_horizon]).toEqual([{ month: null, last_owed_month: null, after_horizon: false }, null, true])
  })
})
