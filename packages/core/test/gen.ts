import fc, { type Arbitrary } from 'fast-check'
import { abroad, mortgage, usCardsCar, type Sample, type SampleDoc } from '../fixtures'
import { relativeTo, transfer, type AccountInput, type StatementInput } from '../fixtures/relative'
import { addDays, addMonths, monthKey } from '../src/dates'
import { CARDS, cardsOf, dueDate, minimumDue } from '../src/engine/cards'
import { expandPlan } from '../src/engine/events'
import { LOANS } from '../src/engine/loans'
import { cutIn } from '../src/engine/occurrences'
import type { Walk } from '../src/engine/types'
import type { WalkOptions } from '../src/engine/walk'
import { termsFromPreset } from '../src/presets'
import type { CardTerms } from '../src/schema/terms'
import { buildSnapshot, type Snapshot } from '../src/snapshot'

// Fixed seed and 1,000 cases for every whole-engine property (spec §12); as_of is drawn, never read from the clock.
export const SEED = 20261008
export const CASES = 1000
export const RUNS = { numRuns: CASES, seed: SEED } as const
const FIRST_AS_OF = '2026-09-01'

const FIXTURES = { abroad, 'us-cards-car': usCardsCar, mortgage } as const satisfies Record<string, (asOf: string) => Sample>
export type FixtureId = keyof typeof FIXTURES

// The card in each fixture that always carries a balance, so every case has carry; the others get a drawn pay mode.
const CARRIES: Record<FixtureId, string> = { abroad: 'shopping-card', 'us-cards-car': 'store-card', mortgage: 'card' }

type CashInput = Extract<AccountInput, { kind: 'cash' }>
type CardInput = Extract<AccountInput, { kind: 'credit_card' }>

const windowShape = fc.record({ from: fc.integer({ min: -2, max: 12 }), months: fc.option(fc.nat(24), { nil: null }), pct: fc.integer({ min: 1, max: 120 }) })
// Always covers a walked month with a floor above zero.
const needShape = fc.record({ from: fc.integer({ min: 0, max: 12 }), months: fc.option(fc.integer({ min: 1, max: 24 }), { nil: null }), pct: fc.integer({ min: 1, max: 120 }) })

const cardShape = fc.record({
  statement: fc.constantFrom('keep', 'keep', 'total_only', 'none'),
  pct: fc.integer({ min: 50, max: 150 }),
  mode: fc.constantFrom('in_full', 'minimum', 'installments_plus'),
})

const transferShape = fc.record({
  from: fc.nat(3),
  to: fc.nat(3),
  pct: fc.integer({ min: 1, max: 15 }),
  every: fc.constantFrom('month', '2weeks', 'quarter', 'year', 'once'),
  start: fc.integer({ min: -40, max: 300 }),
  ends: fc.option(fc.nat(700), { nil: null }),
})

// Recorded legs: the incoming one posts 0 to 5 days after the outgoing one; pct is per mille of the account it leaves or pays.
const legsShape = fc.record({ to: fc.nat(7), day: fc.integer({ min: -15, max: 12 }), gap: fc.integer({ min: 0, max: 5 }), pct: fc.integer({ min: 1, max: 100 }) })

export const householdCase = fc.record({
  fixture: fc.constantFrom<FixtureId>('abroad', 'us-cards-car', 'mortgage'),
  day: fc.nat(730),
  shift: fc.oneof(fc.constant(0), fc.integer({ min: -250, max: 250 }).map((n) => n / 1000)),
  openings: fc.array(fc.integer({ min: 50, max: 160 }), { minLength: 4, maxLength: 4 }),
  amounts: fc.array(fc.integer({ min: 50, max: 150 }), { minLength: 16, maxLength: 16 }),
  floors: fc.array(fc.array(windowShape, { maxLength: 2 }), { minLength: 4, maxLength: 4 }),
  need: needShape,
  cards: fc.array(cardShape, { minLength: 3, maxLength: 3 }),
  drawdown: fc.integer({ min: 0, max: 90 }),
  newCard: fc.record({ cutDay: fc.integer({ min: 1, max: 28 }), dueAfter: fc.integer({ min: 15, max: 28 }), owed: fc.integer({ min: 50000, max: 1500000 }), spend: fc.integer({ min: 1000, max: 40000 }), statement: fc.boolean() }),
  // The first transfer is monthly from within two months and never ends, so every case moves cash between accounts.
  steady: transferShape.map((t) => ({ ...t, every: 'month' as const, start: (t.start + 40) % 61, ends: null })),
  transfers: fc.array(transferShape, { maxLength: 2 }),
  debtItem: fc.record({ debt: fc.nat(7), pct: fc.integer({ min: 1, max: 10 }), day: fc.integer({ min: 1, max: 28 }), start: fc.integer({ min: 0, max: 3 }) }),
  payments: fc.array(legsShape, { maxLength: 3 }),
  moves: fc.array(legsShape, { maxLength: 3 }),
  // Which period of the debt item, and which plan item to move before track_from and by how many periods.
  period: fc.nat(59),
  pick: fc.nat(99),
  back: fc.integer({ min: 1, max: 24 }),
})

export type HouseholdCase = typeof householdCase extends Arbitrary<infer T> ? T : never

export interface DebtItem {
  id: string
  debt_id: string
  funder_id: string
  amount_minor: number
}

export interface Built {
  fixture: FixtureId
  asOf: string
  doc: SampleDoc
  snapshot: Snapshot
  options: WalkOptions
  debtItem: DebtItem
}

// Sign kept, never 0.
const scaled = (minor: number, pct: number) => Math.sign(minor) * Math.max(1, Math.round((Math.abs(minor) * pct) / 100))
const opening = (a: AccountInput) => a.opening_balance_minor ?? 0
const perMille = (minor: number, pm: number) => Math.max(100, Math.round((Math.abs(minor) * pm) / 1000))
const at = <T>(list: readonly T[], i: number): T => {
  const found = list[i % list.length]
  if (found === undefined) throw new Error('The case drew from an empty list')
  return found
}

function cardOf(doc: SampleDoc, id: string): CardInput {
  const found = doc.accounts.find((a): a is CardInput => a.id === id && a.kind === 'credit_card')
  if (!found) throw new Error(`No card '${id}' in the case`)
  return found
}

// A new statement from the drawn variation: charges scaled on a checked one, the total on a total-only one, or none at all.
function varyStatement(s: StatementInput, terms: CardTerms, v: HouseholdCase['cards'][number]): StatementInput | null {
  if (v.statement === 'none') return null
  const { previous_balance_minor: previous, payments_and_credits_minor: paid, charges_minor: charges, installments_minor: installments, interest_minor: interest, fees_minor: fees, ...rest } = s
  if (v.statement === 'keep' && previous != null && paid != null && charges != null && installments != null && interest != null && fees != null) {
    const more = Math.round((charges * v.pct) / 100)
    const total = previous - paid + more + installments + interest + fees
    return { ...s, charges_minor: more, total_due_minor: total, minimum_due_minor: minimumDue(terms, total, { installments_minor: installments, interest_minor: interest, fees_minor: fees }), available_credit_minor: null }
  }
  const total = scaled(s.total_due_minor, v.pct)
  return { ...rest, total_due_minor: total, minimum_due_minor: minimumDue(terms, total, { installments_minor: 0, interest_minor: 0, fees_minor: 0 }), available_credit_minor: null }
}

// One of the three samples varied: as_of, openings, plan amounts, floors, statements and pay modes, transfer items, a transfer item into a debt, and recorded payments and moves whose legs post up to 5 days apart.
export function buildCase(c: HouseholdCase): Built {
  const asOf = addDays(FIRST_AS_OF, c.day)
  const { doc, rates } = FIXTURES[c.fixture](asOf)
  const { first, on } = relativeTo(asOf)

  if (c.fixture === 'mortgage') {
    // The mortgage sample has no card and no funding edge; this case gives it both.
    const terms: CardTerms = { ...termsFromPreset('US-generic', { cut_day: c.newCard.cutDay, due: { days_after_cut: c.newCard.dueAfter }, due_roll: 'following' }), pay: { mode: 'minimum', on: 'due_date' } }
    doc.accounts.push({ id: 'card', name: 'Card', kind: 'credit_card', currency: 'GBP', opening_balance_minor: -c.newCard.owed, opening_date: first(-1), funded_from_account_id: 'current', terms, sort_order: 3 })
    doc.plan_items.push({ id: 'card-spend', kind: 'bill', name: 'Card spending', from_account_id: 'card', amount_minor: c.newCard.spend, starts_on: on(-1, 12) })
    if (c.newCard.statement) {
      const cut = cutIn(c.newCard.cutDay, first(-1))
      const total = c.newCard.owed + c.newCard.spend
      doc.statements.push({ id: 'card-last', account_id: 'card', cut_date: cut, due_date: dueDate(terms, cut), total_due_minor: total, minimum_due_minor: minimumDue(terms, total, { installments_minor: 0, interest_minor: 0, fees_minor: 0 }) })
    }
    for (const a of doc.accounts) if (a.id === 'current') a.funded_from_account_id = 'savings'
  }

  const cash = doc.accounts.filter((a): a is CashInput => a.kind === 'cash')
  const debts = doc.accounts.filter((a) => a.kind !== 'cash')
  cash.forEach((a, i) => {
    a.opening_balance_minor = scaled(opening(a), at(c.openings, i))
    const window = (w: { from: number; months: number | null; pct: number }) => {
      const from = addMonths(first(0), w.from)
      return { from_month: monthKey(from), to_month: w.months === null ? null : monthKey(addMonths(from, w.months)), amount_minor: Math.round((Math.abs(opening(a)) * w.pct) / 100) }
    }
    a.floor_windows = [...at(c.floors, i).map(window), ...(a.funded_from_account_id ? [window(c.need)] : [])]
  })
  doc.plan_items.forEach((p, i) => {
    p.amount_minor = scaled(p.amount_minor, at(c.amounts, i))
  })

  const cards = doc.accounts.filter((a): a is CardInput => a.kind === 'credit_card')
  cards.forEach((card, i) => {
    const v = at(c.cards, i)
    const terms = card.terms as CardTerms
    if (card.id !== CARRIES[c.fixture]) card.terms = { ...terms, pay: { ...terms.pay, mode: v.mode } }
    if (c.fixture === 'mortgage') return
    doc.statements = doc.statements.flatMap((s) => (s.account_id !== card.id ? [s] : (varyStatement(s, terms, v) ?? [])))
  })
  if (c.fixture === 'abroad') {
    // The balance conversion credits only part of the shopping card's total, so its revolving part carries.
    const shopping = cardOf(doc, 'shopping-card')
    const total = doc.statements.find((s) => s.account_id === shopping.id)?.total_due_minor ?? -opening(shopping)
    const credit = Math.round((Math.max(0, total) * c.drawdown) / 100)
    doc.transactions = doc.transactions.flatMap((t) => (t.id !== 'conversion-credit' ? [t] : credit > 0 ? [{ ...t, amount_minor: credit }] : []))
  }

  const pick = (from: number, to: number) => {
    const source = at(cash, from)
    const others = cash.filter((a) => a.id !== source.id)
    return [source, at(others, to)] as const
  }
  ;[c.steady, ...c.transfers].forEach((t, k) => {
    const [from, to] = pick(t.from, t.to)
    const starts = addDays(asOf, t.start)
    doc.plan_items.push({
      id: `move-item-${k}`,
      kind: 'transfer',
      name: `Transfer ${k}`,
      from_account_id: from.id,
      to_account_id: to.id,
      amount_minor: Math.max(100, Math.round((Math.abs(opening(from)) * t.pct) / 100)),
      every: t.every,
      starts_on: starts,
      ends_on: t.ends === null ? null : addDays(starts, t.ends),
    })
  })

  const debt = at(debts, c.debtItem.debt)
  if (!debt.funded_from_account_id) throw new Error(`Debt '${debt.id}' has no funded-from account`)
  const debtItem: DebtItem = { id: 'debt-item', debt_id: debt.id, funder_id: debt.funded_from_account_id, amount_minor: perMille(opening(debt), c.debtItem.pct) }
  doc.plan_items.push({ id: debtItem.id, kind: 'transfer', name: 'Into a debt', to_account_id: debt.id, amount_minor: debtItem.amount_minor, starts_on: on(c.debtItem.start, c.debtItem.day) })

  c.payments.forEach((p, k) => {
    const target = at(debts, p.to)
    const out = addDays(asOf, p.day)
    const amount = perMille(opening(target), Math.ceil(p.pct / 10))
    doc.transactions.push(...transfer(`pay-${k}`, 'Recorded payment', [target.funded_from_account_id ?? '', out, amount], [target.id, addDays(out, p.gap), amount]))
  })
  const sameCurrency = cash.flatMap((a) => cash.filter((b) => b.id !== a.id && b.currency === a.currency).map((b) => [a, b] as const))
  c.moves.forEach((m, k) => {
    const [from, to] = at(sameCurrency, m.to)
    const out = addDays(asOf, m.day)
    const amount = perMille(opening(from), m.pct)
    doc.transactions.push(...transfer(`move-${k}`, 'Recorded move', [from.id, out, amount], [to.id, addDays(out, m.gap), amount]))
  })

  return { fixture: c.fixture, asOf, doc, snapshot: buildSnapshot(doc, asOf, rates), options: { cards: CARDS, loans: LOANS, fx_shift_pct: c.shift }, debtItem }
}

// Fails loudly unless the case walks a cash-to-cash transfer, a card cycle, a floor and some carry (spec §12).
export function requireContents(built: Pick<Built, 'fixture' | 'asOf' | 'snapshot'>, w: Walk): void {
  const plan = expandPlan(built.snapshot)
  const statements = [...(cardsOf(w)?.values() ?? [])].flatMap((r) => r.statements)
  const has = {
    transfer: plan.events.some((e) => e.kind === 'transfer' && e.to_account_id !== null && e.date <= plan.horizon_end),
    'card cycle': statements.some((s) => s.source === 'simulated' && s.cut_date >= w.as_of && s.model !== null),
    floor: [...w.figures.values()].some((months) => months.some((m) => m.floor_set && m.floor_minor > 0)),
    carry: statements.some((s) => s.source === 'simulated' && (s.carry_minor ?? 0) > 0),
  }
  const missing = Object.entries(has).flatMap(([what, found]) => (found ? [] : [what]))
  if (missing.length > 0) throw new Error(`Vacuous case: ${built.fixture} as of ${built.asOf} has no ${missing.join(', no ')}`)
}
