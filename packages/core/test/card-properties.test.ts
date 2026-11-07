import fc, { type Arbitrary } from 'fast-check'
import { describe, expect, it } from 'vitest'
import { cardHousehold } from '../fixtures'
import type { PlanItemInput, StatementInput, TransactionInput } from '../fixtures/relative'
import { addDays, addMonths, firstOfMonth } from '../src/dates'
import { CARDS, cardModule, cardsOf, dueDate, minimumDue, type CardStatement } from '../src/engine/cards'
import { expandPlan, spreadShares } from '../src/engine/events'
import { cutIn, slotCut } from '../src/engine/occurrences'
import { termsFromPreset } from '../src/presets'
import type { CardTerms } from '../src/schema/terms'
import { buildSnapshot, snapshotIndex, type Snapshot } from '../src/snapshot'
import { balanceOn, walked } from './walk-helpers'

const RUNS = { numRuns: 150, seed: 20261008 }

const termsShape = fc.record({
  preset: fc.constantFrom('PH-daily-unpaid', 'PH-round-up', 'PH-round-off', 'PH-min-floor', 'US-generic', 'generic-in-full'),
  cutDay: fc.integer({ min: 1, max: 31 }),
  due: fc.oneof(fc.record({ days_after_cut: fc.integer({ min: 1, max: 60 }) }), fc.record({ day_of_month: fc.integer({ min: 1, max: 31 }) })),
  roll: fc.constantFrom('none', 'following', 'preceding'),
  method: fc.constantFrom('daily_on_unpaid', 'average_daily_balance'),
  rate: fc.constantFrom({ rate: 0.03, period: 'month', day_count: 30 }, { rate: 0.2499, period: 'year', day_count: 365 }, { rate: 0.18, period: 'year', day_count: 360 }),
  lag: fc.integer({ min: 0, max: 3 }),
  mode: fc.constantFrom('in_full', 'minimum', 'installments_plus'),
  payOn: fc.oneof(fc.constant('due_date' as const), fc.integer({ min: 1, max: 60 }).map((days_after_cut) => ({ days_after_cut }))),
})

const statementShape = fc.record({
  back: fc.integer({ min: 0, max: 4 }),
  shift: fc.integer({ min: -2, max: 2 }),
  checked: fc.boolean(),
  previous: fc.integer({ min: -200000, max: 5000000 }),
  paid: fc.nat(3000000),
  charges: fc.nat(3000000),
  installments: fc.nat(500000),
  interest: fc.nat(150000),
})

const rowShape = fc.record({
  day: fc.integer({ min: -150, max: 70 }),
  amount: fc.integer({ min: 1, max: 3000000 }),
  kind: fc.constantFrom('expense', 'expense', 'refund', 'drawdown', 'raise', 'lower', 'payment', 'payment', 'advance'),
  gap: fc.nat(3),
})

const itemShape = fc.record({
  kind: fc.constantFrom('card_bill', 'allowance', 'installment', 'draw', 'payment'),
  amount: fc.integer({ min: 1, max: 900000 }),
  start: fc.integer({ min: -150, max: 400 }),
  months: fc.integer({ min: 1, max: 24 }),
  every: fc.constantFrom('month', 'month', 'once', 'week'),
})

// One cash account paying one card, with the card's terms, statements, rows and plan items all drawn at random; a EUR card is paid in PHP at a fee.
const household = fc.record({
  day: fc.nat(500),
  cross: fc.boolean(),
  pays: fc.boolean(),
  opening: fc.integer({ min: -5000000, max: 200000 }),
  openedBack: fc.integer({ min: 0, max: 200 }),
  terms: termsShape,
  statements: fc.array(statementShape, { maxLength: 3 }),
  rows: fc.array(rowShape, { maxLength: 12 }),
  items: fc.array(itemShape, { maxLength: 6 }),
})

type Case = typeof household extends Arbitrary<infer T> ? T : never

function termsOf(c: Case['terms']): CardTerms {
  const terms = termsFromPreset(c.preset, { cut_day: c.cutDay, due: c.due, due_roll: c.roll })
  return { ...terms, interest: { method: c.method, ...c.rate, payment_effective_lag_days: c.lag } as CardTerms['interest'], pay: { mode: c.mode, on: c.payOn } }
}

function build(c: Case): Snapshot {
  const asOf = addDays('2026-09-01', c.day)
  const terms = termsOf(c.terms)
  const opened = addDays(asOf, -c.openedBack)
  const currency = c.cross ? 'EUR' : 'PHP'
  const cuts = new Set<string>()
  const statements: StatementInput[] = []
  c.statements.forEach((s, k) => {
    const cut = addDays(cutIn(terms.cut_day, addMonths(firstOfMonth(asOf), -s.back)), s.shift)
    if (cut > asOf || cuts.has(cut)) return
    cuts.add(cut)
    const total = s.checked ? s.previous - s.paid + s.charges + s.installments + s.interest : s.previous
    const parts = s.checked ? { previous_balance_minor: s.previous, payments_and_credits_minor: s.paid, charges_minor: s.charges, installments_minor: s.installments, interest_minor: s.interest, fees_minor: 0 } : {}
    const minimum = minimumDue(terms, total, { installments_minor: s.installments, interest_minor: s.interest, fees_minor: 0 })
    statements.push({ id: `s${k}`, account_id: 'card', cut_date: cut, due_date: dueDate(terms, cut), ...parts, total_due_minor: total, minimum_due_minor: minimum })
  })
  const transactions: TransactionInput[] = c.rows.flatMap((r, k): TransactionInput[] => {
    const day = addDays(asOf, r.day) < opened ? opened : addDays(asOf, r.day)
    const id = `r${k}`
    const cash = c.cross ? r.amount * 70 : r.amount
    switch (r.kind) {
      case 'expense':
        return [{ id, account_id: 'card', posted_on: day, amount_minor: -r.amount, kind: 'expense', category_id: 'cat-shops' }]
      case 'refund':
      case 'drawdown':
        return [{ id, account_id: 'card', posted_on: day, amount_minor: r.amount, kind: r.kind }]
      case 'raise':
      case 'lower':
        return [{ id, account_id: 'card', posted_on: day, amount_minor: r.kind === 'raise' ? r.amount : -r.amount, kind: 'adjustment' }]
      case 'payment':
        return [
          { id: `${id}-out`, account_id: 'cash', posted_on: addDays(day, -r.gap), amount_minor: -cash, kind: 'transfer', transfer_id: id },
          { id: `${id}-in`, account_id: 'card', posted_on: day, amount_minor: r.amount, kind: 'transfer', transfer_id: id },
        ]
      default:
        return [
          { id: `${id}-out`, account_id: 'card', posted_on: day, amount_minor: -r.amount, kind: 'transfer', transfer_id: id },
          { id: `${id}-in`, account_id: 'cash', posted_on: addDays(day, r.gap), amount_minor: cash, kind: 'transfer', transfer_id: id },
        ]
    }
  })
  const plan_items = c.items.map((it, k): PlanItemInput => {
    const starts = addDays(asOf, it.start)
    const base = { id: `i${k}`, name: `Item ${k}`, amount_minor: it.amount }
    switch (it.kind) {
      case 'installment':
        return { ...base, kind: 'installment', from_account_id: 'card', starts_on: firstOfMonth(starts), ends_on: addMonths(firstOfMonth(starts), it.months - 1) }
      case 'draw':
        return { ...base, kind: 'income', to_account_id: 'card', every: it.every === 'week' ? 'once' : it.every, starts_on: starts }
      case 'payment':
        return { ...base, kind: 'transfer', to_account_id: 'card', every: it.every, starts_on: starts, ends_on: addMonths(starts, it.months) }
      case 'allowance':
        return { ...base, kind: 'allowance', from_account_id: 'card', category_id: 'cat-shops', starts_on: starts, ends_on: addMonths(starts, it.months) }
      default:
        return { ...base, kind: 'bill', from_account_id: 'card', every: it.every, starts_on: starts, ends_on: addMonths(starts, it.months) }
    }
  })
  const { doc, rates } = cardHousehold({ asOf, terms, opening_balance_minor: c.opening, opening_date: opened, currency, statements, transactions, plan_items })
  // The card's own currency is set above; the cash account always holds PHP and pays a fee when it converts.
  doc.household.base_currency = 'PHP'
  Object.assign(doc.accounts[0] ?? {}, { currency: 'PHP', fx_fee_pct: 0.007 })
  return buildSnapshot(doc, asOf, rates)
}

// The day a statement's cycle starts: the opening day for the opening balance, else the day after its cut.
const startsAfter = (s: CardStatement) => (s.source === 'opening' ? addDays(s.cut_date, -1) : s.cut_date)

describe('card properties', () => {
  it('balances every simulated statement against the card rows, the plan events and the walk moves', () => {
    const seen = { interest: 0, credit: 0, entered: 0, provisional: 0, installments: 0, crossPaid: 0, draws: 0, walked: 0, items: 0, paidUp: 0, lateRule: 0, lagged: 0 }
    fc.assert(
      fc.property(household, (c) => {
        const snapshot = build(c)
        const w = walked(snapshot, { cards: c.pays ? CARDS : cardModule(() => 0) })
        const replay = cardsOf(w)?.get('card')
        if (!replay) throw new Error('The walk has no card replay')
        const terms = termsOf(c.terms)
        const asOf = snapshot.as_of
        const rows = snapshotIndex(snapshot).rowsByAccount.get('card') ?? []
        const plan = expandPlan(snapshot)
        const events = plan.events.filter((e) => e.account_id === 'card' && e.kind !== 'row')
        const installments = plan.occurrences.filter((o) => o.account_id === 'card' && o.flow === 'installment' && !o.skipped)
        const anchor = replay.statements.find((s) => s.id === replay.anchor_id)
        if (!anchor) throw new Error('The replay lost its anchor')
        if (anchor.source === 'entered') seen.entered++

        replay.statements.forEach((s, k) => {
          expect(Number.isSafeInteger(s.total_due_minor) && s.minimum_due_minor >= 0 && s.minimum_due_minor <= Math.max(0, s.total_due_minor)).toBe(true)
          // Left to pay is planned gross less payments since the cut, gross never exceeds what is owed, and the walk pays exactly what is left.
          const p = s.payment
          if (p) {
            expect([s.id, p.left_to_pay_minor, p.planned_gross_minor >= 0, p.planned_gross_minor <= Math.max(0, p.cap_minor)]).toEqual([s.id, Math.max(0, p.planned_gross_minor - p.paid_minor), true, true])
            if (c.pays && !c.cross) expect(s.paid_minor).toBe(p.left_to_pay_minor)
            if (p.items_minor > 0) seen.items++
            if (p.state === 'paid') seen.paidUp++
          }
          // A pay day never falls after the next cut; a rule that lands later pays on that cut day, so the next cycle never counts the payment.
          const next = replay.statements[k + 1]
          if (s.pay_on !== null && next) {
            const rule = terms.pay.on === 'due_date' ? s.due_date : addDays(s.cut_date, terms.pay.on.days_after_cut)
            expect([s.id, s.pay_on <= next.cut_date]).toEqual([s.id, true])
            if (rule > next.cut_date) {
              seen.lateRule++
              expect([s.id, s.pay_on]).toEqual([s.id, next.cut_date])
            }
          }
          const prev = replay.statements[k - 1]
          const m = s.model
          if (!prev || !m) return
          expect([s.previous_id, m.previous_balance_minor]).toEqual([prev.id, prev.total_due_minor])
          expect(m.total_due_minor).toBe(m.previous_balance_minor - m.payments_and_credits_minor + m.charges_minor + m.installments_minor + m.interest_minor + m.fees_minor)
          expect([Number.isSafeInteger(m.interest_minor), m.interest_minor >= 0, (s.carry_minor ?? 0) >= 0, s.grace !== true || m.interest_minor === 0]).toEqual([true, true, true, true])
          if (s.source !== 'simulated' || s.cut_date <= anchor.cut_date) return
          if (m.interest_minor > 0) seen.interest++
          if (m.interest_minor > 0 && terms.interest.payment_effective_lag_days > 0) seen.lagged++
          if (s.total_due_minor < 0) seen.credit++
          if (s.provisional) seen.provisional++

          // Sum the cycle from the data alone: recorded rows, plan events and the walk's own payment and interest lines.
          const from = startsAfter(prev)
          const inCycle = (day: string) => day > from && day <= s.cut_date
          let [credits, charges] = [0, 0]
          for (const t of rows) if (inCycle(t.posted_on)) [credits, charges] = t.amount_minor > 0 ? [credits + t.amount_minor, charges] : [credits, charges - t.amount_minor]
          for (const e of events) {
            if (e.kind === 'allowance') {
              spreadShares(e).forEach((share, d) => {
                if (inCycle(addDays(e.date, d))) charges -= share
              })
            } else if (e.kind !== 'installment' && inCycle(e.date)) {
              if (e.amount_minor > 0) credits += e.amount_minor
              else charges -= e.amount_minor
              if (e.kind === 'draw') seen.draws++
            }
          }
          for (const l of w.lines) {
            if (l.account_id !== 'card' || l.kind !== 'payment' || !inCycle(l.date)) continue
            credits += l.amount_minor
            if (c.cross) seen.crossPaid++
          }
          const through = prev.source === 'entered' && slotCut(terms.cut_day, prev.cut_date) > prev.cut_date ? slotCut(terms.cut_day, prev.cut_date) : prev.cut_date
          const billed = installments.filter((o) => o.date > through && o.date <= s.cut_date).reduce((sum, o) => sum + o.amount_minor, 0)
          if (billed > 0) seen.installments++
          const interest = 0 - (w.lines.find((l) => l.id === `interest:card:${s.cut_date}`)?.amount_minor ?? 0)
          expect([s.id, m.payments_and_credits_minor, m.charges_minor, m.installments_minor, m.interest_minor]).toEqual([s.id, credits, charges, billed, interest])
          expect(s.total_due_minor).toBe(prev.total_due_minor - credits + charges + billed + interest)

          // Once both cuts are walked days, the card's own balance moves by exactly the change in total; the opening balance is a start of day, not a cut.
          if (prev.cut_date >= asOf && prev.source !== 'opening') {
            seen.walked++
            expect(balanceOn(w, 'card', s.cut_date) - balanceOn(w, 'card', prev.cut_date)).toBe(prev.total_due_minor - s.total_due_minor)
          }
        })
      }),
      RUNS,
    )
    // Every case kind must have come up, or the property proved nothing about it.
    for (const [kind, count] of Object.entries(seen)) expect([kind, count > 0]).toEqual([kind, true])
  })

  it('never lowers a cycle\'s interest by counting the same payments and credits later', () => {
    let raised = 0
    fc.assert(
      fc.property(household, (c) => {
        const interestAt = (lag: number) => {
          const replay = cardsOf(walked(build({ ...c, terms: { ...c.terms, lag } }), { cards: cardModule(() => 0) }))?.get('card')
          if (!replay) throw new Error('The walk has no card replay')
          return new Map(replay.statements.flatMap((s) => (s.model ? [[s.id, s.model.interest_minor] as const] : [])))
        }
        const [now, later] = [interestAt(0), interestAt(3)]
        expect([...later.keys()]).toEqual([...now.keys()])
        for (const [id, interest] of now) {
          expect([id, (later.get(id) ?? 0) >= interest]).toEqual([id, true])
          if ((later.get(id) ?? 0) > interest) raised++
        }
      }),
      RUNS,
    )
    expect(raised).toBeGreaterThan(0)
  })
})
