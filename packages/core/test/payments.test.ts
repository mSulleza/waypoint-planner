import { describe, expect, it } from 'vitest'
import { cardHousehold, type CardSetup } from '../fixtures'
import type { PlanItemInput, StatementInput, TransactionInput } from '../fixtures/relative'
import { CARDS, cardsOf, minimumDue, type CardReplay, type CardStatement } from '../src/engine/cards'
import { debtFigures } from '../src/engine/debt-figures'
import { paymentBase } from '../src/engine/payments'
import type { LineItem, Walk } from '../src/engine/types'
import { fxTerms, grossFor, netOf } from '../src/money'
import { termsFromPreset } from '../src/presets'
import { toRatesPerEur } from '../src/rates'
import type { CardTerms } from '../src/schema/terms'
import { buildSnapshot, ledgerSum, type Snapshot } from '../src/snapshot'
import { balanceOn, walked } from './walk-helpers'

const AS_OF = '2026-10-07'
const inFull = termsFromPreset('PH-min-floor', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })
const minimumOnly = termsFromPreset('US-generic', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })
const installmentsPlus = termsFromPreset('PH-daily-unpaid', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })

// The spec's made-up card: a 100,000.00 statement cut on 20 September and due on 16 October.
const september: StatementInput = { id: 'sep', account_id: 'card', cut_date: '2026-09-20', due_date: '2026-10-16', total_due_minor: 10000000, minimum_due_minor: 300000 }

function card(terms: CardTerms, setup: Partial<CardSetup> = {}, asOf = AS_OF): Snapshot {
  const { doc, rates } = cardHousehold({ asOf, terms, opening_balance_minor: -10000000, opening_date: '2026-08-21', statements: [september], ...setup })
  return buildSnapshot(doc, asOf, rates)
}

// Both legs of a card payment; the cash leg may leave earlier and may settle a plan occurrence.
function paid(id: string, cardDay: string, amount: number, cashDay = cardDay, link?: { plan_item_id: string; period: string }): TransactionInput[] {
  return [
    { id: `${id}-out`, account_id: 'cash', posted_on: cashDay, amount_minor: -amount, kind: 'transfer', transfer_id: id, ...link },
    { id: `${id}-in`, account_id: 'card', posted_on: cardDay, amount_minor: amount, kind: 'transfer', transfer_id: id },
  ]
}

const charge = (id: string, day: string, amount: number): TransactionInput => ({ id, account_id: 'card', posted_on: day, amount_minor: -amount, kind: 'expense' })

const topUpItem: PlanItemInput = { id: 'top', kind: 'transfer', name: 'Card top-up', to_account_id: 'card', amount_minor: 50000, starts_on: '2026-10-10' }
const linkTop = { plan_item_id: 'top', period: '2026-10-01' }

function replayOf(w: Walk, id = 'card'): CardReplay {
  const found = cardsOf(w)?.get(id)
  if (!found) throw new Error(`The walk has no replay for '${id}'`)
  return found
}

function cut(replay: CardReplay, cutDate: string): CardStatement {
  const found = replay.statements.find((s) => s.cut_date === cutDate)
  if (!found) throw new Error(`No statement cut on ${cutDate}`)
  return found
}

// [date, amount] of every payment line landing on the card up to `to`.
const cardPayments = (w: Walk, to: string, id = 'card') => w.lines.filter((l: LineItem) => l.account_id === id && l.kind === 'payment' && l.date <= to).map((l) => [l.date, l.amount_minor])

describe('payment figures', () => {
  it('pays an in_full card paid in two tranches after the cut exactly the second tranche, and nothing after it', () => {
    const first = card(inFull, { transactions: [...paid('part-1', '2026-09-25', 6000000), charge('shoes', '2026-09-28', 500000)] })
    const w = walked(first, { cards: CARDS })
    const replay = replayOf(w)
    // The spec's figures: 60,000.00 paid and 5,000.00 charged leave 40,000.00 to pay, not zero.
    expect([replay.remaining_due_minor, replay.owed_minor, cut(replay, '2026-09-20').payment]).toEqual([
      4000000,
      4500000,
      { base_minor: 10000000, items_minor: 0, extra_minor: 0, cap_minor: 10500000, planned_gross_minor: 10000000, paid_minor: 6000000, left_to_pay_minor: 4000000, state: 'to_pay' },
    ])
    expect(cardPayments(w, '2026-11-30')).toEqual([
      ['2026-10-16', 4000000],
      ['2026-11-16', 500000],
    ])
    // Once the second tranche is recorded, the September cycle posts nothing more; only October's own statement is paid.
    const both = walked(card(inFull, { transactions: [...paid('part-1', '2026-09-25', 6000000), charge('shoes', '2026-09-28', 500000), ...paid('part-2', '2026-10-05', 4000000)] }), { cards: CARDS })
    expect([cut(replayOf(both), '2026-09-20').payment?.left_to_pay_minor, cut(replayOf(both), '2026-09-20').payment?.state, cardPayments(both, '2026-11-30')]).toEqual([0, 'paid', [['2026-11-16', 500000]]])
  })

  it('pays an installments_plus card paid in part the rest of the larger of its minimum and installments', () => {
    const checked: StatementInput = {
      ...september,
      total_due_minor: 3000000,
      minimum_due_minor: 90000,
      previous_balance_minor: 2500000,
      payments_and_credits_minor: 2500000,
      charges_minor: 2500000,
      installments_minor: 500000,
      interest_minor: 0,
      fees_minor: 0,
    }
    const w = walked(card(installmentsPlus, { opening_balance_minor: -3000000, statements: [checked], transactions: paid('part', '2026-09-30', 200000) }), { cards: CARDS })
    const figures = cut(replayOf(w), '2026-09-20').payment
    expect([figures?.base_minor, figures?.paid_minor, figures?.left_to_pay_minor, cardPayments(w, '2026-10-31')]).toEqual([500000, 200000, 300000, [['2026-10-16', 300000]]])
  })

  it('does not post again a transfer item paid and linked before the cut, while an unlinked one is posted again and biases cash low', () => {
    const asOf = '2026-10-12'
    const paymentFor = (link?: typeof linkTop) => {
      const w = walked(card(minimumOnly, { plan_items: [topUpItem], transactions: paid('early', '2026-10-10', 50000, '2026-10-10', link) }, asOf), { cards: CARDS })
      return cut(replayOf(w), '2026-10-20')
    }
    const [linked, unlinked] = [paymentFor(linkTop), paymentFor()]
    expect([linked.payment?.items_minor, linked.payment?.left_to_pay_minor, linked.paid_minor]).toEqual([0, linked.minimum_due_minor, linked.minimum_due_minor])
    expect([unlinked.payment?.items_minor, unlinked.paid_minor - linked.paid_minor]).toEqual([50000, 50000])
  })

  it('gives the same left to pay for one payment after the cut whether or not it is linked to the cycle item', () => {
    const asOf = '2026-10-26'
    const figuresFor = (link?: typeof linkTop) => cut(replayOf(walked(card(minimumOnly, { plan_items: [topUpItem], transactions: paid('late', '2026-10-25', 50000, '2026-10-25', link) }, asOf), { cards: CARDS })), '2026-10-20')
    const [linked, unlinked] = [figuresFor(linkTop), figuresFor()]
    expect(linked.payment).toEqual(unlinked.payment)
    expect([linked.payment?.items_minor, linked.payment?.paid_minor, linked.payment?.left_to_pay_minor]).toEqual([50000, 50000, linked.minimum_due_minor])
  })

  it('keeps the item when its cash leg leaves on the cut day and the card leg posts the next day', () => {
    const asOf = '2026-10-26'
    const figuresFor = (cardDay: string) => cut(replayOf(walked(card(minimumOnly, { plan_items: [topUpItem], transactions: paid('pay', cardDay, 50000, '2026-10-20', linkTop) }, asOf), { cards: CARDS })), '2026-10-20')
    const [nextDay, cutDay] = [figuresFor('2026-10-21'), figuresFor('2026-10-20')]
    // The card leg after the cut counts as paid since the cut, so the item stays and left to pay is still the minimum.
    expect([nextDay.payment?.items_minor, nextDay.payment?.paid_minor, nextDay.payment?.left_to_pay_minor]).toEqual([50000, 50000, nextDay.minimum_due_minor])
    // On the cut day itself the payment is inside the statement, so the item counts nothing more.
    expect([cutDay.payment?.items_minor, cutDay.payment?.paid_minor, (cutDay.model?.payments_and_credits_minor ?? 0) - (nextDay.model?.payments_and_credits_minor ?? 0)]).toEqual([0, 0, 50000])
  })

  it('sizes each cycle with the items of its cut month, so the 6 Feb 2027 cut due Monday 1 Mar still takes February and every month sizes one cycle', () => {
    const terms = termsFromPreset('US-generic', { cut_day: 6, due: { day_of_month: 30 }, due_roll: 'following' })
    const item: PlanItemInput = { id: 'monthly', kind: 'transfer', name: 'Monthly card payment', to_account_id: 'card', amount_minor: 20000, starts_on: '2026-10-15' }
    const snapshot = card(terms, { statements: [{ id: 'sep', account_id: 'card', cut_date: '2026-09-06', due_date: '2026-09-30', total_due_minor: 10000000, minimum_due_minor: 300000 }], plan_items: [item] })
    const w = walked(snapshot, { cards: CARDS })
    const moves = replayOf(w).moves.filter((m) => m.kind === 'payment')
    const february = moves.find((m) => m.id === 'payment:card:2027-02-06')
    expect([february?.date, february?.occurrence_ids]).toEqual(['2027-03-01', ['monthly:2027-02-01']])
    // Every payment takes exactly the item of its cut's month, and no item is taken twice.
    const taken = moves.flatMap((m) => m.occurrence_ids)
    const paidCuts = replayOf(w).statements.filter((s) => s.pay_on !== null)
    expect(moves.every((m) => m.occurrence_ids.length === 1 && m.occurrence_ids[0] === `monthly:${m.id.slice(-10, -3)}-01`)).toBe(true)
    expect([new Set(taken).size, moves.length, taken[0], taken.at(-1)]).toEqual([taken.length, paidCuts.length, 'monthly:2026-10-01', 'monthly:2031-10-01'])
  })

  it('pays on the next cut day when the pay rule lands after it, so no cycle counts the payment of the one before and every month item is paid once', () => {
    const late = { ...minimumOnly, pay: { mode: 'minimum' as const, on: { days_after_cut: 35 } } }
    const item: PlanItemInput = { id: 'monthly', kind: 'transfer', name: 'Monthly card payment', to_account_id: 'card', amount_minor: 20000, starts_on: '2026-10-15' }
    const replay = replayOf(walked(card(late, { plan_items: [item] }), { cards: CARDS }))
    const paidCuts = replay.statements.filter((s) => s.pay_on !== null)
    // The 20 Sep cut would pay on 25 Oct, after the 20 Oct cut; it pays on that cut day instead, before the cut, so the payment is in its own cycle.
    expect(paidCuts.slice(0, 3).map((s) => [s.cut_date, s.pay_on])).toEqual([
      ['2026-09-20', '2026-10-20'],
      ['2026-10-20', '2026-11-20'],
      ['2026-11-20', '2026-12-20'],
    ])
    expect(paidCuts.every((s) => s.pay_on === replay.statements[replay.statements.indexOf(s) + 1]?.cut_date)).toBe(true)
    // Every later cycle counts no payment from the cycle before, pays its minimum plus its own month's item, and the balance falls each month.
    const later = paidCuts.slice(1)
    expect(later.every((s) => s.payment?.paid_minor === 0 && s.payment.items_minor === 20000 && s.paid_minor === s.minimum_due_minor + 20000)).toBe(true)
    const taken = replay.moves.filter((m) => m.kind === 'payment').flatMap((m) => m.occurrence_ids)
    expect([taken.length, new Set(taken).size, taken[0], taken[1], later.length]).toEqual([later.length, later.length, 'monthly:2026-10-01', 'monthly:2026-11-01', 60])
    const totals = replay.statements.filter((s) => s.cut_date >= '2026-09-20' && s.cut_date <= '2027-09-20').map((s) => s.total_due_minor)
    expect(totals.every((t, k) => k === 0 || t < (totals[k - 1] ?? 0))).toBe(true)
  })

  it('converts a transfer item from the paying account currency the way extra converts, and nets a linked payment in that currency', () => {
    const asOf = '2026-10-12'
    // A peso card paid from a euro account at a 0.5% fee; the 100.00 item and the 100.00 extra are both euros.
    const euroFunded = (transactions: TransactionInput[] = []) => {
      const extra: PlanItemInput = { id: 'extra', kind: 'transfer', name: 'Extra for debts', from_account_id: 'cash', amount_minor: 10000, starts_on: '2026-10-01' }
      const { doc, rates } = cardHousehold({ asOf, terms: installmentsPlus, opening_balance_minor: -10000000, opening_date: '2026-08-21', statements: [september], transactions, plan_items: [{ ...topUpItem, amount_minor: 10000 }, extra] })
      doc.household.base_currency = 'EUR'
      Object.assign(doc.accounts[0] ?? {}, { currency: 'EUR', fx_fee_pct: 0.005 })
      doc.accounts.push({ id: 'dollars', name: 'Dollars', kind: 'cash', currency: 'USD', opening_balance_minor: 1000000, opening_date: '2026-01-01', sort_order: 2 })
      return buildSnapshot(doc, asOf, rates)
    }
    const plain = euroFunded()
    const terms = fxTerms('EUR', 'PHP', toRatesPerEur(plain.rates), 0.005)
    if (!terms) throw new Error('No EUR to PHP rate')
    const w = walked(plain, { cards: CARDS })
    const october = cut(replayOf(w), '2026-10-20')
    expect([october.payment?.items_minor, october.payment?.extra_minor]).toEqual([netOf(10000, terms.rate, terms.feePct), netOf(10000, terms.rate, terms.feePct)])
    expect(october.payment?.items_minor).toBe(696500)
    // The euros leaving on the pay day are the base's euros plus the item's and the extra's 100.00 each.
    const sent = w.lines.find((l) => l.id === 'payment:card:2026-10-20#out')
    expect([sent?.date, sent?.amount_minor, 0 - (sent?.amount_minor ?? 0) - grossFor(october.payment?.base_minor ?? 0, terms.rate, terms.feePct)]).toEqual(['2026-11-16', -grossFor(october.payment?.left_to_pay_minor ?? 0, terms.rate, terms.feePct), 20000])
    // 60.00 sent before the cut and linked leaves 40.00 of the item, whatever the card leg landed at; sent from dollars, its card leg counts at the walk's euro rate.
    const linked = (landed: number, from = 'cash', sent = 6000) => {
      const legs: TransactionInput[] = [
        { id: 'early-out', account_id: from, posted_on: '2026-10-10', amount_minor: -sent, kind: 'transfer', transfer_id: 'early', ...linkTop },
        { id: 'early-in', account_id: 'card', posted_on: '2026-10-10', amount_minor: landed, kind: 'transfer', transfer_id: 'early' },
      ]
      return cut(replayOf(walked(euroFunded(legs), { cards: CARDS })), '2026-10-20').payment?.items_minor
    }
    const sixty = netOf(6000, terms.rate, terms.feePct)
    expect([linked(sixty), linked(420000), linked(sixty, 'dollars', 7000), netOf(4000, terms.rate, terms.feePct)]).toEqual([278600, 278600, 278600, 278600])
  })

  it('lowers left to pay on as_of with a payment whose card leg posts the day after', () => {
    const snapshot = card(inFull, { transactions: paid('in-transit', '2026-10-08', 6000000, AS_OF) })
    const w = walked(snapshot, { cards: CARDS })
    const figures = debtFigures(snapshot, w).cards[0]
    expect([figures?.remaining_due_minor, figures?.payment?.paid_minor, figures?.payment?.left_to_pay_minor, figures?.pay_on]).toEqual([4000000, 6000000, 4000000, '2026-10-16'])
    // The recorded leg moves the card on the 8th; the walk adds only the rest on the due date.
    expect([w.lines.find((l) => l.row_id === 'in-transit-in')?.date, cardPayments(w, '2026-10-31')]).toEqual(['2026-10-08', [['2026-10-16', 4000000]]])
  })

  it('gives a dormant card a minimum of 0 and nothing due, a real zero apart from a cycle already paid', () => {
    const dormant = card(minimumOnly, { opening_balance_minor: 0, opening_date: '2026-09-01', statements: [] })
    const w = walked(dormant, { cards: CARDS })
    const replay = replayOf(w)
    const current = replay.statements.find((s) => s.id === replay.current_id)
    expect(replay.statements.every((s) => s.total_due_minor === 0 && s.minimum_due_minor === 0)).toBe(true)
    expect([current?.cut_date, current?.payment?.state, current?.payment?.left_to_pay_minor, replay.moves]).toEqual(['2026-09-20', 'nothing_due', 0, []])
    // The 35.00 floor never forces a payment on a zero total.
    expect([minimumDue(minimumOnly, 0, { installments_minor: 0, interest_minor: 0, fees_minor: 0 }), minimumDue(minimumOnly, 100, { installments_minor: 0, interest_minor: 0, fees_minor: 0 })]).toEqual([0, 100])
    const settled = cut(replayOf(walked(card(inFull, { transactions: paid('all', '2026-09-30', 10000000) }), { cards: CARDS })), '2026-09-20').payment
    expect([settled?.state, settled?.left_to_pay_minor, settled?.planned_gross_minor]).toEqual(['paid', 0, 10000000])
  })

  it('never caps a logged overpayment, and caps an item at what is owed', () => {
    const over = card(inFull, { transactions: paid('over', '2026-09-30', 15000000) })
    const w = walked(over, { cards: CARDS })
    const replay = replayOf(w)
    expect([ledgerSum(over, 'card', '2026-09-30'), replay.remaining_due_minor, cut(replay, '2026-09-20').payment?.left_to_pay_minor, cut(replay, '2026-10-20').total_due_minor, cut(replay, '2026-10-20').payment?.state]).toEqual([5000000, -5000000, 0, -5000000, 'nothing_due'])
    // A 1,000,000.00 item on a card owing 100,000.00 sends only what is owed; the rest stays in cash.
    const huge: PlanItemInput = { id: 'huge', kind: 'transfer', name: 'Pay it all off', to_account_id: 'card', amount_minor: 100000000, every: 'once', starts_on: '2026-09-25' }
    const capped = walked(card(minimumOnly, { plan_items: [huge] }), { cards: CARDS })
    expect([cut(replayOf(capped), '2026-09-20').payment?.planned_gross_minor, cardPayments(capped, '2026-10-31'), balanceOn(capped, 'cash', '2026-10-16') - balanceOn(capped, 'cash', '2026-10-15')]).toEqual([10000000, [['2026-10-16', 10000000]], -10000000])
  })
})

describe('payment rules', () => {
  it('pays the printed total of an in_full card even when the model would print less', () => {
    // The model, starting from August's zero statement, would expect 0 at this cut; the bank printed 100,000.00, and that is what is paid.
    const august: StatementInput = { id: 'aug', account_id: 'card', cut_date: '2026-08-20', due_date: '2026-09-16', total_due_minor: 0, minimum_due_minor: 0 }
    const snapshot = card(inFull, { opening_balance_minor: 0, opening_date: '2026-08-01', statements: [august, september] })
    const replay = replayOf(walked(snapshot, { cards: CARDS }))
    expect([cut(replay, '2026-09-20').model?.total_due_minor, cut(replay, '2026-09-20').paid_minor]).toEqual([0, 10000000])
  })

  it('keeps the fixed minimum floor of an in_full card below its installment-only payment', () => {
    const tablet: PlanItemInput = { id: 'tablet', kind: 'installment', name: 'Tablet', from_account_id: 'card', amount_minor: 50000, starts_on: '2026-10-01', ends_on: '2027-09-01' }
    const replay = replayOf(walked(card(inFull, { opening_balance_minor: 0, statements: [], plan_items: [tablet] }), { cards: CARDS }))
    const october = cut(replay, '2026-10-20')
    // The 600.00 floor stays a floor: a 500.00 installment statement has a 500.00 minimum and pays 500.00.
    expect([inFull.minimum.floor_minor, october.total_due_minor, october.minimum_due_minor, october.paid_minor]).toEqual([60000, 50000, 50000, 50000])
  })

  it('pays a revolving card the day after its cut, and a payment before the cut does not count toward that statement minimum', () => {
    const early = { ...minimumOnly, pay: { mode: 'minimum' as const, on: { days_after_cut: 1 } } }
    const w = walked(card(early, { transactions: paid('on-cut', '2026-10-20', 300000) }), { cards: CARDS })
    const october = cut(replayOf(w), '2026-10-20')
    // The 3,000.00 on the cut day lowered the October statement; its minimum is still paid in full on the 21st.
    expect([october.pay_on, october.payment?.paid_minor, october.paid_minor, october.minimum_due_minor > 0]).toEqual(['2026-10-21', 0, october.minimum_due_minor, true])
    // It counted toward September's cycle instead, which it closes.
    expect([cut(replayOf(w), '2026-09-20').payment?.paid_minor, cut(replayOf(w), '2026-09-20').payment?.state]).toEqual([300000, 'paid'])
  })

  it('leaves a transfer fee recorded on the paying account out of the card payment', () => {
    const fee: TransactionInput = { id: 'rail-fee', account_id: 'cash', posted_on: '2026-09-30', amount_minor: -1000, kind: 'expense', description: 'Transfer fee' }
    const [plain, withFee] = [card(inFull, { transactions: paid('part', '2026-09-30', 6000000) }), card(inFull, { transactions: [...paid('part', '2026-09-30', 6000000), fee] })]
    const left = (s: Snapshot) => cut(replayOf(walked(s, { cards: CARDS })), '2026-09-20').payment?.left_to_pay_minor
    expect([left(plain), left(withFee)]).toEqual([4000000, 4000000])
  })

  it('prices the card payment from the engine and keeps card bills out of cash', () => {
    const gym: PlanItemInput = { id: 'gym', kind: 'bill', name: 'Gym', from_account_id: 'card', amount_minor: 100000, starts_on: '2026-10-10' }
    const w = walked(card(installmentsPlus, { plan_items: [gym, { ...topUpItem, amount_minor: 5000 }] }), { cards: CARDS })
    const october = cut(replayOf(w), '2026-10-20')
    // The 50.00 item adds to the payment the engine sizes; it never stands in for it.
    expect([october.payment?.base_minor, october.payment?.items_minor, october.paid_minor]).toEqual([paymentBase('installments_plus', october), 5000, paymentBase('installments_plus', october) + 5000])
    const cashLines = w.lines.filter((l) => l.account_id === 'cash')
    expect([cashLines.some((l) => l.kind === 'card_bill'), cashLines.filter((l) => l.kind === 'payment').every((l) => l.source === 'card')]).toEqual([false, true])
  })
})
