import fc, { type Arbitrary } from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { SampleDoc } from '../fixtures'
import type { PlanItemInput, TransactionInput } from '../fixtures/relative'
import { addDays, addMonths, daysBetween, monthKey } from '../src/dates'
import { expandPlan } from '../src/engine/events'
import type { Walk } from '../src/engine/types'
import { fxTerms, netOf } from '../src/money'
import { floorAndTarget, type Account } from '../src/schema/rows'
import { buildSnapshot, ledgerSum, snapshotIndex, type Snapshot } from '../src/snapshot'
import { walked } from './walk-helpers'

const RUNS = { numRuns: 200, seed: 20261008 }

const accountShape = fc.record({
  currency: fc.constantFrom('EUR', 'PHP'),
  opening: fc.integer({ min: -200000, max: 4000000 }),
  funder: fc.option(fc.nat(3), { nil: null }),
  fee: fc.constantFrom(null, 0, 0.007, 0.0125),
  sortOrder: fc.nat(5),
  windows: fc.array(fc.record({ from: fc.integer({ min: -2, max: 12 }), months: fc.option(fc.nat(24), { nil: null }), amount: fc.nat(1500000) }), { maxLength: 2 }),
})

const itemShape = fc.record({
  kind: fc.constantFrom('income', 'bill', 'allowance', 'transfer'),
  from: fc.nat(3),
  to: fc.nat(3),
  amount: fc.integer({ min: 1, max: 900000 }),
  every: fc.constantFrom('month', 'month', 'week', '2weeks', 'once', 'quarter', 'year'),
  start: fc.integer({ min: -60, max: 400 }),
  ends: fc.option(fc.nat(900), { nil: null }),
  roll: fc.constantFrom('none', 'following', 'preceding'),
})

const rowShape = fc.record({ account: fc.nat(3), day: fc.integer({ min: -40, max: 20 }), amount: fc.integer({ min: 1, max: 300000 }), money_in: fc.boolean() })
const moveShape = fc.record({ from: fc.nat(3), to: fc.nat(3), day: fc.integer({ min: -20, max: 20 }), gap: fc.nat(5), amount: fc.integer({ min: 1, max: 200000 }) })

// Cash-only households: two to four EUR and PHP accounts, funders only from earlier accounts so there is no cycle, floors, plan items, rows and recorded transfers.
const household = fc.record({
  day: fc.nat(480),
  php: fc.integer({ min: 40000, max: 90000 }),
  shift: fc.oneof(fc.constant(0), fc.integer({ min: -300, max: 300 }).map((n) => n / 1000)),
  accounts: fc.array(accountShape, { minLength: 2, maxLength: 4 }),
  items: fc.array(itemShape, { minLength: 1, maxLength: 8 }),
  rows: fc.array(rowShape, { maxLength: 6 }),
  moves: fc.array(moveShape, { maxLength: 2 }),
})

type Case = typeof household extends Arbitrary<infer T> ? T : never

function build(c: Case): { snapshot: Snapshot; doc: SampleDoc; shift: number } {
  const asOf = addDays('2026-09-01', c.day)
  const month = monthKey(asOf)
  const n = c.accounts.length
  const id = (i: number) => `a${i % n}`
  const doc: SampleDoc = {
    version: 1,
    household: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-IE', track_from: '2026-06-01' },
    accounts: c.accounts.map((a, i) => ({
      id: `a${i}`,
      name: `Account ${i}`,
      kind: 'cash' as const,
      currency: a.currency,
      opening_balance_minor: a.opening,
      opening_date: '2026-01-01',
      funded_from_account_id: a.funder !== null && a.funder < i ? `a${a.funder}` : null,
      fx_fee_pct: a.fee,
      sort_order: a.sortOrder,
      floor_windows: a.windows.map((w) => {
        const from = monthKey(addMonths(`${month}-01`, w.from))
        return { from_month: from, to_month: w.months === null ? null : monthKey(addMonths(`${from}-01`, w.months)), amount_minor: w.amount }
      }),
    })),
    categories: [{ id: 'c', name: 'Living' }],
    plan_items: c.items.map((it, k): PlanItemInput => {
      const base = { id: `i${k}`, name: `Item ${k}`, amount_minor: it.amount, every: it.every, starts_on: addDays(asOf, it.start), roll: it.roll }
      const ends_on = it.ends === null ? null : addDays(base.starts_on, it.ends)
      if (it.kind === 'income') return { ...base, kind: 'income', to_account_id: id(it.to), ends_on }
      if (it.kind === 'bill') return { ...base, kind: 'bill', from_account_id: id(it.from), ends_on }
      if (it.kind === 'allowance') return { ...base, kind: 'allowance', from_account_id: id(it.from), category_id: 'c', every: it.every === 'quarter' ? 'month' : it.every, ends_on }
      const to = it.to % n === it.from % n ? it.from + 1 : it.to
      return { ...base, kind: 'transfer', from_account_id: id(it.from), to_account_id: id(to), ends_on }
    }),
    statements: [],
    transactions: [
      ...c.rows.map((r, k): TransactionInput => ({ id: `r${k}`, account_id: id(r.account), posted_on: addDays(asOf, r.day), amount_minor: r.money_in ? r.amount : -r.amount, kind: r.money_in ? 'income' : 'expense' })),
      ...c.moves.flatMap((m, k): TransactionInput[] => {
        const [from, to] = [id(m.from), id(m.to % n === m.from % n ? m.from + 1 : m.to)]
        const out = addDays(asOf, m.day)
        return [
          { id: `m${k}-out`, account_id: from, posted_on: out, amount_minor: -m.amount, kind: 'transfer', transfer_id: `m${k}` },
          { id: `m${k}-in`, account_id: to, posted_on: addDays(out, m.gap), amount_minor: m.amount, kind: 'transfer', transfer_id: `m${k}` },
        ]
      }),
    ],
  }
  const rates = [
    { quote: 'EUR', rate: 1, day: asOf },
    { quote: 'PHP', rate: c.php / 1000, day: asOf },
  ]
  return { snapshot: buildSnapshot(doc, asOf, rates), doc, shift: c.shift }
}

const accountsOf = (snapshot: Snapshot) => snapshotIndex(snapshot).accounts
const lastBalance = (w: Walk, accountId: string) => w.balances.get(accountId)?.[w.days.length - 1] ?? NaN

// The net a pair of legs lands, at the walk's rates and the source's own fee.
function landed(w: Walk, from: Account, to: Account, gross: number): number {
  const terms = fxTerms(from.currency, to.currency, w.rates, from.kind === 'cash' ? (from.fx_fee_pct ?? 0) : 0)
  if (!terms) throw new Error(`No rate from ${from.currency} to ${to.currency}`)
  return netOf(gross, terms.rate, terms.feePct)
}

describe('walk properties, cards and loans removed', () => {
  it('conserves cash across every account and currency', () => {
    const seen = { topUps: 0, crossCurrency: 0 }
    fc.assert(
      fc.property(household, (c) => {
        const { snapshot, shift } = build(c)
        const w = walked(snapshot, { fx_shift_pct: shift })
        const accounts = accountsOf(snapshot)
        // Each account ends at its ledger sum plus the plan's events, the planned transfers it sends or receives, and its top-up legs.
        const expected = new Map(snapshot.doc.accounts.map((a) => [a.id, ledgerSum(snapshot, a.id, snapshot.as_of)]))
        const add = (accountId: string, amount: number) => expected.set(accountId, (expected.get(accountId) ?? 0) + amount)
        const plan = expandPlan(snapshot)
        for (const e of plan.events) {
          if (e.date > plan.horizon_end) continue
          add(e.account_id, e.amount_minor)
          const [from, to] = [accounts.get(e.account_id), e.to_account_id === null ? undefined : accounts.get(e.to_account_id)]
          if (e.kind === 'transfer' && from && to) {
            add(to.id, landed(w, from, to, -e.amount_minor))
            if (from.currency !== to.currency) seen.crossCurrency++
          }
        }
        for (const l of w.lines) if (l.source === 'top_up') add(l.account_id, l.amount_minor)
        seen.topUps += w.lines.filter((l) => l.source === 'top_up').length
        for (const [accountId, value] of expected) expect([accountId, lastBalance(w, accountId)]).toEqual([accountId, value])
        for (const currency of ['EUR', 'PHP']) {
          const own = snapshot.doc.accounts.filter((a) => a.currency === currency)
          const change = own.reduce((total, a) => total + lastBalance(w, a.id) - (w.start.get(a.id) ?? 0), 0)
          expect(change).toBe(w.lines.filter((l) => own.some((a) => a.id === l.account_id)).reduce((total, l) => total + l.amount_minor, 0))
        }
      }),
      RUNS,
    )
    // Not vacuous: many cases top up and many convert between currencies.
    expect([seen.topUps > 1000, seen.crossCurrency > 1000]).toEqual([true, true])
  })

  it('nets every pair of legs to zero after rate and fee', () => {
    let pairs = 0
    fc.assert(
      fc.property(household, (c) => {
        const { snapshot, shift } = build(c)
        const w = walked(snapshot, { fx_shift_pct: shift })
        const accounts = accountsOf(snapshot)
        const byId = new Map(w.lines.map((l) => [l.id, l]))
        for (const out of w.lines) {
          if (out.pair_id === null || out.amount_minor >= 0) continue
          const into = byId.get(out.pair_id)
          const [from, to] = [accounts.get(out.account_id), accounts.get(into?.account_id ?? '')]
          if (!into || !from || !to) throw new Error(`Leg '${out.id}' has no partner`)
          expect([out.id, into.date, into.pair_id, into.amount_minor]).toEqual([out.id, out.date, out.id, landed(w, from, to, -out.amount_minor)])
          if (from.currency === to.currency) expect(out.amount_minor + into.amount_minor).toBe(0)
          pairs++
        }
      }),
      RUNS,
    )
    expect(pairs).toBeGreaterThan(3000)
  })

  it('closes each month on its last day', () => {
    fc.assert(
      fc.property(household, (c) => {
        const { snapshot, shift } = build(c)
        const w = walked(snapshot, { fx_shift_pct: shift, mode: 'metrics' })
        for (const [accountId, list] of w.figures) {
          const balances = w.balances.get(accountId) ?? new Float64Array()
          let at = 0
          list.forEach((f, m) => {
            const last = daysBetween(w.as_of, f.last_day)
            expect([f.first_day, f.opening_minor]).toEqual([w.days[at], m === 0 ? w.start.get(accountId) : balances[at - 1]])
            expect([f.month, f.closing_minor]).toEqual([f.month, balances[last]])
            expect(f.closing_minor).toBe(f.opening_minor + f.in_minor - f.out_minor + f.top_up_in_minor - f.top_up_out_minor)
            at = last + 1
          })
          expect(at).toBe(w.days.length)
        }
      }),
      RUNS,
    )
  })

  it('never leaves a top-up source below its floor at the end of the day it posts', () => {
    let sent = 0
    fc.assert(
      fc.property(household, (c) => {
        const { snapshot, shift } = build(c)
        const w = walked(snapshot, { fx_shift_pct: shift })
        const accounts = accountsOf(snapshot)
        for (const l of w.lines) {
          if (l.source !== 'top_up' || l.amount_minor >= 0) continue
          const source = accounts.get(l.account_id)
          if (source?.kind !== 'cash') throw new Error(`Top-up '${l.id}' left a debt`)
          const balance = w.balances.get(source.id)?.[daysBetween(w.as_of, l.date)] ?? NaN
          expect([l.id, balance >= floorAndTarget(source.floor_windows, l.date).floor]).toEqual([l.id, true])
          sent++
        }
      }),
      RUNS,
    )
    expect(sent).toBeGreaterThan(500)
  })

  it('gives identical output for identical input', () => {
    fc.assert(
      fc.property(household, (c) => {
        const first = build(c)
        const again = buildSnapshot(JSON.parse(JSON.stringify(first.doc)), first.snapshot.as_of, first.snapshot.rates)
        expect(walked(again, { fx_shift_pct: first.shift })).toEqual(walked(first.snapshot, { fx_shift_pct: first.shift }))
      }),
      RUNS,
    )
  })
})
