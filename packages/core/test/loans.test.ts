import { describe, expect, it } from 'vitest'
import { cardHousehold, mortgage, usCardsCar, type Sample, type SampleDoc } from '../fixtures'
import { relativeTo, transfer, type PlanItemInput } from '../fixtures/relative'
import { addMonths } from '../src/dates'
import { CARDS, cardsOf } from '../src/engine/cards'
import { debtMilestones } from '../src/engine/debt-figures'
import { LOANS, loansOf, nextLoanPayment, type LoanSchedule } from '../src/engine/loans'
import { balanceRange } from '../src/engine/rollup'
import type { Walk } from '../src/engine/types'
import { fxTerms, grossFor, netOf } from '../src/money'
import { termsFromPreset } from '../src/presets'
import { toRatesPerEur } from '../src/rates'
import { buildSnapshot, ledgerSum, type Snapshot } from '../src/snapshot'
import { balanceOn, cashHousehold, walked } from './walk-helpers'

const AS_OF = '2026-10-07'

function build(sample: (asOf: string) => Sample, asOf = AS_OF, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = sample(asOf)
  edit?.(doc)
  return buildSnapshot(doc, asOf, rates)
}

function scheduleOf(w: Walk, id: string): LoanSchedule {
  const found = loansOf(w)?.get(id)
  if (!found) throw new Error(`The walk has no schedule for '${id}'`)
  return found
}

// Interest on what is owed at `parts` per `scale` a year, a twelfth of it rounded half up in whole minor units, worked out apart from the engine.
const interestOn = (owed: number, parts: number, scale: number) => Math.floor((owed * parts * 2 + 12 * scale) / (24 * scale))

type TableRow = [day: string, interest: number, paid: number, owedAfter: number]

// An annuity table apart from the engine: interest, then the payment capped at balance plus interest, then any principal that day.
function annuityTable(owed: number, parts: number, scale: number, payment: number, first: string, principal = 0): TableRow[] {
  const rows: TableRow[] = []
  for (let k = 0; owed > 0; k++) {
    const interest = interestOn(owed, parts, scale)
    const paid = Math.min(payment, owed + interest)
    owed += interest - paid
    owed -= Math.min(principal, owed)
    rows.push([addMonths(first, k), interest, paid, owed])
  }
  return rows
}

const tableOf = (s: LoanSchedule): TableRow[] => s.payments.map((p) => [p.on, p.interest_minor, p.paid_minor + p.model_minor, p.owed_after_minor])

const carPayment = (id: string, day: string, amount = 35558) => transfer(id, 'Car payment', ['checking', day, amount], ['car-loan', day, amount])

describe('loan schedule', () => {
  it('matches an independent annuity table for the 60-month car loan to the cent, last payment included', () => {
    for (const asOf of ['2026-10-07', '2027-03-15']) {
      const w = walked(build(usCardsCar, asOf), { loans: LOANS })
      const car = scheduleOf(w, 'car-loan')
      const table = annuityTable(1800000, 69, 1000, 35558, relativeTo(asOf).on(-1, 20))
      const last = table.at(-1) ?? ['', 0, 0, 0]
      expect([table.length, last[2], last[3]]).toEqual([60, 35508, 0])
      expect(tableOf(car)).toEqual(table)
      expect(car.payoff).toEqual({ on: last[0], month: last[0].slice(0, 7), after_horizon: false })
      // The first payment is recorded; the walk's balance on as_of is the live balance, with that payment's interest posted on as_of.
      const live = table[0]?.[3] ?? 0
      expect([car.owed_minor, balanceOn(w, 'car-loan', asOf), balanceOn(w, 'car-loan', w.horizon_end)]).toEqual([live, -live, 0])
      // Every later payment leaves checking on its payment day.
      const debits = table.slice(1).map(([day, , paid]) => [`payment:car-loan:${day}#out`, 'checking', day, -paid])
      expect(w.lines.filter((l) => l.id.startsWith('payment:car-loan:') && l.id.endsWith('#out')).map((l) => [l.id, l.account_id, l.date, l.amount_minor])).toEqual(debits)
    }
  })

  it('counts a payment 3 days before the payment day, or on the day itself, in place of the scheduled debit', () => {
    const asOf = '2026-10-18'
    const october = (paidOn: string | null) => {
      const snapshot = build(usCardsCar, asOf, (doc) => {
        if (paidOn) doc.transactions.push(...carPayment('early', paidOn))
      })
      const car = scheduleOf(walked(snapshot, { loans: LOANS }), 'car-loan')
      const row = car.payments.find((p) => p.on === '2026-10-20')
      return [row?.interest_minor, row?.paid_minor, row?.model_minor, row?.owed_after_minor, car.moves.some((m) => m.id === 'payment:car-loan:2026-10-20')]
    }
    const owed = 1800000 + interestOn(1800000, 69, 1000) - 35558
    const interest = interestOn(owed, 69, 1000)
    expect(october(null)).toEqual([interest, 0, 35558, owed + interest - 35558, true])
    // Paid early in its window, the interest is the same as paying on the day.
    expect(october('2026-10-17')).toEqual([interest, 35558, 0, owed + interest - 35558, false])
    expect(october('2026-10-20')).toEqual([interest, 35558, 0, owed + interest - 35558, false])
  })

  it('takes a payment 20 days before as principal and still makes the scheduled debit', () => {
    const car = scheduleOf(walked(build(usCardsCar, AS_OF, (doc) => doc.transactions.push(...carPayment('early', '2026-09-30'))), { loans: LOANS }), 'car-loan')
    const owed = 1800000 + interestOn(1800000, 69, 1000) - 35558
    const base = owed - 35558
    const interest = interestOn(base, 69, 1000)
    expect(car.payments.slice(0, 2).map((p) => [p.on, p.paid_minor, p.model_minor, p.interest_minor, p.owed_after_minor])).toEqual([
      ['2026-09-20', 35558, 0, interestOn(1800000, 69, 1000), owed],
      ['2026-10-20', 0, 35558, interest, base + interest - 35558],
    ])
    expect(car.moves.filter((m) => m.id === 'payment:car-loan:2026-10-20').map((m) => [m.date, m.from_account_id, m.amount_minor])).toEqual([['2026-10-20', 'checking', 35558]])
  })

  it('posts a payment day that passed 5 days before as_of with nothing paid on as_of, flagged overdue', () => {
    const asOf = '2026-10-25'
    const w = walked(build(usCardsCar, asOf), { loans: LOANS })
    const car = scheduleOf(w, 'car-loan')
    expect(car.payments.find((p) => p.on === '2026-10-20')).toMatchObject({ paid_minor: 0, model_minor: 35558, overdue: true })
    expect(w.lines.filter((l) => l.id.startsWith('payment:car-loan:2026-10-20#')).map((l) => [l.id, l.account_id, l.date, l.amount_minor, l.flags])).toEqual([
      ['payment:car-loan:2026-10-20#in', 'car-loan', asOf, 35558, ['overdue']],
      ['payment:car-loan:2026-10-20#out', 'checking', asOf, -35558, ['overdue']],
    ])
    expect(car.moves.find((m) => m.id === 'interest:car-loan:2026-10-20')?.date).toBe(asOf)
    // A payment day missed in an earlier month stays history: only this month's is paid.
    const unpaid = build(usCardsCar, asOf, (doc) => {
      doc.transactions = doc.transactions.filter((t) => t.transfer_id !== 'car-paid')
    })
    const missed = scheduleOf(walked(unpaid, { loans: LOANS }), 'car-loan')
    expect([missed.payments[0], missed.moves.filter((m) => m.kind === 'payment' && m.date === asOf).map((m) => [m.id, m.overdue])]).toEqual([
      expect.objectContaining({ on: '2026-09-20', paid_minor: 0, model_minor: 0, overdue: false }),
      [['payment:car-loan:2026-10-20', true]],
    ])
  })

  it('names the next payment to make: an overdue one first, then the first unpaid payment day from today', () => {
    const due = scheduleOf(walked(build(usCardsCar), { loans: LOANS }), 'car-loan')
    expect(nextLoanPayment(due, AS_OF)).toMatchObject({ on: '2026-10-20', due_minor: 35558, paid_minor: 0, left_minor: 35558, overdue: false })
    // A part paid inside the 7-day window leaves the rest of that payment, not a fresh one.
    const part = scheduleOf(walked(build(usCardsCar, '2026-10-18', (doc) => doc.transactions.push(...carPayment('part', '2026-10-15', 15000))), { loans: LOANS }), 'car-loan')
    expect(nextLoanPayment(part, '2026-10-18')).toMatchObject({ on: '2026-10-20', due_minor: 35558, paid_minor: 15000, left_minor: 20558, overdue: false })
    const late = scheduleOf(walked(build(usCardsCar, '2026-10-25'), { loans: LOANS }), 'car-loan')
    expect(nextLoanPayment(late, '2026-10-25')).toMatchObject({ on: '2026-10-20', overdue: true })
    // Once the missed day is paid late, the next one is November's.
    const paid = scheduleOf(walked(build(usCardsCar, '2026-10-25', (doc) => doc.transactions.push(...carPayment('late', '2026-10-22'))), { loans: LOANS }), 'car-loan')
    expect(nextLoanPayment(paid, '2026-10-25')).toMatchObject({ on: '2026-11-20', paid_minor: 0, overdue: false })
    // The mortgage paid on the 1st waits for next month's payment day.
    expect(nextLoanPayment(scheduleOf(walked(build(mortgage), { loans: LOANS }), 'mortgage'), AS_OF)).toMatchObject({ on: '2026-11-01', due_minor: 100000 })
  })

  it('counts a late payment toward the payment day it missed, so it is never paid twice', () => {
    const car = scheduleOf(walked(build(usCardsCar, '2026-10-25', (doc) => doc.transactions.push(...carPayment('late', '2026-10-22'))), { loans: LOANS }), 'car-loan')
    expect(car.payments.find((p) => p.on === '2026-10-20')).toMatchObject({ paid_minor: 35558, model_minor: 0, overdue: false })
    expect(car.moves.some((m) => m.id === 'payment:car-loan:2026-10-20')).toBe(false)
  })

  it('lands the 300.00 extra on the car loan as principal once both cards are clear, and pays it off sooner', () => {
    const snapshot = build(usCardsCar)
    const w = walked(snapshot, { cards: CARDS, loans: LOANS })
    const car = scheduleOf(w, 'car-loan')
    const extras = car.moves.filter((m) => m.id.startsWith('extra:'))
    expect([debtMilestones(snapshot, w).revolving_cleared.month, extras[0]?.id, extras[0]?.amount_minor, extras.length > 12, extras.slice(1).every((m) => m.amount_minor === 30000)]).toEqual(['2028-05', 'extra:car-loan:2028-05-16', 17338, true, true])
    // Principal: the balance falls by the extra on its day.
    expect(balanceOn(w, 'car-loan', '2028-05-16') - balanceOn(w, 'car-loan', '2028-05-15')).toBe(17338)
    // The table apart from the engine, each extra coming off the balance on the 16th, before the 20th's interest.
    const extraIn = new Map(extras.map((m) => [m.date.slice(0, 7), m.amount_minor]))
    const table: TableRow[] = []
    let owed = 1800000
    for (let k = 0; owed > 0; k++) {
      const day = addMonths('2026-09-20', k)
      owed -= Math.min(owed, extraIn.get(day.slice(0, 7)) ?? 0)
      const interest = interestOn(owed, 69, 1000)
      const paid = Math.min(35558, owed + interest)
      owed += interest - paid
      if (paid > 0) table.push([day, interest, paid, owed])
    }
    expect(tableOf(car)).toEqual(table)
    const withoutExtra = build(usCardsCar, AS_OF, (doc) => {
      doc.plan_items = doc.plan_items.filter((p) => p.id !== 'extra')
    })
    const baseline = scheduleOf(walked(withoutExtra, { cards: CARDS, loans: LOANS }), 'car-loan')
    expect([car.payoff.month, baseline.payoff.month, car.payoff.after_horizon]).toEqual([table.at(-1)?.[0].slice(0, 7), '2031-08', false])
    expect((car.payoff.on ?? '') < (baseline.payoff.on ?? '')).toBe(true)
  })

  it('pays the mortgage off after the horizon, flagged, with the 200.00 overpayment continuing and escrow kept off the balance', () => {
    const w = walked(build(mortgage), { loans: LOANS })
    const home = scheduleOf(w, 'mortgage')
    const table = annuityTable(18500000, 425, 10000, 100000, '2026-09-01', 20000)
    expect([table.length, home.payoff]).toEqual([224, { on: '2045-04-01', month: '2045-04', after_horizon: true }])
    expect(tableOf(home)).toEqual(table)
    expect(home.payments.filter((p) => p.after_horizon).map((p) => p.on)).toEqual(table.filter(([day]) => day > w.horizon_end).map(([day]) => day))
    // The overpayment item keeps going every month past the projection, flagged, and the walk never sees those moves.
    const overpayments = home.moves.filter((m) => m.id.startsWith('principal:'))
    const after = overpayments.filter((m) => m.after_horizon)
    expect([overpayments.length - after.length, after[0]?.date, after.at(-1)?.date, overpayments.every((m) => m.amount_minor === 20000 && m.from_account_id === 'current')]).toEqual([60, '2031-11-01', '2045-03-01', true])
    expect(w.lines.some((l) => l.date > w.horizon_end)).toBe(false)
    // Escrow is a bill on the current account; on a payment day the mortgage moves by interest, payment and overpayment alone.
    const escrow = w.lines.filter((l) => l.occurrence_ids.some((id) => id.startsWith('escrow:')))
    expect([escrow.length, escrow.every((l) => l.account_id === 'current' && l.amount_minor === -18000)]).toEqual([60, true])
    const november = home.payments.find((p) => p.on === '2026-11-01')
    expect(balanceOn(w, 'mortgage', '2026-11-01') - balanceOn(w, 'mortgage', '2026-10-31')).toBe(100000 + 20000 - (november?.interest_minor ?? 0))
  })

  it('takes the extra first when it ranks first, and passes what it no longer needs to the card after it that day', () => {
    const dailyTerms = termsFromPreset('PH-daily-unpaid', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })
    const extra: PlanItemInput = { id: 'extra', kind: 'transfer', name: 'Extra for debts', from_account_id: 'cash', amount_minor: 50000, starts_on: '2026-10-01' }
    const { doc, rates } = cardHousehold({ asOf: AS_OF, terms: dailyTerms, opening_balance_minor: -3000000, opening_date: '2026-08-21', plan_items: [extra] })
    // 40% a year ranks above the card's 3% a month.
    doc.accounts.push({ id: 'loan', name: 'Loan', kind: 'loan', currency: 'PHP', opening_balance_minor: -200000, opening_date: '2026-09-21', funded_from_account_id: 'cash', terms: { annual_rate: 0.4, payment_minor: 50000, payment_day: 10 }, sort_order: 2 })
    const w = walked(buildSnapshot(doc, AS_OF, rates), { cards: CARDS, loans: LOANS })
    const loan = scheduleOf(w, 'loan')
    // Apart from the engine: interest, the payment, then the month's extra, until December's payment clears it.
    let owed = 200000
    const rows: TableRow[] = []
    for (const day of ['2026-10-10', '2026-11-10', '2026-12-10']) {
      const interest = interestOn(owed, 4, 10)
      const paid = Math.min(50000, owed + interest)
      owed += interest - paid
      owed -= Math.min(50000, owed)
      rows.push([day, interest, paid, owed])
    }
    expect(tableOf(loan)).toEqual(rows)
    expect(loan.moves.filter((m) => m.id.startsWith('extra:')).map((m) => [m.id, m.amount_minor])).toEqual([
      ['extra:loan:2026-10-10', 50000],
      ['extra:loan:2026-11-10', 50000],
    ])
    expect([loan.payoff.on, loan.passed_on[0]]).toEqual(['2026-12-10', { account_id: 'card', from_account_id: 'cash', day: '2026-12-10', amount_minor: 50000, occurrence_ids: ['extra:2026-12-01'] }])
    const card = cardsOf(w)?.get('card')
    expect(card?.moves.filter((m) => m.id === 'extra:card:2026-12-10').map((m) => m.amount_minor)).toEqual([50000])
  })

  it('pays a loan in another currency by grossing up from the funding account and counting what lands', () => {
    const snapshot = cashHousehold(AS_OF, (doc) => {
      doc.accounts.push({ id: 'peso-loan', name: 'Peso loan', kind: 'loan', currency: 'PHP', opening_balance_minor: -5000000, opening_date: '2026-10-01', funded_from_account_id: 'bank', terms: { annual_rate: 0.12, payment_minor: 1000000, payment_day: 15 }, sort_order: 3 })
    })
    const w = walked(snapshot, { loans: LOANS })
    const loan = scheduleOf(w, 'peso-loan')
    const terms = fxTerms('EUR', 'PHP', toRatesPerEur(snapshot.rates), 0.005)
    if (!terms) throw new Error('No EUR to PHP terms')
    const gross = grossFor(1000000, terms.rate, terms.feePct)
    const lands = netOf(gross, terms.rate, terms.feePct)
    expect(loan.payments[0]).toMatchObject({ on: '2026-10-15', interest_minor: 50000, model_minor: 1000000, owed_after_minor: 5000000 + 50000 - lands })
    expect(w.lines.filter((l) => l.id.startsWith('payment:peso-loan:2026-10-15#')).map((l) => [l.account_id, l.amount_minor])).toEqual([
      ['peso-loan', lands],
      ['bank', -gross],
    ])
    // The walk's loan balance follows the schedule on every payment day.
    expect(loan.payments.map((p) => balanceOn(w, 'peso-loan', p.on))).toEqual(loan.payments.map((p) => 0 - p.owed_after_minor))
    expect([loan.payoff.after_horizon, loan.payoff.month]).toEqual([false, '2027-03'])
  })
})

describe('loan rules', () => {
  it('keeps a facility fee off the loan, so interest runs on the principal and the fee leaves cash in the draw month', () => {
    const snapshot = cashHousehold(AS_OF, (doc) => {
      doc.accounts.push({ id: 'cash-loan', name: 'Cash loan', kind: 'loan', currency: 'EUR', opening_balance_minor: 0, opening_date: '2026-10-01', funded_from_account_id: 'bank', terms: { annual_rate: 0.12, payment_minor: 88849, payment_day: 15 }, sort_order: 3 })
      doc.transactions.push(...transfer('drawn', 'Cash loan drawn', ['cash-loan', '2026-10-01', 1000000], ['bank', '2026-10-01', 1000000]), { id: 'fee', account_id: 'bank', posted_on: '2026-10-01', amount_minor: -20000, kind: 'expense', description: 'Processing fee' })
    })
    const loan = scheduleOf(walked(snapshot, { loans: LOANS }), 'cash-loan')
    expect([loan.owed_minor, loan.payments[0]?.on, loan.payments[0]?.interest_minor]).toEqual([1000000, '2026-10-15', interestOn(1000000, 12, 100)])
    expect(ledgerSum(snapshot, 'bank', '2026-10-01') - ledgerSum(snapshot, 'bank', '2026-09-30')).toBe(1000000 - 20000)
  })

  it('pays a debt down with a draw that never touches cash, so cash shows neither leg and the payments stop', () => {
    const october = 500000 + interestOn(500000, 12, 100) - 20000
    const owed = october + interestOn(october, 12, 100) - 20000
    const snapshot = cashHousehold(AS_OF, (doc) => {
      doc.accounts.push({ id: 'old-loan', name: 'Old loan', kind: 'loan', currency: 'EUR', opening_balance_minor: -500000, opening_date: '2026-09-01', funded_from_account_id: 'bank', terms: { annual_rate: 0.12, payment_minor: 20000, payment_day: 10 }, sort_order: 3 })
      doc.transactions.push(...transfer('september', 'Loan payment', ['bank', '2026-09-10', 20000], ['old-loan', '2026-09-10', 20000]))
      doc.plan_items.push({ id: 'refinance', kind: 'income', name: 'New loan paid to the old one', to_account_id: 'old-loan', amount_minor: owed, every: 'once', starts_on: '2026-11-05' })
    })
    const w = walked(snapshot, { loans: LOANS })
    const old = scheduleOf(w, 'old-loan')
    expect(w.lines.filter((l) => l.occurrence_ids.includes('refinance:2026-11-01')).map((l) => [l.account_id, l.kind, l.date, l.amount_minor])).toEqual([['old-loan', 'draw', '2026-11-05', owed]])
    expect([old.payoff, old.moves.filter((m) => m.date >= '2026-11-05')]).toEqual([{ on: '2026-11-05', month: '2026-11', after_horizon: false }, []])
    expect(w.lines.filter((l) => l.account_id === 'bank').map((l) => [l.id, l.amount_minor])).toEqual([['payment:old-loan:2026-10-10#out', -20000]])
  })

  it('counts interest after the horizon up to the payoff, so a tail past the projection is never read as a saving', () => {
    const w = walked(build(mortgage), { loans: LOANS })
    const home = scheduleOf(w, 'mortgage')
    const table = annuityTable(18500000, 425, 10000, 100000, '2026-09-01', 20000)
    const interest = (rows: TableRow[]) => rows.reduce((sum, [, i]) => sum + i, 0)
    const within = table.filter(([day]) => day >= AS_OF && day <= w.horizon_end)
    const after = table.filter(([day]) => day > w.horizon_end)
    expect([home.interest_minor, home.interest_after_horizon_minor]).toEqual([interest(within), interest(after)])
    expect(home.interest_after_horizon_minor > home.interest_minor).toBe(true)
  })

  it('keeps an upside draw and an upside overpayment out of the loan schedule', () => {
    const offers = (confidence: 'upside' | 'committed'): PlanItemInput[] => [
      { id: 'windfall', kind: 'transfer', name: 'Bonus overpayment', to_account_id: 'mortgage', amount_minor: 500000, every: 'once', starts_on: '2027-03-15', confidence },
      { id: 'offer', kind: 'income', name: 'Top-up loan paid to the mortgage', to_account_id: 'mortgage', amount_minor: 2000000, every: 'once', starts_on: '2027-01-10', confidence },
    ]
    const run = (edit?: (doc: SampleDoc) => void) => {
      const w = walked(build(mortgage, AS_OF, edit), { loans: LOANS })
      return { schedule: scheduleOf(w, 'mortgage'), current: [...(w.balances.get('current') ?? [])] }
    }
    const baseline = run()
    expect(run((doc) => doc.plan_items.push(...offers('upside')))).toEqual(baseline)
    expect((run((doc) => doc.plan_items.push(...offers('committed'))).schedule.payoff.on ?? '') < (baseline.schedule.payoff.on ?? '')).toBe(true)
  })

  it('shows a shorter loan saves interest yet takes cash lower, from the day each payment leaves', () => {
    const run = (payment: number) => {
      const snapshot = cashHousehold(AS_OF, (doc) => {
        doc.accounts.push({ id: 'phone', name: 'Phone loan', kind: 'loan', currency: 'EUR', opening_balance_minor: -240000, opening_date: '2026-10-06', funded_from_account_id: 'bank', terms: { annual_rate: 0.12, payment_minor: payment, payment_day: 5 }, sort_order: 3 })
        doc.plan_items.push(
          { id: 'salary', kind: 'income', name: 'Salary', to_account_id: 'bank', amount_minor: 100000, starts_on: '2026-10-25' },
          { id: 'deposit', kind: 'bill', name: 'Deposit', from_account_id: 'bank', amount_minor: 550000, every: 'once', starts_on: '2026-11-06' },
        )
      })
      const w = walked(snapshot, { loans: LOANS })
      const low = balanceRange(w, 'bank', AS_OF, w.horizon_end)
      const out = w.lines.find((l) => l.id === 'payment:phone:2026-11-05#out')
      return { interest: scheduleOf(w, 'phone').interest_minor, low: [low?.lowest_minor, low?.lowest_on], out: [out?.account_id, out?.date, out?.amount_minor] }
    }
    const [short, long] = [run(42000), run(21200)]
    expect(short.interest < long.interest).toBe(true)
    expect([short.low, long.low]).toEqual([
      [500000 + 100000 - 42000 - 550000, '2026-11-06'],
      [500000 + 100000 - 21200 - 550000, '2026-11-06'],
    ])
    expect([short.out, long.out]).toEqual([
      ['bank', '2026-11-05', -42000],
      ['bank', '2026-11-05', -21200],
    ])
  })
})
