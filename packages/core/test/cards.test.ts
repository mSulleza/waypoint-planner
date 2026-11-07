import { describe, expect, it } from 'vitest'
import { abroad, cardHousehold, conversionClears, markSize, missedCut, revolvingDaily, SAMPLES, type Sample, type SampleDoc } from '../fixtures'
import type { PlanItemInput, StatementInput, TransactionInput } from '../fixtures/relative'
import { addDays, firstOfMonth, monthKey } from '../src/dates'
import { CARDS, cardModule, cardsOf, dueDate, minimumDue, type CardReplay, type CardStatement } from '../src/engine/cards'
import type { Walk } from '../src/engine/types'
import { termsFromPreset } from '../src/presets'
import { buildSnapshot, type Snapshot } from '../src/snapshot'
import { statementChecks } from '../src/statement-checks'
import { balanceOn, walked } from './walk-helpers'

const AS_OF = '2026-10-07'
// Pays nothing, so a cycle holds only the rows and plan events a test puts in it.
const NO_PAY = cardModule(() => 0)

function build(sample: (asOf: string) => Sample, asOf = AS_OF, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = sample(asOf)
  edit?.(doc)
  return buildSnapshot(doc, asOf, rates)
}

function replayOf(w: Walk, id = 'card'): CardReplay {
  const found = cardsOf(w)?.get(id)
  if (!found) throw new Error(`The walk has no replay for '${id}'`)
  return found
}

function cut(replay: CardReplay, cutDate: string): CardStatement {
  const found = replay.statements.find((s) => s.cut_date === cutDate)
  if (!found) throw new Error(`No statement cut on ${cutDate} among ${replay.statements.map((s) => s.cut_date).join(', ')}`)
  return found
}

const payment = (id: string, day: string, amount: number): TransactionInput[] => [
  { id: `${id}-out`, account_id: 'cash', posted_on: day, amount_minor: -amount, kind: 'transfer', transfer_id: id },
  { id: `${id}-in`, account_id: 'card', posted_on: day, amount_minor: amount, kind: 'transfer', transfer_id: id },
]

const statementOf = (doc: SampleDoc, id: string): StatementInput => {
  const found = doc.statements.find((s) => s.id === id)
  if (!found) throw new Error(`No statement '${id}'`)
  return found
}

const entered = (snapshot: Snapshot, id: string) => {
  const found = snapshot.doc.statements.find((s) => s.id === id)
  if (!found) throw new Error(`No statement '${id}'`)
  return found
}

describe('card cycles', () => {
  it('anchors on the latest entered statement and replays the card rows from its cut', () => {
    const w = walked(build(revolvingDaily), { cards: CARDS })
    const replay = replayOf(w)
    expect([replay.anchor_id, replay.current_id, replay.statements.slice(0, 4).map((s) => [s.id, s.source, s.cut_date])]).toEqual([
      'last',
      'last',
      [
        ['prior', 'entered', '2026-08-20'],
        ['last', 'entered', '2026-09-20'],
        ['card:2026-10-20', 'simulated', '2026-10-20'],
        ['card:2026-11-20', 'simulated', '2026-11-20'],
      ],
    ])
    // The next cut starts from the printed total, and installments_plus pays the larger of the minimum and the installment on the due date.
    const october = cut(replay, '2026-10-20')
    expect([october.model?.previous_balance_minor, october.model?.payments_and_credits_minor, cut(replay, '2026-09-20').pay_on, cut(replay, '2026-09-20').paid_minor]).toEqual([3000000, 150000, '2026-10-16', 150000])
    expect(cut(replay, '2026-08-20').pay_on).toBeNull()
  })

  it('lets a balance conversion credit larger than the statement take remaining due below zero and lower the next total', () => {
    const converted = replayOf(walked(build(conversionClears), { cards: NO_PAY }))
    const unconverted = replayOf(
      walked(
        build(conversionClears, AS_OF, (doc) => {
          doc.transactions = doc.transactions.filter((t) => t.id !== 'conversion-credit')
        }),
        { cards: NO_PAY },
      ),
    )
    // 50,000.00 printed, 60,000.00 credited after the cut: 10,000.00 below zero, and the next cut nets it with 3,000.00 of shoes and 6,200.00 of installments.
    expect([converted.remaining_due_minor, converted.owed_minor, unconverted.remaining_due_minor]).toEqual([-1000000, -700000, 5000000])
    const next = cut(converted, '2026-10-25')
    expect([next.total_due_minor, next.minimum_due_minor, next.model?.interest_minor, next.grace]).toEqual([-80000, 0, 0, true])
    expect(cut(unconverted, '2026-10-25').total_due_minor - next.total_due_minor).toBeGreaterThan(6000000)
  })

  it('pays nothing on a statement a conversion credit cleared, a real zero and not missing data', () => {
    const replay = replayOf(walked(build(conversionClears), { cards: CARDS }))
    const [last, next] = [cut(replay, '2026-09-25'), cut(replay, '2026-10-25')]
    expect([last.pay_on, last.paid_minor, next.pay_on, next.paid_minor, next.total_due_minor, next.minimum_due_minor]).toEqual(['2026-10-16', 0, '2026-11-13', 0, -80000, 0])
    expect(replay.moves.filter((m) => m.date < '2026-12-01')).toEqual([])
  })

  it('lowers a statement and its interest with a draw on the plan dated before the cut', () => {
    const draw: PlanItemInput = { id: 'cash-loan', kind: 'income', name: 'Cash loan paid to the card', to_account_id: 'card', amount_minor: 1000000, every: 'once', starts_on: '2026-10-15' }
    const without = cut(replayOf(walked(build(revolvingDaily), { cards: NO_PAY })), '2026-10-20')
    const withDraw = cut(replayOf(walked(build(revolvingDaily, AS_OF, (doc) => doc.plan_items.push(draw)), { cards: NO_PAY })), '2026-10-20')
    // Nothing paid: 30,000.00 unpaid for 30 days at 0.1% a day, then 10,000.00 less for the last 5, as PH-daily-unpaid counts a credit from the day after it lands.
    expect([without.model?.interest_minor, withDraw.model?.interest_minor]).toEqual([90000, 85000])
    expect([without.total_due_minor, withDraw.total_due_minor]).toEqual([3000000 + 150000 + 90000, 3000000 - 1000000 + 150000 + 85000])
  })

  it('charges daily_on_unpaid interest by the days a payment is late, paid on day 1 against day 20', () => {
    const interestWith = (day: string) => cut(replayOf(walked(build(revolvingDaily, AS_OF, (doc) => doc.transactions.push(...payment('part', day, 1000000))), { cards: NO_PAY })), '2026-10-20').model?.interest_minor
    const [day1, day20] = [interestWith('2026-09-21'), interestWith('2026-10-10')]
    // 10,000.00 unpaid 19 more days at 3% over 30 days a day; each payment counts from the next day.
    expect([day1, day20, (day20 ?? 0) - (day1 ?? 0)]).toEqual([61000, 80000, 1000000 * 19 * 0.001])
  })

  it('counts a payment from payment_effective_lag_days after its card-leg date under both methods, while grace reads the card-leg date', () => {
    const cycle = (method: 'daily_on_unpaid' | 'average_daily_balance', lag: number, rows: TransactionInput[]) =>
      cut(
        replayOf(
          walked(
            build(revolvingDaily, AS_OF, (doc) => {
              const card = doc.accounts.find((a) => a.id === 'card')
              if (card?.kind === 'credit_card') card.terms = { ...card.terms, interest: { ...card.terms.interest, method, payment_effective_lag_days: lag } }
              doc.transactions.push(...rows)
            }),
            { cards: NO_PAY },
          ),
        ),
        '2026-10-20',
      )
    for (const method of ['daily_on_unpaid', 'average_daily_balance'] as const) {
      // 10,000.00 paid on 10 Oct lowers the base one day later for each day of lag, at 0.1% a day.
      const [none, one, two] = [0, 1, 2].map((lag) => cycle(method, lag, payment('part', '2026-10-10', 1000000)).model?.interest_minor ?? 0)
      expect([method, (one ?? 0) - (none ?? 0), (two ?? 0) - (none ?? 0)]).toEqual([method, 1000, 2000])
      // Paid in full on its due date: the lag moves no grace.
      const full = cycle(method, 2, payment('full', '2026-10-16', 3000000))
      expect([method, full.grace, full.model?.interest_minor]).toEqual([method, true, 0])
    }
  })

  it('never lets a credit still waiting at the cut lower the next cycle, as the statement already counts it', () => {
    const replay = replayOf(
      walked(
        build(revolvingDaily, AS_OF, (doc) => {
          const card = doc.accounts.find((a) => a.id === 'card')
          if (card?.kind === 'credit_card') card.terms = { ...card.terms, interest: { ...card.terms.interest, payment_effective_lag_days: 2 } }
          doc.transactions.push(...payment('on-cut', '2026-10-20', 1000000))
        }),
        { cards: NO_PAY },
      ),
    )
    const [october, november] = [cut(replay, '2026-10-20'), cut(replay, '2026-11-20')]
    // October's 30,000.00 bears 30 full days; November's base is October's total for all 31 days.
    expect([october.model?.interest_minor, october.total_due_minor, november.model?.interest_minor]).toEqual([90000, 3000000 - 1000000 + 150000 + 90000, 2240000 * 31 * 0.001])
  })

  it('charges no interest on a cycle whose statement was paid in full by its due date, under both methods, and some on a partly paid one', () => {
    for (const method of ['daily_on_unpaid', 'average_daily_balance'] as const) {
      const interestWith = (day: string, amount: number) =>
        cut(
          replayOf(
            walked(
              build(revolvingDaily, AS_OF, (doc) => {
                const card = doc.accounts.find((a) => a.id === 'card')
                if (card?.kind === 'credit_card') card.terms = { ...card.terms, interest: { ...card.terms.interest, method } }
                doc.transactions.push(...payment('pay', day, amount), { id: 'shop', account_id: 'card', posted_on: '2026-10-12', amount_minor: -400000, kind: 'expense' })
              }),
              { cards: NO_PAY },
            ),
          ),
          '2026-10-20',
        )
      const [full, partly, late] = [interestWith('2026-10-16', 3000000), interestWith('2026-10-16', 2999999), interestWith('2026-10-17', 3000000)]
      expect([method, full.grace, full.model?.interest_minor, partly.grace, late.grace]).toEqual([method, true, 0, false, false])
      expect([partly.model?.interest_minor ?? 0, late.model?.interest_minor ?? 0].every((x) => x > 0)).toBe(true)
    }
  })

  it('counts purchases since the cut in the average daily balance once grace is lost, and never in daily_on_unpaid', () => {
    const interest = (method: 'daily_on_unpaid' | 'average_daily_balance') =>
      cut(
        replayOf(
          walked(
            build(revolvingDaily, AS_OF, (doc) => {
              const card = doc.accounts.find((a) => a.id === 'card')
              if (card?.kind === 'credit_card') card.terms = { ...card.terms, interest: { ...card.terms.interest, method } }
              doc.transactions.push({ id: 'shop', account_id: 'card', posted_on: '2026-10-12', amount_minor: -400000, kind: 'expense' })
            }),
            { cards: NO_PAY },
          ),
        ),
        '2026-10-20',
      ).model?.interest_minor
    // Nothing paid, so grace is lost: the 4,000.00 shop adds 9 days at 0.1% a day to the average daily balance only.
    expect([interest('daily_on_unpaid'), interest('average_daily_balance')]).toEqual([90000, 90000 + 400000 * 9 * 0.001])
  })

  it('keeps every interest figure in whole minor units', () => {
    let seen = 0
    for (const asOf of [AS_OF, '2027-03-15']) {
      for (const sample of [...SAMPLES.map((s) => s.build), markSize, revolvingDaily, conversionClears, missedCut]) {
        const w = walked(build(sample, asOf), { cards: CARDS })
        for (const replay of cardsOf(w)?.values() ?? []) {
          for (const s of replay.statements) {
            const figures = [s.total_due_minor, s.minimum_due_minor, s.installments_minor, s.carry_minor ?? 0, s.interest_variance_minor ?? 0, ...Object.values(s.model ?? {})]
            expect([s.id, figures.every(Number.isSafeInteger)]).toEqual([s.id, true])
            if ((s.model?.interest_minor ?? 0) > 0) seen++
          }
          expect(replay.moves.every((m) => Number.isSafeInteger(m.amount_minor))).toBe(true)
        }
      }
    }
    expect(seen).toBeGreaterThan(100)
  })

  it('lets an entered statement override the model and reports the modelled minus printed interest', () => {
    const snapshot = build(revolvingDaily)
    const replay = replayOf(walked(snapshot, { cards: CARDS }))
    const last = cut(replay, '2026-09-20')
    // The model would print 30,034.00 with 534.00 of interest, the 30 Aug payment counting from 31 Aug; the bank printed 30,000.00 with 500.00.
    expect([last.source, last.total_due_minor, last.minimum_due_minor, last.due_date, last.model?.total_due_minor, last.model?.minimum_due_minor, last.model?.interest_minor, last.interest_variance_minor]).toEqual(['entered', 3000000, 90000, '2026-10-16', 3003400, 90102, 53400, 3400])
    expect(cut(replay, '2026-10-20').model?.previous_balance_minor).toBe(3000000)
    expect(replay.moves.map((m) => m.id)).not.toContain('interest:card:2026-09-20')
    expect(statementChecks(snapshot, entered(snapshot, 'last')).interest?.difference_minor).toBe(-3400)
  })

  it('marks a past cut with no entered statement provisional, pays it and posts its interest on as_of', () => {
    const w = walked(build(missedCut), { cards: CARDS })
    const replay = replayOf(w)
    expect(replay.statements.slice(0, 3).map((s) => [s.id, s.source, s.provisional, s.pay_on])).toEqual([
      ['entered', 'entered', false, null],
      ['card:2026-10-05', 'simulated', true, '2026-10-28'],
      ['card:2026-11-05', 'simulated', false, '2026-11-28'],
    ])
    expect(replay.current_id).toBe('card:2026-10-05')
    // 24% a year over 365 days on the average daily balance: the unpaid 5,000.00 and 1,200.00 of flights from the 25th.
    const interest = w.lines.find((l) => l.id === 'interest:card:2026-10-05')
    expect([cut(replay, '2026-10-05').model?.interest_minor, interest?.date, interest?.amount_minor, interest?.kind, interest?.source]).toEqual([13493, AS_OF, -13493, 'interest', 'card'])
    // A cut on as_of itself has not passed yet.
    const onTheDay = replayOf(walked(build(missedCut, '2026-10-05'), { cards: CARDS }))
    expect(cut(onTheDay, '2026-10-05').provisional).toBe(false)
  })

  it('lets a statement printed two days before its cut day stand for that cut, billing the month installment once', () => {
    const snapshot = build(revolvingDaily, AS_OF, (doc) => {
      Object.assign(statementOf(doc, 'last'), { cut_date: '2026-09-18' })
    })
    const w = walked(snapshot, { cards: CARDS })
    const replay = replayOf(w)
    expect(replay.statements.slice(0, 3).map((s) => [s.id, s.cut_date, s.installments_minor])).toEqual([
      ['prior', '2026-08-20', 150000],
      ['last', '2026-09-18', 150000],
      ['card:2026-10-20', '2026-10-20', 150000],
    ])
    expect([cut(replay, '2026-09-18').model?.installments_minor, w.lines.filter((l) => l.kind === 'installment' && l.date <= '2026-10-20').map((l) => l.id)]).toEqual([150000, ['gadget:2026-10-01']])
    expect(statementChecks(snapshot, entered(snapshot, 'last')).installments).toBeNull()
  })

  it('dues a card with no statement, opened on the 8th with its due on day 25, on the 25th of that month and pays it this cycle', () => {
    const asOf = '2026-10-08'
    const terms = termsFromPreset('PH-min-floor', { cut_day: 3, due: { day_of_month: 25 }, due_roll: 'none' })
    const replay = replayOf(walked(build(() => cardHousehold({ asOf, terms, opening_balance_minor: -250000, opening_date: asOf }), asOf), { cards: CARDS }))
    const opening = replay.statements[0]
    // 3% of 2,500.00 is under the 600.00 floor, so the floor stands.
    expect([opening?.id, opening?.source, opening?.provisional, opening?.cut_date, opening?.due_date, opening?.total_due_minor, opening?.minimum_due_minor]).toEqual(['card:opening', 'opening', false, asOf, '2026-10-25', 250000, 60000])
    expect([opening?.pay_on, opening?.paid_minor, replay.statements[1]?.cut_date]).toEqual(['2026-10-25', 250000, '2026-11-03'])
  })
})

describe('card rules', () => {
  // An in-full card cut on the 25th and due 20 days later, with a 1,000.00 card bill on the 10th and a 500.00 installment.
  const monthly = (asOf: string) =>
    cardHousehold({
      asOf,
      terms: termsFromPreset('PH-min-floor', { cut_day: 25, due: { days_after_cut: 20 }, due_roll: 'none' }),
      opening_balance_minor: 0,
      opening_date: '2026-09-01',
      plan_items: [
        { id: 'gym', kind: 'bill', name: 'Gym', from_account_id: 'card', amount_minor: 100000, starts_on: '2026-10-10' },
        { id: 'tablet', kind: 'installment', name: 'Tablet', from_account_id: 'card', amount_minor: 50000, starts_on: '2026-10-01', ends_on: '2027-09-01' },
      ],
    })

  it('moves no cash on a card bill and reaches cash through the payment after its cut', () => {
    const w = walked(build(monthly), { cards: CARDS })
    const replay = replayOf(w)
    expect([balanceOn(w, 'cash', '2026-10-10') - balanceOn(w, 'cash', '2026-10-09'), balanceOn(w, 'card', '2026-10-10') - balanceOn(w, 'card', '2026-10-09')]).toEqual([0, -100000])
    const october = cut(replay, '2026-10-25')
    expect([october.total_due_minor, october.pay_on, balanceOn(w, 'cash', '2026-11-14') - balanceOn(w, 'cash', '2026-11-13')]).toEqual([150000, '2026-11-14', -150000])
  })

  it('pays in month M the statement cut in month M minus one', () => {
    const w = walked(build(monthly), { cards: CARDS })
    const replay = replayOf(w)
    for (const month of ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03']) {
      const cash = w.lines.filter((l) => l.account_id === 'cash' && l.kind === 'payment' && monthKey(l.date) === month).reduce((sum, l) => sum - l.amount_minor, 0)
      const statement = replay.statements.find((s) => monthKey(s.cut_date) === monthKey(addDays(`${month}-01`, -1)))
      expect([month, cash]).toEqual([month, statement?.total_due_minor])
    }
  })

  it('makes carry the unpaid part of the previous statement, never below zero, and charges interest only on carry', () => {
    const october = (rows: TransactionInput[]) => cut(replayOf(walked(build(revolvingDaily, AS_OF, (doc) => doc.transactions.push(...rows)), { cards: NO_PAY })), '2026-10-20')
    const [unpaid, overpaid] = [october([]), october(payment('over', '2026-09-25', 3500000))]
    expect([unpaid.carry_minor, unpaid.model?.interest_minor]).toEqual([3000000, 90000])
    expect([overpaid.carry_minor, overpaid.model?.interest_minor, overpaid.total_due_minor]).toEqual([0, 0, 3000000 - 3500000 + 150000])
  })

  it('never reads the printed payments and credits line as cash', () => {
    const plain = walked(build(revolvingDaily), { cards: CARDS })
    const restated = walked(
      build(revolvingDaily, AS_OF, (doc) => {
        Object.assign(statementOf(doc, 'last'), { payments_and_credits_minor: 1200000, charges_minor: 1600000 })
      }),
      { cards: CARDS },
    )
    expect(restated.balances.get('cash')).toEqual(plain.balances.get('cash'))
    expect(replayOf(restated).statements.map((s) => s.total_due_minor)).toEqual(replayOf(plain).statements.map((s) => s.total_due_minor))
  })

  it('bills an installment at the cut of every month from its first billed month to its last, and the older one beside it after a conversion', () => {
    const replay = replayOf(walked(build(conversionClears), { cards: CARDS }))
    const billed = replay.statements.filter((s) => s.source === 'simulated').map((s) => [monthKey(s.cut_date), s.installments_minor])
    // The conversion bills 5,200.00 from October 2026 to September 2027; the phone keeps its 1,000.00 to January 2027.
    expect(billed.slice(0, 13)).toEqual([
      ['2026-10', 620000],
      ['2026-11', 620000],
      ['2026-12', 620000],
      ['2027-01', 620000],
      ['2027-02', 520000],
      ['2027-03', 520000],
      ['2027-04', 520000],
      ['2027-05', 520000],
      ['2027-06', 520000],
      ['2027-07', 520000],
      ['2027-08', 520000],
      ['2027-09', 520000],
      ['2027-10', 0],
    ])
    expect(billed.filter(([, amount]) => (amount as number) >= 520000)).toHaveLength(12)
  })

  it('bills an anchored month installment once, inside the entered total, and pays it inside the statement', () => {
    const snapshot = build(revolvingDaily)
    const w = walked(snapshot, { cards: CARDS })
    const replay = replayOf(w)
    // September's 1,500.00 is on the entered statement; the October cut bills only October's.
    expect([cut(replay, '2026-09-20').installments_minor, cut(replay, '2026-10-20').model?.installments_minor]).toEqual([150000, 150000])
    expect(w.lines.filter((l) => l.kind === 'installment' && l.account_id === 'card' && l.date <= '2026-10-20').map((l) => l.id)).toEqual(['gadget:2026-10-01'])
    // On an in-full card the payment is the statement total, with the installment in it once.
    const inFull = replayOf(walked(build(monthly), { cards: CARDS }))
    expect(inFull.statements.filter((s) => s.cut_date >= '2026-10-25').slice(0, 3).map((s) => [s.installments_minor, s.total_due_minor, s.paid_minor])).toEqual([
      [50000, 150000, 150000],
      [50000, 150000, 150000],
      [50000, 150000, 150000],
    ])
  })

  it('bills every installment active in its month on every simulated statement', () => {
    let checked = 0
    for (const sample of [abroad, markSize]) {
      const snapshot = build(sample)
      for (const replay of cardsOf(walked(snapshot, { cards: CARDS }))?.values() ?? []) {
        for (const s of replay.statements.filter((x) => x.source === 'simulated' && x.cut_date >= snapshot.as_of)) {
          const month = firstOfMonth(s.cut_date)
          const active = snapshot.doc.plan_items.filter((p) => p.kind === 'installment' && p.from_account_id === replay.account_id && p.starts_on <= month && month <= (p.ends_on ?? month) && !p.skip_periods.includes(month))
          expect([s.id, s.installments_minor]).toEqual([s.id, active.reduce((sum, p) => sum + p.amount_minor, 0)])
          if (active.length > 0) checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('never changes a statement already cut with a credit posted after its cut', () => {
    const refund: TransactionInput = { id: 'refund', account_id: 'card', posted_on: '2026-10-06', amount_minor: 50000, kind: 'refund' }
    const plain = replayOf(walked(build(missedCut), { cards: NO_PAY }))
    const refunded = replayOf(walked(build(missedCut, AS_OF, (doc) => doc.transactions.push(refund)), { cards: NO_PAY }))
    expect(cut(refunded, '2026-10-05').total_due_minor).toBe(cut(plain, '2026-10-05').total_due_minor)
    expect(cut(plain, '2026-11-05').total_due_minor - cut(refunded, '2026-11-05').total_due_minor).toBeGreaterThan(50000)
  })

  it('keeps billing an installment when the financed item is sold', () => {
    const sale: PlanItemInput = { id: 'sell-gadget', kind: 'income', name: 'Sell the gadget', to_account_id: 'cash', amount_minor: 900000, every: 'once', starts_on: '2026-10-12' }
    const installmentsOf = (snapshot: Snapshot) => replayOf(walked(snapshot, { cards: CARDS })).statements.map((x) => x.installments_minor)
    const kept = installmentsOf(build(revolvingDaily))
    expect(installmentsOf(build(revolvingDaily, AS_OF, (doc) => doc.plan_items.push(sale)))).toEqual(kept)
    // August to December 2026, then the plan ends with its last billed month.
    expect(kept.slice(0, 6)).toEqual([150000, 150000, 150000, 150000, 150000, 0])
  })

  it('re-anchors every walk, so a payment recorded after the cut moves the next carry and interest, and a new statement replaces the anchor', () => {
    const october = (rows: TransactionInput[]) => cut(replayOf(walked(build(revolvingDaily, AS_OF, (doc) => doc.transactions.push(...rows)), { cards: NO_PAY })), '2026-10-20')
    const [before, after] = [october([]), october(payment('early', '2026-10-01', 2000000))]
    expect([before.carry_minor, before.model?.interest_minor, after.carry_minor, after.model?.interest_minor]).toEqual([3000000, 90000, 1000000, 52000])
    const { doc, rates } = revolvingDaily(AS_OF)
    doc.statements.push({ id: 'october', account_id: 'card', cut_date: '2026-10-20', due_date: '2026-11-16', total_due_minor: 2000000, minimum_due_minor: 60000 })
    const later = replayOf(walked(buildSnapshot(doc, '2026-10-22', rates), { cards: NO_PAY }))
    expect([later.anchor_id, later.statements[0]?.id, cut(later, '2026-11-20').model?.previous_balance_minor]).toEqual(['october', 'last', 2000000])
  })
})

describe('card figures', () => {
  it('sizes the minimum from the total with the card rounding, its add-ons and floor, capped at the total and 0 with nothing owed', () => {
    const daily = termsFromPreset('PH-daily-unpaid', { cut_day: 20, due: { days_after_cut: 21 }, due_roll: 'none' })
    const floored = termsFromPreset('PH-min-floor', { cut_day: 20, due: { days_after_cut: 21 }, due_roll: 'none' })
    const none = { installments_minor: 0, interest_minor: 0, fees_minor: 0 }
    expect([minimumDue(daily, 1000001, none), minimumDue(daily, 0, none), minimumDue(daily, -5000, none), minimumDue(floored, 5000000, { ...none, installments_minor: 100000 }), minimumDue(floored, 50000, none)]).toEqual([30001, 0, 0, 250000, 50000])
  })

  it('takes the due date from the due rule and roll, never before the cut', () => {
    const terms = (due: { days_after_cut: number } | { day_of_month: number }, due_roll: 'none' | 'following' | 'preceding') => termsFromPreset('PH-round-up', { cut_day: 25, due, due_roll })
    expect([
      dueDate(terms({ day_of_month: 16 }, 'none'), '2026-10-25'),
      dueDate(terms({ day_of_month: 31 }, 'none'), '2027-01-25'),
      dueDate(terms({ day_of_month: 31 }, 'none'), '2027-02-25'),
      dueDate(terms({ days_after_cut: 21 }, 'preceding'), '2026-09-25'),
      dueDate(terms({ days_after_cut: 21 }, 'following'), '2026-09-25'),
      dueDate(terms({ day_of_month: 26 }, 'preceding'), '2026-12-25'),
    ]).toEqual(['2026-11-16', '2027-01-31', '2027-02-28', '2026-10-16', '2026-10-16', '2026-12-25'])
  })
})
