import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mortgage, type SampleDoc } from '../fixtures'
import { addDays, addMonths, daysBetween, daysInMonth, lastDayOfMonth } from '../src/dates'
import { CARDS, cardsOf, type CardStatement } from '../src/engine/cards'
import { expandPlan, spreadShares } from '../src/engine/events'
import { LOANS, loansOf } from '../src/engine/loans'
import { walkMetrics } from '../src/engine/metrics'
import { slotCut } from '../src/engine/occurrences'
import { applyPatch } from '../src/levers'
import type { LineItem, Walk } from '../src/engine/types'
import { fxTerms, grossFor, netOf } from '../src/money'
import { floorAndTarget, MONTHS_APART, type Account, type PlanItem } from '../src/schema/rows'
import { parsePatch } from '../src/schema/patch'
import { buildSnapshot, ledgerSum, snapshotIndex, type Snapshot } from '../src/snapshot'
import { buildCase, householdCase, requireContents, RUNS, type Built, type HouseholdCase } from './gen'
import { walked } from './walk-helpers'

// Each property walks 1,000 households, so it gets more than vitest's default 5 seconds.
const LONG = 180_000

function baseline(c: HouseholdCase, mode: 'full' | 'metrics' = 'full'): { built: Built; w: Walk } {
  const built = buildCase(c)
  const w = walked(built.snapshot, { ...built.options, mode })
  requireContents(built, w)
  return { built, w }
}

const copy = (doc: SampleDoc): SampleDoc => JSON.parse(JSON.stringify(doc))

function accountIn(snapshot: Snapshot, id: string): Account {
  const found = snapshotIndex(snapshot).accounts.get(id)
  if (!found) throw new Error(`No account '${id}' in the case`)
  return found
}

// The rate and source fee money crosses at in this walk, computed here from the walk's rates rather than read from its lines.
function termsIn(w: Walk, from: Account, to: Account) {
  const terms = fxTerms(from.currency, to.currency, w.rates, from.kind === 'cash' ? (from.fx_fee_pct ?? 0) : 0)
  if (!terms) throw new Error(`No rate from ${from.currency} to ${to.currency}`)
  return terms
}

const landed = (w: Walk, from: Account, to: Account, gross: number) => {
  const { rate, feePct } = termsIn(w, from, to)
  return netOf(gross, rate, feePct)
}

const lastBalance = (w: Walk, accountId: string) => w.balances.get(accountId)?.[w.days.length - 1] ?? NaN

// Maps, sets, typed arrays, undefined and non-finite numbers spelled out with their type, so equal text means equal values.
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === undefined) return '\u0000undefined'
    if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? v : `\u0000${Object.is(v, -0) ? '-0' : String(v)}`
    if (v instanceof Map) return ['\u0000Map', ...v]
    if (v instanceof Set) return ['\u0000Set', ...v]
    if (ArrayBuffer.isView(v)) return [`\u0000${v.constructor.name}`, ...Array.from(v as Float64Array)]
    return v
  })
}

// A text comparison is several times faster than toEqual on a whole walk; toEqual still decides and shows any difference.
function expectSame(actual: unknown, expected: unknown): void {
  if (canon(actual) !== canon(expected)) expect(actual).toEqual(expected)
}

// The debts' own moves, from the card replays and loan schedules the walk ran.
function debtMoves(w: Walk) {
  const cards = [...(cardsOf(w)?.values() ?? [])].flatMap((r) => r.moves)
  const loans = [...(loansOf(w)?.values() ?? [])].flatMap((s) => s.moves.filter((m) => !m.after_horizon))
  return [...cards, ...loans]
}

// The item's start moved n periods back on its own schedule, on days that exist, so later periods fall on the same days; null for a one-off.
function periodsBack(item: PlanItem, n: number): string | null {
  if (item.every === 'week' || item.every === '2weeks') return addDays(item.starts_on, -n * (item.every === 'week' ? 7 : 14))
  if (item.every === 'once') return null
  const day = item.starts_on.slice(8, 10)
  let month = `${item.starts_on.slice(0, 7)}-01`
  for (let left = n; left > 0; ) {
    month = addMonths(month, -MONTHS_APART[item.every])
    if (Number(day) <= daysInMonth(month)) left--
  }
  return `${month.slice(0, 8)}${day}`
}

// The period just before the item's start, as the schedule would place it.
function periodBefore(item: PlanItem): string | null {
  if (item.every === 'week' || item.every === '2weeks') return addDays(item.starts_on, item.every === 'week' ? -7 : -14)
  return item.every === 'once' ? null : addMonths(item.starts_on, -MONTHS_APART[item.every])
}

describe('whole-engine properties on the varied samples', () => {
  it('conserves cash, every balance being its ledger, plan events, debt moves and top-ups', () => {
    const seen = { payments: 0, topUps: 0, crossCurrency: 0, interest: 0 }
    fc.assert(
      fc.property(householdCase, (c) => {
        const { built, w } = baseline(c)
        const { snapshot } = built
        const expected = new Map(snapshot.doc.accounts.map((a) => [a.id, ledgerSum(snapshot, a.id, snapshot.as_of)]))
        const add = (accountId: string, amount: number) => expected.set(accountId, (expected.get(accountId) ?? NaN) + amount)
        const plan = expandPlan(snapshot)
        for (const e of plan.events) {
          if (e.date > plan.horizon_end) continue
          add(e.account_id, e.amount_minor)
          if (e.kind !== 'transfer' || e.to_account_id === null) continue
          const [from, to] = [accountIn(snapshot, e.account_id), accountIn(snapshot, e.to_account_id)]
          add(to.id, landed(w, from, to, -e.amount_minor))
          if (from.currency !== to.currency) seen.crossCurrency++
        }
        for (const m of debtMoves(w)) {
          if (m.from_account_id === null) {
            add(m.account_id, m.amount_minor)
            seen.interest++
            continue
          }
          const [from, debt] = [accountIn(snapshot, m.from_account_id), accountIn(snapshot, m.account_id)]
          const { rate, feePct } = termsIn(w, from, debt)
          const gross = grossFor(m.amount_minor, rate, feePct)
          add(from.id, -gross)
          add(debt.id, netOf(gross, rate, feePct))
          seen.payments++
        }
        for (const l of w.lines) if (l.source === 'top_up') add(l.account_id, l.amount_minor)
        seen.topUps += w.lines.filter((l) => l.source === 'top_up').length
        for (const [accountId, value] of expected) expect([accountId, lastBalance(w, accountId)]).toEqual([accountId, value])

        // Day by day, each balance moves by exactly that day's lines, allowances spread over their days.
        for (const a of snapshot.doc.accounts) {
          const moved = new Float64Array(w.days.length)
          for (const l of w.lines) {
            if (l.account_id !== a.id) continue
            const i = daysBetween(w.as_of, l.date)
            if (l.kind === 'allowance') spreadShares(l).forEach((share, k) => (moved[i + k] = (moved[i + k] ?? 0) + share))
            else moved[i] = (moved[i] ?? 0) + l.amount_minor
          }
          const balances = w.balances.get(a.id) ?? new Float64Array()
          let before = w.start.get(a.id) ?? NaN
          for (let i = 0; i < w.days.length; i++) {
            const after = balances[i] ?? NaN
            if (after - before !== moved[i]) expect([a.id, w.days[i], after - before]).toEqual([a.id, w.days[i], moved[i]])
            before = after
          }
        }
      }),
      RUNS,
    )
    // Not vacuous: payments, interest, top-ups and conversions all came up many times.
    expect(Object.entries(seen).filter(([, n]) => n < 1000)).toEqual([])
  }, LONG)

  it('nets transfer legs to zero after rate and fee across the leg-date window', () => {
    const seen = { pairs: 0, crossPairs: 0, recorded: 0, inTransit: 0, gapped: 0 }
    fc.assert(
      fc.property(householdCase, (c) => {
        const { built, w } = baseline(c)
        const { snapshot } = built
        const byId = new Map(w.lines.map((l) => [l.id, l]))
        // The walk's own pairs land the same day: planned transfers, top-ups and debt payments.
        for (const out of w.lines) {
          if (out.pair_id === null || out.amount_minor >= 0) continue
          const into = byId.get(out.pair_id)
          if (!into) throw new Error(`Leg '${out.id}' has no partner`)
          const [from, to] = [accountIn(snapshot, out.account_id), accountIn(snapshot, into.account_id)]
          expect([out.id, into.date, into.pair_id, into.amount_minor]).toEqual([out.id, out.date, out.id, landed(w, from, to, -out.amount_minor)])
          if (from.currency === to.currency) expect(out.amount_minor + into.amount_minor).toBe(0)
          else seen.crossPairs++
          seen.pairs++
        }
        // Recorded legs keep their own dates: summed over the window from the outgoing leg to the incoming one, both counted once, they net to zero.
        const rowLines = new Map<string, LineItem[]>()
        for (const l of w.lines) if (l.row_id !== null) rowLines.set(l.row_id, [...(rowLines.get(l.row_id) ?? []), l])
        for (const a of snapshot.doc.accounts) expect([a.id, w.start.get(a.id)]).toEqual([a.id, ledgerSum(snapshot, a.id, w.as_of)])
        for (const [transferId, legs] of snapshotIndex(snapshot).transfers) {
          const [out, into] = legs
          if (!out || !into || into.posted_on <= w.as_of) continue
          const gap = daysBetween(out.posted_on, into.posted_on)
          expect([transferId, gap >= 0 && gap <= 5]).toEqual([transferId, true])
          let sum = 0
          for (const leg of [out, into]) {
            const found = (rowLines.get(leg.id) ?? []).map((l) => [l.date, l.amount_minor])
            // On or before as_of a leg is in the start balance, checked above against the ledger; after it, it is one line on its own day.
            expect([leg.id, found]).toEqual([leg.id, leg.posted_on <= w.as_of ? [] : [[leg.posted_on, leg.amount_minor]]])
            sum += leg.amount_minor
          }
          // The cases record moves in one currency only, so the legs cancel exactly; a converted one would need its own rate here.
          expect([transferId, accountIn(snapshot, into.account_id).currency, sum]).toEqual([transferId, accountIn(snapshot, out.account_id).currency, 0])
          seen.recorded++
          if (out.posted_on <= w.as_of) seen.inTransit++
          if (gap > 0) seen.gapped++
        }
      }),
      RUNS,
    )
    expect(Object.entries(seen).filter(([, n]) => n < 100)).toEqual([])
  }, LONG)

  it('closes each month on its last day', () => {
    fc.assert(
      fc.property(householdCase, (c) => {
        const { w } = baseline(c, 'metrics')
        for (const [accountId, list] of w.figures) {
          const balances = w.balances.get(accountId) ?? new Float64Array()
          let at = 0
          list.forEach((f, m) => {
            const last = daysBetween(w.as_of, f.last_day)
            expect([accountId, f.first_day, f.opening_minor]).toEqual([accountId, w.days[at], m === 0 ? w.start.get(accountId) : balances[at - 1]])
            expect([accountId, f.month, f.last_day, f.closing_minor]).toEqual([accountId, f.month, lastDayOfMonth(f.month), balances[last]])
            expect(f.closing_minor).toBe(f.opening_minor + f.in_minor - f.out_minor + f.top_up_in_minor - f.top_up_out_minor)
            at = last + 1
          })
          expect([accountId, at]).toEqual([accountId, w.days.length])
        }
      }),
      RUNS,
    )
  }, LONG)

  // The empty patch in each form parsePatch reads, through applyPatch: the world is the snapshot itself, walked with no shift and the default modules.
  it('equals the baseline under an empty patch', () => {
    fc.assert(
      fc.property(householdCase, (c) => {
        const built = buildCase(c)
        const levers = { cards: CARDS, loans: LOANS }
        const base = walked(built.snapshot, levers)
        requireContents(built, base)
        const worlds = [undefined, '{}', {}, { patch: {} }].map((form) => {
          expect(parsePatch(form)).toEqual({ ok: true, value: {} })
          const applied = applyPatch(built.snapshot, form)
          if (!applied.ok) throw new Error(`The empty patch did not apply: ${applied.errors.join('; ')}`)
          return applied.value
        })
        for (const world of worlds) expect([world.snapshot === built.snapshot, world.patch, world.options]).toEqual([true, {}, { fx_shift_pct: 0, ...levers }])
        const world = worlds[0]
        if (!world) throw new Error('No world')
        expectSame(world.snapshot, built.snapshot)
        const patched = walked(world.snapshot, world.options)
        expectSame(patched, base)
        expect(walkMetrics(world.snapshot, patched)).toEqual(walkMetrics(built.snapshot, base))
      }),
      RUNS,
    )
  }, LONG)

  it('never leaves a top-up source below its floor at the end of the day it posts', () => {
    let sent = 0
    fc.assert(
      fc.property(householdCase, (c) => {
        const { built, w } = baseline(c)
        for (const l of w.lines) {
          if (l.source !== 'top_up' || l.amount_minor >= 0) continue
          const source = accountIn(built.snapshot, l.account_id)
          if (source.kind !== 'cash') throw new Error(`Top-up '${l.id}' left a debt`)
          const balance = w.balances.get(source.id)?.[daysBetween(w.as_of, l.date)] ?? NaN
          expect([l.id, balance >= floorAndTarget(source.floor_windows, l.date).floor]).toEqual([l.id, true])
          sent++
        }
      }),
      RUNS,
    )
    expect(sent).toBeGreaterThan(10000)
  }, LONG)

  it('never lets carry go negative', () => {
    let carried = 0
    fc.assert(
      fc.property(householdCase, (c) => {
        const { w } = baseline(c, 'metrics')
        for (const replay of cardsOf(w)?.values() ?? []) {
          for (const s of replay.statements) {
            expect([s.id, s.carry_minor === null || s.carry_minor >= 0]).toEqual([s.id, true])
            // A modelled cycle carries what its payments and credits left of the previous total.
            if (s.source === 'simulated' && s.model) expect([s.id, s.carry_minor]).toEqual([s.id, Math.max(0, s.model.previous_balance_minor - s.model.payments_and_credits_minor)])
            if ((s.carry_minor ?? 0) > 0) carried++
          }
        }
      }),
      RUNS,
    )
    expect(carried).toBeGreaterThan(10000)
  }, LONG)

  it('balances every simulated statement against the card rows', () => {
    const seen = { statements: 0, interest: 0, installments: 0, payments: 0, inTransit: 0, charges: 0 }
    fc.assert(
      fc.property(householdCase, (c) => {
        const { built, w } = baseline(c)
        const { snapshot } = built
        const index = snapshotIndex(snapshot)
        const plan = expandPlan(snapshot)
        for (const [cardId, replay] of cardsOf(w) ?? []) {
          const card = accountIn(snapshot, cardId)
          if (card.kind !== 'credit_card') throw new Error(`'${cardId}' is not a card`)
          const rows = index.rowsByAccount.get(cardId) ?? []
          const events = plan.events.filter((e) => e.account_id === cardId && e.kind !== 'row')
          const installments = plan.occurrences.filter((o) => o.account_id === cardId && o.flow === 'installment' && !o.skipped)
          const anchor = replay.statements.find((s) => s.id === replay.anchor_id)
          if (!anchor) throw new Error(`The replay of '${cardId}' lost its anchor`)
          replay.statements.forEach((s, k) => {
            const prev = replay.statements[k - 1]
            const m = s.model
            if (!prev || !m || s.source !== 'simulated' || s.cut_date <= anchor.cut_date) return
            // The cycle summed from the data alone: card rows, plan events and the walk's payment and interest lines.
            const from = (p: CardStatement) => (p.source === 'opening' ? addDays(p.cut_date, -1) : p.cut_date)
            const inCycle = (day: string) => day > from(prev) && day <= s.cut_date
            let [credits, charges] = [0, 0]
            for (const t of rows) {
              if (!inCycle(t.posted_on)) continue
              if (t.amount_minor > 0) credits += t.amount_minor
              else charges -= t.amount_minor
              if (t.kind === 'transfer' && t.amount_minor > 0 && (index.transfers.get(t.transfer_id ?? '')?.[0]?.posted_on ?? '') < t.posted_on) seen.inTransit++
            }
            for (const e of events) {
              if (e.kind === 'allowance') spreadShares(e).forEach((share, d) => (charges -= inCycle(addDays(e.date, d)) ? share : 0))
              else if (e.kind !== 'installment' && inCycle(e.date)) [credits, charges] = e.amount_minor > 0 ? [credits + e.amount_minor, charges] : [credits, charges - e.amount_minor]
            }
            for (const l of w.lines) {
              if (l.account_id !== cardId || l.kind !== 'payment' || !inCycle(l.date)) continue
              credits += l.amount_minor
              seen.payments++
            }
            const through = prev.source === 'entered' && slotCut(card.terms.cut_day, prev.cut_date) > prev.cut_date ? slotCut(card.terms.cut_day, prev.cut_date) : prev.cut_date
            const billed = installments.filter((o) => o.date > through && o.date <= s.cut_date).reduce((sum, o) => sum + o.amount_minor, 0)
            const interest = 0 - (w.lines.find((l) => l.id === `interest:${cardId}:${s.cut_date}`)?.amount_minor ?? 0)
            expect([s.id, m.payments_and_credits_minor, m.charges_minor, m.installments_minor, m.interest_minor]).toEqual([s.id, credits, charges, billed, interest])
            expect([s.id, s.total_due_minor]).toEqual([s.id, prev.total_due_minor - credits + charges + billed + interest])
            seen.statements++
            if (interest > 0) seen.interest++
            if (billed > 0) seen.installments++
            if (charges > 0) seen.charges++
          })
        }
      }),
      RUNS,
    )
    expect(Object.entries(seen).filter(([, n]) => n < 100)).toEqual([])
  }, LONG)

  it('lowers the funded-from account by exactly X per period for a transfer item of X into a debt', () => {
    const seen = { card: 0, loan: 0, partly: 0, cleared: 0 }
    fc.assert(
      fc.property(householdCase, (c) => {
        const built = buildCase(c)
        const item = built.debtItem
        const B = walked(built.snapshot, built.options)
        requireContents(built, B)
        // Periods before the horizon's last month, so a card's payment for them falls inside the walk.
        const periods = expandPlan(built.snapshot).occurrences.filter((o) => o.plan_item_id === item.id && !o.skipped && o.date >= B.as_of && o.scheduled_on.slice(0, 7) < B.horizon_end.slice(0, 7))
        const target = periods[c.period % periods.length]
        if (!target) throw new Error(`The debt item has no period in the horizon as of ${B.as_of}`)
        // The same household without that one period.
        const docA = copy(built.doc)
        for (const p of docA.plan_items) if (p.id === item.id) p.skip_periods = [target.period]
        const A = walked(buildSnapshot(docA, built.asOf, built.snapshot.rates), built.options)

        const paid = (w: Walk, id: string) => 0 - (w.lines.find((l) => l.id === id)?.amount_minor ?? 0)
        const move = B.lines.find((l) => l.account_id === item.funder_id && (l.source === 'card' || l.source === 'loan') && l.amount_minor < 0 && l.occurrence_ids.includes(target.id))
        const more = move ? paid(B, move.id) - paid(A, move.id) : 0
        // Whatever the debt takes of the period, never more than X.
        expect([target.id, more >= 0 && more <= item.amount_minor]).toEqual([target.id, true])
        const debt = accountIn(built.snapshot, item.debt_id)
        if (!move) {
          // Nothing took the period because the debt had nothing left to take.
          if (debt.kind === 'credit_card') {
            const s = cardsOf(B)?.get(debt.id)?.statements.find((st) => st.payment !== null && st.cut_date.slice(0, 7) === target.scheduled_on.slice(0, 7))
            expect([target.id, s?.payment?.left_to_pay_minor]).toEqual([target.id, 0])
          } else {
            const payoff = loansOf(B)?.get(debt.id)?.payoff
            expect([target.id, payoff?.on != null && payoff.on <= target.date]).toEqual([target.id, true])
          }
          seen.cleared++
          return
        }

        // The debt can take all of it: a card whose planned gross stays under what it owes, or a loan still owed after the move.
        const takes = (): boolean => {
          if (debt.kind === 'credit_card') {
            const cut = move.id.match(/^payment:[^:]+:(\d{4}-\d{2}-\d{2})#out$/)?.[1]
            const figures = cardsOf(B)?.get(debt.id)?.statements.find((s) => s.cut_date === cut)?.payment
            return !!figures && figures.planned_gross_minor < figures.cap_minor && paid(B, move.id) >= item.amount_minor
          }
          const payoff = loansOf(B)?.get(debt.id)?.payoff
          return !!payoff && (payoff.after_horizon || (payoff.on !== null && payoff.on > move.date))
        }
        if (!takes()) {
          seen.partly++
          return
        }
        expect([target.id, more]).toEqual([target.id, item.amount_minor])
        // On the funded-from account, net of top-ups, nothing differs before the move, and exactly X from it until the debt's next payment.
        const moves = debt.kind === 'credit_card' ? (cardsOf(B)?.get(debt.id)?.moves ?? []) : (loansOf(B)?.get(debt.id)?.moves ?? [])
        const next = moves.find((m) => m.from_account_id !== null && m.date > move.date)?.date ?? addDays(B.horizon_end, 1)
        // The funded-from account's end-of-day balance less the top-ups it sent or took so far.
        const own = (w: Walk) => {
          const balances = w.balances.get(item.funder_id) ?? new Float64Array()
          const topUps = new Float64Array(w.days.length)
          for (const l of w.lines) {
            const i = daysBetween(w.as_of, l.date)
            if (l.account_id === item.funder_id && l.source === 'top_up') topUps[i] = (topUps[i] ?? 0) + l.amount_minor
          }
          let sum = 0
          return balances.map((b, i) => b - (sum += topUps[i] ?? 0))
        }
        const [ownA, ownB] = [own(A), own(B)]
        for (let i = 0; i < B.days.length && (B.days[i] ?? '') < next; i++) {
          const want = (B.days[i] ?? '') < move.date ? 0 : -item.amount_minor
          if ((ownB[i] ?? 0) - (ownA[i] ?? 0) !== want) expect([target.id, B.days[i], (ownB[i] ?? 0) - (ownA[i] ?? 0)]).toEqual([target.id, B.days[i], want])
        }
        seen[debt.kind === 'credit_card' ? 'card' : 'loan']++
      }),
      RUNS,
    )
    // Most periods are fully taken, by cards and by loans alike.
    expect([seen.card > 200, seen.loan > 100, seen.card + seen.loan > 0.6 * RUNS.numRuns]).toEqual([true, true, true])
  }, LONG)

  it('changes nothing when a plan item starts earlier, before track_from', () => {
    const moved = new Map<string, number>()
    fc.assert(
      fc.property(householdCase, (c) => {
        const { built, w } = baseline(c)
        const trackFrom = built.snapshot.doc.household.track_from
        // Items whose period before their start already falls before track_from, so every period added is one the engine ignores.
        const candidates = built.snapshot.doc.plan_items.filter((p) => {
          const before = periodBefore(p)
          return before !== null && (p.kind === 'allowance' ? lastDayOfMonth(before) : before) < trackFrom
        })
        const item = candidates[c.pick % candidates.length]
        if (!item) throw new Error(`No plan item starts within a period of track_from in ${built.fixture} as of ${built.asOf}`)
        const starts = periodsBack(item, c.back)
        if (starts === null) throw new Error(`Plan item '${item.id}' has no schedule to move back on`)
        const doc = copy(built.doc)
        for (const p of doc.plan_items) if (p.id === item.id) p.starts_on = starts
        const earlier = buildSnapshot(doc, built.asOf, built.snapshot.rates)
        const after = walked(earlier, built.options)
        expectSame(after, w)
        expect(walkMetrics(earlier, after)).toEqual(walkMetrics(built.snapshot, w))
        moved.set(item.kind, (moved.get(item.kind) ?? 0) + 1)
      }),
      RUNS,
    )
    expect([...moved.keys()].sort()).toEqual(['allowance', 'bill', 'income', 'installment', 'transfer'])
    expect([...moved.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0.9 * RUNS.numRuns)
  }, LONG)

  it('gives the same output for the same input', () => {
    fc.assert(
      fc.property(householdCase, (c) => {
        const [first, again] = [buildCase(c), buildCase(JSON.parse(JSON.stringify(c)))]
        const [w1, w2] = [walked(first.snapshot, first.options), walked(again.snapshot, again.options)]
        requireContents(first, w1)
        expectSame(again.snapshot, first.snapshot)
        expectSame(w2, w1)
        expect(walkMetrics(again.snapshot, w2)).toEqual(walkMetrics(first.snapshot, w1))
      }),
      RUNS,
    )
  }, LONG)

  it('fails loudly on a case with no transfer, card cycle, floor or carry', () => {
    const asOf = '2026-10-07'
    const { doc, rates } = mortgage(asOf)
    const snapshot = buildSnapshot(doc, asOf, rates)
    const w = walked(snapshot, { cards: CARDS, loans: LOANS })
    expect(() => requireContents({ fixture: 'mortgage', asOf, snapshot }, w)).toThrow('Vacuous case: mortgage as of 2026-10-07 has no transfer, no card cycle, no floor, no carry')
    // The varied mortgage case has all four.
    const sample = fc.sample(householdCase, { numRuns: 50, seed: RUNS.seed }).find((c) => c.fixture === 'mortgage')
    if (!sample) throw new Error('No mortgage case in the first 50')
    const built = buildCase(sample)
    expect(() => requireContents(built, walked(built.snapshot, built.options))).not.toThrow()
  })
})
