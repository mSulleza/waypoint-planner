import { describe, expect, it } from 'vitest'
import { abroad, usCardsCar, type Sample, type SampleDoc } from '../fixtures'
import type { PlanItemInput } from '../fixtures/relative'
import {
  amountLever,
  dayLever,
  decodeLevers,
  encodeLevers,
  endLever,
  extraPaymentLever,
  floorWindowLever,
  fxShiftLever,
  incomeGapLever,
  itemLevers,
  loanOfferLever,
  registry,
  removeLever,
  upsideLever,
} from '../src/compare-levers'
import { CARDS, cardsOf } from '../src/engine/cards'
import { expandPlan } from '../src/engine/events'
import { LOANS } from '../src/engine/loans'
import { walkMetrics, type WalkMetrics } from '../src/engine/metrics'
import type { Walk } from '../src/engine/types'
import { applyPatch, combinePatches, type Lever, type PatchedWorld } from '../src/levers'
import { addOnInstallment, fxTerms, netOf } from '../src/money'
import { toRatesPerEur } from '../src/rates'
import type { PlanItem } from '../src/schema/rows'
import { buildSnapshot, snapshotIndex, type Snapshot } from '../src/snapshot'
import { walked } from './walk-helpers'

const AS_OF = '2026-10-07'
const PATCH_KEYS = 'allowed keys: fx_shift_pct, items, add, accounts, income_gap'

function build(sample: (asOf: string) => Sample, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = sample(AS_OF)
  edit?.(doc)
  return buildSnapshot(doc, AS_OF, rates)
}

function world(snapshot: Snapshot, patch: unknown): PatchedWorld {
  const applied = applyPatch(snapshot, patch)
  if (!applied.ok) throw new Error(`The patch did not apply: ${applied.errors.join('; ')}`)
  return applied.value
}

function measured(w: PatchedWorld, mode: 'full' | 'metrics' = 'metrics'): { walk: Walk; metrics: WalkMetrics } {
  const result = walked(w.snapshot, { ...w.options, mode })
  return { walk: result, metrics: walkMetrics(w.snapshot, result) }
}

const baseline = (snapshot: Snapshot, mode: 'full' | 'metrics' = 'metrics') => measured(world(snapshot, {}), mode)

const cash = (m: WalkMetrics, id: string) => {
  const found = m.cash.find((c) => c.account_id === id)
  if (!found) throw new Error(`No cash metrics for '${id}'`)
  return found
}

// ASCII text as base64url, apart from the code under test, for links encodeLevers would refuse to make.
function base64url(ascii: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let bits = ''
  for (const ch of ascii) bits += ch.charCodeAt(0).toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 6) out += alphabet[parseInt(bits.slice(i, i + 6).padEnd(6, '0'), 2)]
  return out
}

const itemsOf = (snapshot: Snapshot, prefix: string): PlanItem[] => snapshot.doc.plan_items.filter((p) => p.id === prefix || p.id.startsWith(`${prefix}@`))

describe('applyPatch', () => {
  it('reproduces the baseline under an empty patch, and a lever set to its current value moves nothing', () => {
    const snapshot = build(abroad)
    const base = baseline(snapshot, 'full')
    for (const form of [undefined, '{}', {}, { patch: {} }, { fx_shift_pct: 0 }]) {
      const w = world(snapshot, form)
      expect([w.snapshot === snapshot, w.options]).toEqual([true, { fx_shift_pct: 0, cards: CARDS, loans: LOANS }])
      expect(measured(w, 'full')).toEqual(base)
    }
    expect(world(snapshot, { items: { rent: { include_upside: false } } }).snapshot === snapshot).toBe(true)
    // Rent at its own 900.00 and salary on its own 28th, both from next month: each item is split in two, and every balance and metric stays.
    const same = world(snapshot, { items: { rent: { amount_minor: 90000, from_month: '2026-11' }, salary: { day: 28, from_month: '2026-11' } } })
    expect([itemsOf(same.snapshot, 'rent').map((p) => [p.id, p.starts_on, p.ends_on, p.amount_minor]), itemsOf(same.snapshot, 'salary').map((p) => [p.id, p.starts_on, p.ends_on])]).toEqual([
      [
        ['rent', '2026-09-01', '2026-10-31', 90000],
        ['rent@2026-11', '2026-11-01', null, 90000],
      ],
      [
        ['salary', '2026-09-28', '2026-10-31'],
        ['salary@2026-11', '2026-11-28', null],
      ],
    ])
    const moved = measured(same)
    expect([moved.walk.balances, moved.walk.figures, moved.metrics]).toEqual([base.walk.balances, base.walk.figures, base.metrics])
  })

  it('rejects an unknown key with the allowed keys, and collects every error in the patch at once', () => {
    const snapshot = build(abroad)
    expect(applyPatch(snapshot, { fx_rate: 0.9 })).toEqual({ ok: false, errors: [`(root): Unknown key 'fx_rate'; ${PATCH_KEYS}`] })
    expect(applyPatch(snapshot, { items: { rent: { amount: 95000 } } })).toEqual({
      ok: false,
      errors: ["items.rent: Unknown key 'amount'; allowed keys: amount_minor, day, from_month, ends_on, removed, include_upside"],
    })
    expect(applyPatch(snapshot, '{"items": ')).toEqual({ ok: false, errors: [expect.stringMatching(/^bad_json: /)] })
    const rent = snapshotIndex(snapshot).planItems.get('rent')
    expect(
      applyPatch(snapshot, {
        items: { renta: { amount_minor: 95000, from_month: '2026-11' }, salary: { include_upside: true }, groceries: { day: 3, from_month: '2026-11' }, receivable: { amount_minor: 500000, from_month: '2026-12' }, rent: { amount_minor: -5000, from_month: '2026-11' } },
        accounts: { 'rewards-card': { floor_windows: [] }, nowhere: { floor_windows: [] } },
        income_gap: { from_month: '2026-11', months: 2, item_ids: ['rent', 'nobody'] },
        add: [rent],
      }),
    ).toEqual({
      ok: false,
      errors: [
        "add[0].id: plan item 'rent' already exists",
        "items.renta: no plan item 'renta'",
        "items.salary.include_upside: 'salary' is not an upside item",
        'items.groceries.day: day moves an item that happens once or repeats monthly, every 3 months or yearly; an installment bills at the cut, an allowance spreads over its month and a weekly item keeps its weekday',
        "items.receivable.from_month: 'receivable' happens once, on 2026-10-17, before 2026-12",
        'items.rent.amount_minor: must be more than 0; only an allowance may be negative',
        "accounts.rewards-card.floor_windows: floor windows are for cash accounts only, and 'rewards-card' is a card",
        "accounts.nowhere: no account 'nowhere'",
        "income_gap.item_ids: 'rent' is a plan item of kind bill, not income",
        "income_gap.item_ids: no plan item 'nobody'",
      ],
    })
    // A patch that leaves a row the database would refuse names the row by id.
    expect(applyPatch(snapshot, { items: { mobile: { ends_on: '2026-08-31' } } })).toEqual({ ok: false, errors: ["plan_items['mobile'].ends_on: must not be before starts_on"] })
  })

  it('raises the rent by 50.00 from this month and lowers the lowest Pesos balance by what that 50.00 would have topped up', () => {
    const snapshot = build(abroad)
    const base = baseline(snapshot)
    const w = world(snapshot, amountLever(snapshot, 'rent', 95000, '2026-10').patch)
    // October's 900.00 is already paid and linked; it moves to the copy, which still expects 50.00 and posts it on as_of as overdue.
    expect(itemsOf(w.snapshot, 'rent').map((p) => [p.id, p.starts_on, p.ends_on, p.amount_minor])).toEqual([
      ['rent', '2026-09-01', '2026-09-30', 90000],
      ['rent@2026-10', '2026-10-01', null, 95000],
    ])
    expect(w.snapshot.doc.transactions.find((t) => t.id === 'rent-now')).toMatchObject({ plan_item_id: 'rent@2026-10', period: '2026-10-01', amount_minor: -90000 })
    const october = expandPlan(w.snapshot).byId.get('rent@2026-10:2026-10-01')
    expect([october?.state, october?.open_minor]).toEqual(['overdue', 5000])

    const after = measured(w)
    const { rate, feePct } = fxTerms('EUR', 'PHP', toRatesPerEur(snapshot.rates), 0.007) ?? { rate: 0, feePct: 0 }
    // Main sits at its floor-limited low either way, so the 50.00 comes out of the top-up Pesos gets on its lowest day.
    expect([cash(base.metrics, 'main').lowest_minor, cash(after.metrics, 'main').lowest_minor]).toEqual([591200, 591200])
    expect([cash(base.metrics, 'pesos').lowest_minor, cash(after.metrics, 'pesos').lowest_minor, cash(after.metrics, 'pesos').lowest_on]).toEqual([801870, 801870 - netOf(5000, rate, feePct), '2026-10-22'])
    expect(netOf(5000, rate, feePct)).toBe(347550)
  })

  it('moves the salary from the 28th to the 20th from this month and cuts the days under floor', () => {
    const snapshot = build(abroad)
    const base = baseline(snapshot)
    const w = world(snapshot, dayLever(snapshot, 'salary', 20, '2026-10').patch)
    expect(itemsOf(w.snapshot, 'salary').map((p) => [p.id, p.starts_on, p.ends_on, p.amount_minor])).toEqual([
      ['salary', '2026-09-28', '2026-09-30', 400000],
      ['salary@2026-10', '2026-10-20', null, 400000],
    ])
    const after = measured(w)
    const days = (m: WalkMetrics) => m.cash.map((c) => [c.account_id, c.days_under_floor])
    expect([days(base.metrics), days(after.metrics)]).toEqual([
      [
        ['main', 11],
        ['pesos', 12],
        ['tax', 0],
      ],
      [
        ['main', 3],
        ['pesos', 4],
        ['tax', 0],
      ],
    ])
  })

  it('tries a loan offer: a draw before the store card cut lowers its interest, and the travel card bills the installment for the term', () => {
    const snapshot = build(usCardsCar)
    const lever = loanOfferLever(snapshot, { amount_minor: 400000, term_months: 12, monthly_rate: 0.01, draw_month: '2026-11', draw_day: 10, to_account_id: 'store-card', card_id: 'travel-card' })
    // 4,000.00 × (1 + 1% × 12) ÷ 12 = 373.333…, rounded half up.
    expect([addOnInstallment(400000, 0.01, 12), addOnInstallment(100000, 0.0097, 36), addOnInstallment(5, 0.1, 2)]).toEqual([37333, 3748, 3])
    expect(lever.patch.add?.map((p) => [p.kind, p.from_account_id, p.to_account_id, p.amount_minor, p.every, p.starts_on, p.ends_on])).toEqual([
      ['income', null, 'store-card', 400000, 'once', '2026-11-10', null],
      ['installment', 'travel-card', null, 37333, 'month', '2026-11-01', '2027-10-01'],
    ])
    expect(lever.label).toBe('Loan offer $4,000.00 over 12 months at 1% a month ($373.33 a month), into Store card on Nov 10, 2026')
    const base = measured(world(snapshot, {}), 'full')
    const offer = measured(world(snapshot, lever.patch), 'full')
    const interest = (m: WalkMetrics, id: string) => m.interest.find((d) => d.account_id === id)?.interest_to_horizon_minor
    expect([interest(base.metrics, 'store-card'), interest(offer.metrics, 'store-card')]).toEqual([95034, 17811])
    const cuts = (w: Walk, id: string) => (cardsOf(w)?.get(id)?.statements ?? []).filter((s) => s.cut_date > AS_OF && s.cut_date < '2027-12-01')
    // The draw lands on 10 Nov, before the 24 Nov cut, so that statement drops by the 4,000.00.
    const storeNovember = (w: Walk) => cuts(w, 'store-card').find((s) => s.cut_date === '2026-11-24')?.total_due_minor ?? 0
    expect(storeNovember(base.walk) - storeNovember(offer.walk)).toBeGreaterThan(400000 - 10000)
    const billed = (w: Walk) => cuts(w, 'travel-card').map((s) => [s.cut_date, s.installments_minor])
    expect(billed(base.walk).every(([, n]) => n === 0)).toBe(true)
    expect(billed(offer.walk)).toEqual([
      ['2026-10-20', 0],
      ...['11', '12'].map((m) => [`2026-${m}-20`, 37333]),
      ...['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map((m) => [`2027-${m}-20`, 37333]),
      ['2027-11-20', 0],
    ])
    // The bank's own EMI replaces the formula, and the same choice always adds the same ids.
    const bank = loanOfferLever(snapshot, { amount_minor: 400000, term_months: 12, monthly_rate: 0.01, draw_month: '2026-11', draw_day: 10, to_account_id: 'store-card', card_id: 'travel-card', emi_minor: 37500 })
    expect([bank.patch.add?.[1]?.amount_minor, lever.patch.add?.map((p) => p.id)]).toEqual([37500, loanOfferLever(snapshot, { amount_minor: 400000, term_months: 12, monthly_rate: 0.01, draw_month: '2026-11', draw_day: 10, to_account_id: 'store-card', card_id: 'travel-card' }).patch.add?.map((p) => p.id)])
    expect(() => loanOfferLever(build(abroad), { amount_minor: 0, term_months: 0, monthly_rate: 1, draw_month: '2026-11', to_account_id: 'main', card_id: 'rewards-card' })).toThrow(
      "to_account_id: 'main' holds EUR, but 'rewards-card' lends PHP; amount_minor: must be a whole number of minor units above 0; term_months: must be a whole number of months above 0; monthly_rate: must be a fraction from 0 to below 1, such as 0.01 for 1% a month",
    )
    // A draw month that already started lands today rather than as an unconfirmed inflow.
    expect(loanOfferLever(snapshot, { amount_minor: 100000, term_months: 6, monthly_rate: 0.01, draw_month: '2026-10', to_account_id: 'checking', card_id: 'store-card' }).patch.add?.map((p) => p.starts_on)).toEqual(['2026-10-07', '2026-10-01'])
  })

  it('shows the patched amounts in the line items, and the lines add up to the patched balances', () => {
    const snapshot = build(abroad)
    const w = world(snapshot, { items: { rent: { amount_minor: 95000, from_month: '2026-11' } }, fx_shift_pct: -0.1 })
    const { walk } = measured(w, 'full')
    const rent = walk.lines.filter((l) => l.occurrence_ids.some((id) => id.startsWith('rent')))
    expect(rent.map((l) => [l.date, l.amount_minor]).slice(0, 3)).toEqual([
      ['2026-11-02', -95000],
      ['2026-12-01', -95000],
      ['2027-01-01', -95000],
    ])
    // Each top-up lands at the shifted rate, 70 × 0.9 pesos per euro less the 0.7% fee.
    const shifted = fxTerms('EUR', 'PHP', walk.rates, 0.007)
    expect([walk.rates.PHP, shifted?.rate]).toEqual([63, 63])
    const tops = walk.lines.filter((l) => l.source === 'top_up' && l.amount_minor < 0)
    expect(tops.length).toBeGreaterThan(10)
    for (const out of tops) expect([out.id, walk.lines.find((l) => l.id === out.pair_id)?.amount_minor]).toEqual([out.id, netOf(-out.amount_minor, 63, 0.007)])
    for (const a of w.snapshot.doc.accounts.filter((x) => x.kind === 'cash')) {
      const sum = walk.lines.filter((l) => l.account_id === a.id).reduce((s, l) => s + l.amount_minor, 0)
      expect([a.id, (walk.start.get(a.id) ?? 0) + sum]).toEqual([a.id, walk.balances.get(a.id)?.[walk.days.length - 1]])
    }
  })

  it('ends, removes and includes items, keeps every posted row, and stops a split income item through its copy', () => {
    const snapshot = build(abroad)
    const base = measured(world(snapshot, {}), 'full')
    // Removing the mobile plan unlinks last month's paid bill; the row and its money stay.
    const removed = world(snapshot, removeLever(snapshot, 'mobile').patch)
    expect([removed.snapshot.doc.plan_items.some((p) => p.id === 'mobile'), removed.snapshot.doc.transactions.find((t) => t.id === 'mobile-last')]).toEqual([false, expect.objectContaining({ amount_minor: -120000, plan_item_id: null, period: null })])
    expect(measured(removed).walk.start).toEqual(base.walk.start)

    const ended = world(snapshot, endLever(snapshot, 'insurance', '2026-12-31').patch)
    const insurance = expandPlan(ended.snapshot).occurrences.filter((o) => o.plan_item_id === 'insurance' && o.date >= AS_OF)
    expect(insurance.map((o) => o.date)).toEqual(['2026-10-22', '2026-11-22', '2026-12-22'])

    // The camera sale counts once included, and its line says it is an estimate.
    const included = measured(world(snapshot, upsideLever(snapshot, 'camera-sale').patch), 'full')
    const sale = included.walk.lines.find((l) => l.occurrence_ids.includes('camera-sale:2026-11-01'))
    expect([sale?.amount_minor, sale?.flags, base.walk.lines.some((l) => l.occurrence_ids.includes('camera-sale:2026-11-01'))]).toEqual([1500000, ['estimated'], false])

    // Salary moved to the 20th from November and stopped for November and December: neither the old row nor its copy pays in the gap.
    const gapped = world(snapshot, { items: { salary: { day: 20, from_month: '2026-11' } }, income_gap: { from_month: '2026-11', months: 2, item_ids: ['salary'] } })
    const paid = expandPlan(gapped.snapshot).occurrences.filter((o) => o.plan_item_id.startsWith('salary') && o.date > AS_OF && o.date < '2027-02-01')
    expect(paid.map((o) => [o.id, o.skipped])).toEqual([
      ['salary:2026-10-01', false],
      ['salary@2026-11:2026-11-01', true],
      ['salary@2026-11:2026-12-01', true],
      ['salary@2026-11:2027-01-01', false],
    ])
    expect(gapped.options.cards === CARDS).toBe(false)
  })

  it('splits from a month the way split_plan_item does, and changes the whole item when the month reaches its start', () => {
    const snapshot = build(abroad, (doc) => {
      const gym: PlanItemInput = { id: 'gym', kind: 'bill', name: 'Gym', from_account_id: 'main', amount_minor: 4000, starts_on: '2026-01-31', skip_periods: ['2026-12-01', '2027-03-01'] }
      const weekly: PlanItemInput = { id: 'cleaner', kind: 'bill', name: 'Cleaner', from_account_id: 'main', amount_minor: 3000, every: '2weeks', starts_on: '2026-09-03' }
      doc.plan_items.push(gym, weekly)
    })
    // An installment keeps first-of-month dates on both rows; the old row ends with the month before.
    const laptop = world(snapshot, { items: { laptop: { amount_minor: 450000, from_month: '2027-01' } } })
    expect(itemsOf(laptop.snapshot, 'laptop').map((p) => [p.starts_on, p.ends_on, p.amount_minor])).toEqual([
      ['2026-06-01', '2026-12-01', 500000],
      ['2027-01-01', '2027-05-01', 450000],
    ])
    // A 31st counts from starts_on, so the copy starts on the last day of a short month and keeps that day; later skips move to it.
    const gym = world(snapshot, { items: { gym: { amount_minor: 4500, from_month: '2027-02' } } })
    expect(itemsOf(gym.snapshot, 'gym').map((p) => [p.starts_on, p.ends_on, p.skip_periods])).toEqual([
      ['2026-01-31', '2027-01-31', ['2026-12-01']],
      ['2027-02-28', null, ['2027-03-01']],
    ])
    const dayMoved = world(snapshot, { items: { gym: { day: 15, from_month: '2026-11' } } })
    expect(itemsOf(dayMoved.snapshot, 'gym').map((p) => p.starts_on)).toEqual(['2026-01-31', '2026-11-15'])
    // A two-weekly item continues its cadence from the first occurrence on or after the month.
    const cleaner = world(snapshot, { items: { cleaner: { amount_minor: 3500, from_month: '2026-11' } } })
    expect(itemsOf(cleaner.snapshot, 'cleaner').map((p) => [p.starts_on, p.ends_on])).toEqual([
      ['2026-09-03', '2026-10-31'],
      ['2026-11-12', null],
    ])
    // From its first month on, the change is the item itself, as is any change to a one-off.
    const whole = world(snapshot, { items: { rent: { amount_minor: 95000, from_month: '2026-09' }, receivable: { amount_minor: 500000, day: 20, from_month: '2026-10' } } })
    expect([itemsOf(whole.snapshot, 'rent').map((p) => [p.id, p.starts_on, p.amount_minor]), itemsOf(whole.snapshot, 'receivable').map((p) => [p.starts_on, p.amount_minor])]).toEqual([
      [['rent', '2026-09-01', 95000]],
      [['2026-10-20', 500000]],
    ])
    // A quarterly item split inside its quarter starts the copy at its next occurrence, with the later skip; the day can move too.
    const quarterly = build(abroad, (doc) => {
      doc.plan_items.push({ id: 'fee', kind: 'bill', name: 'Accountant', from_account_id: 'pesos', amount_minor: 450000, every: 'quarter', starts_on: '2026-10-15', skip_periods: ['2027-07-01'] })
    })
    const fee = world(quarterly, { items: { fee: { amount_minor: 500000, from_month: '2026-11' } } })
    expect(itemsOf(fee.snapshot, 'fee').map((p) => [p.starts_on, p.ends_on, p.amount_minor, p.skip_periods])).toEqual([
      ['2026-10-15', '2026-10-31', 450000, []],
      ['2027-01-15', null, 500000, ['2027-07-01']],
    ])
    expect(expandPlan(fee.snapshot).occurrences.filter((o) => o.plan_item_id.startsWith('fee')).slice(0, 4).map((o) => [o.id, o.amount_minor, o.skipped])).toEqual([
      ['fee:2026-10-01', 450000, false],
      ['fee@2026-11:2027-01-01', 500000, false],
      ['fee@2026-11:2027-04-01', 500000, false],
      ['fee@2026-11:2027-07-01', 500000, true],
    ])
    expect(itemsOf(world(quarterly, { items: { fee: { day: 20, from_month: '2027-02' } } }).snapshot, 'fee').map((p) => p.starts_on)).toEqual(['2026-10-15', '2027-04-20'])
    // Ending the copy before a skipped month would strand that skip, so the split is refused, as the database refuses it.
    expect(applyPatch(snapshot, { items: { gym: { amount_minor: 4500, from_month: '2027-02', ends_on: '2027-02-28' } } })).toEqual({
      ok: false,
      errors: ['items.gym: the occurrence 2027-03-01 is linked or skipped, and the changed item has no occurrence to take it'],
    })
    expect(applyPatch(snapshot, { items: { laptop: { amount_minor: 450000, from_month: '2027-06' }, cleaner: { day: 5, from_month: '2026-11' } } })).toEqual({
      ok: false,
      errors: [
        "items.laptop.from_month: 'laptop' ends 2027-05-01, before 2027-06",
        'items.cleaner.day: day moves an item that happens once or repeats monthly, every 3 months or yearly; an installment bills at the cut, an allowance spreads over its month and a weekly item keeps its weekday',
      ],
    })
  })

  it('adds an extra payment as extra for debts or into one debt, and changes a floor window', () => {
    const snapshot = build(usCardsCar)
    const extra = extraPaymentLever(snapshot, { amount_minor: 20000, every: 'month', starts_on: '2026-11-01', from_account_id: 'checking' })
    const into = extraPaymentLever(snapshot, { amount_minor: 50000, every: 'once', starts_on: '2026-11-15', to_debt_id: 'car-loan' })
    expect([extra.label, into.label]).toEqual(['Extra for debts from Checking: $200.00 a month from Nov 2026', 'Extra into Car loan: $500.00 on Nov 15, 2026'])
    expect([extra.patch.add?.[0], into.patch.add?.[0]]).toEqual([
      expect.objectContaining({ kind: 'transfer', from_account_id: 'checking', to_account_id: null, every: 'month', starts_on: '2026-11-01' }),
      expect.objectContaining({ kind: 'transfer', from_account_id: null, to_account_id: 'car-loan', every: 'once', starts_on: '2026-11-15' }),
    ])
    expect(() => extraPaymentLever(snapshot, { amount_minor: 0, every: 'once', starts_on: '2026-11-15', from_account_id: 'checking', to_debt_id: 'car-loan' })).toThrow(
      'name either from_account_id (extra for debts) or to_debt_id (one debt); amount_minor: must be a whole number of minor units above 0',
    )
    const base = baseline(snapshot)
    const paid = measured(world(snapshot, into.patch))
    const car = (m: WalkMetrics) => m.interest.find((d) => d.account_id === 'car-loan')?.interest_to_horizon_minor ?? 0
    expect(car(paid.metrics)).toBeLessThan(car(base.metrics))

    // Main's floor down from 6,000.00 to 3,000.00 this month frees it to top up Pesos, and no day ends under either floor.
    const abroadSnapshot = build(abroad)
    const floor = floorWindowLever(abroadSnapshot, 'main', [{ from_month: '2026-10', to_month: null, amount_minor: 300000 }])
    expect(floor.label).toBe('Main floor: €3,000.00 from Oct 2026')
    const days = (m: WalkMetrics) => m.cash.map((c) => c.days_under_floor)
    expect([days(baseline(abroadSnapshot).metrics), days(measured(world(abroadSnapshot, floor.patch)).metrics)]).toEqual([
      [11, 12, 0],
      [0, 0, 0],
    ])
  })

  it('combines levers into one patch, and refuses two levers that set one key differently', () => {
    const snapshot = build(abroad)
    const rent = amountLever(snapshot, 'rent', 95000, '2026-11')
    const end = endLever(snapshot, 'rent', '2027-06-30')
    const fx = fxShiftLever(snapshot, -0.1)
    expect(combinePatches([rent.patch, end.patch, fx.patch])).toEqual({ ok: true, value: { fx_shift_pct: -0.1, items: { rent: { amount_minor: 95000, from_month: '2026-11', ends_on: '2027-06-30' } } } })
    expect(combinePatches([rent.patch, amountLever(snapshot, 'rent', 99000, '2026-11').patch, fx.patch, fxShiftLever(snapshot, 0.05).patch, removeLever(snapshot, 'rent').patch])).toEqual({
      ok: false,
      errors: ['items.rent.amount_minor: more than one lever sets it differently; try them as one lever', 'fx_shift_pct: more than one lever sets it differently; try them as one lever'],
    })
    expect(combinePatches([rent.patch, removeLever(snapshot, 'rent').patch])).toEqual({ ok: false, errors: ['items.rent.removed: a removed item takes no other change'] })
    expect(combinePatches([{ fx: 1 }, '{'])).toEqual({ ok: false, errors: [`levers[0]: (root): Unknown key 'fx'; ${PATCH_KEYS}`, expect.stringMatching(/^levers\[1\]: bad_json: /)] })
  })

  it('offers levers only for items with something left to decide', () => {
    const snapshot = build(abroad, (doc) => {
      doc.plan_items.push({ id: 'old-phone', kind: 'bill', name: 'Old phone plan', from_account_id: 'pesos', amount_minor: 90000, starts_on: '2026-06-12', ends_on: '2026-08-31' })
    })
    const r = registry(snapshot)
    const listed = r.items.map((i) => i.item_id)
    // The phone plan ended before the tracked months, so nothing is left to decide; this month's groceries credit still nets, and the camera sale is an upside to include.
    expect([listed.includes('old-phone'), listed.includes('groceries-credit'), listed.includes('rent')]).toEqual([false, true, true])
    expect([itemLevers(snapshot, 'old-phone'), itemLevers(snapshot, 'nobody'), itemLevers(snapshot, 'rent')?.levers]).toEqual([null, null, ['amount', 'day', 'end', 'remove']])
    expect(r.items.find((i) => i.item_id === 'camera-sale')).toMatchObject({ upside: true, levers: ['include_upside'], first_month: '2026-11' })
    expect(r.items.find((i) => i.item_id === 'salary')).toMatchObject({ day: 28, currency: 'EUR', first_month: '2026-10', levers: ['amount', 'day', 'end', 'remove'] })
    expect(r.items.find((i) => i.item_id === 'laptop')).toMatchObject({ day: null, levers: ['amount', 'end', 'remove'] })
    expect([r.fx_shift, r.income_gap, r.extra_payment, r.loan_offer, r.floor_windows.map((f) => f.account_id)]).toEqual([
      { funding_currency: 'EUR' },
      { item_ids: ['cash-loan-draw', 'receivable', 'salary'], first_month: '2026-10' },
      { from_account_ids: ['pesos'], debt_ids: ['rewards-card', 'shopping-card'] },
      { card_ids: ['rewards-card', 'shopping-card'], to_account_ids: ['main', 'tax', 'pesos', 'rewards-card', 'shopping-card'] },
      ['main', 'tax', 'pesos'],
    ])
  })
})

describe('one-off items left open from an earlier month', () => {
  it('offers late income and an overdue bill from September with their own month, so an amount change applies in place', () => {
    const snapshot = build(abroad, (doc) => {
      doc.plan_items.push(
        { id: 'deposit-back', kind: 'income', name: 'Deposit back', to_account_id: 'main', amount_minor: 80000, every: 'once', starts_on: '2026-09-21' },
        { id: 'old-bill', kind: 'bill', name: 'Old bill', from_account_id: 'main', amount_minor: 8000, every: 'once', starts_on: '2026-09-21' },
      )
    })
    const r = registry(snapshot)
    expect(['deposit-back', 'old-bill'].map((id) => [id, r.items.find((i) => i.item_id === id)?.first_month])).toEqual([
      ['deposit-back', '2026-09'],
      ['old-bill', '2026-09'],
    ])
    const patched = applyPatch(snapshot, amountLever(snapshot, 'deposit-back', 50000, '2026-09').patch)
    if (!patched.ok) throw new Error(patched.errors.join('; '))
    const late = expandPlan(patched.value.snapshot).byId.get('deposit-back:2026-09-01')
    expect([late?.state, late?.open_minor, late?.carried_to]).toEqual(['late', 50000, '2026-11-01'])
  })
})

describe('lever links', () => {
  it('encodes levers as base64url for the URL fragment and decodes them back', () => {
    const snapshot = build(abroad)
    const levers: Lever[] = [
      amountLever(snapshot, 'rent', 95000, '2026-11'),
      dayLever(snapshot, 'salary', 20, '2026-11'),
      endLever(snapshot, 'insurance', null),
      upsideLever(snapshot, 'camera-sale'),
      extraPaymentLever(snapshot, { amount_minor: 500000, every: 'month', starts_on: '2026-11-01', from_account_id: 'pesos' }),
      loanOfferLever(snapshot, { amount_minor: 5000000, term_months: 12, monthly_rate: 0.0125, draw_month: '2026-11', draw_day: 18, to_account_id: 'shopping-card', card_id: 'rewards-card' }),
      fxShiftLever(snapshot, -0.1),
      incomeGapLever(snapshot, { from_month: '2026-11', months: 3, item_ids: ['salary'] }),
      floorWindowLever(snapshot, 'pesos', [{ from_month: '2026-11', to_month: '2027-06', amount_minor: 1500000 }]),
      { label: 'Ünïcode → ₱ and € ✓ 🎯', patch: {} },
    ]
    const link = encodeLevers(levers)
    expect(link).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeLevers(link)).toEqual({ ok: true, value: levers })
    expect(decodeLevers(`#${link}`)).toEqual({ ok: true, value: levers })
    expect(encodeLevers(levers)).toBe(link)
    expect([levers[0]?.label, levers[6]?.label, levers[7]?.label, levers[8]?.label]).toEqual(['Rent: €950.00 from Nov 2026', 'EUR 10% weaker', 'Salary stops for 3 months from Nov 2026', 'Pesos floor: ₱15,000.00 from Nov 2026 to Jun 2027'])
    // Every length of the last group round-trips.
    for (const label of ['a', 'ab', 'abc', 'abcd']) expect(decodeLevers(encodeLevers([{ label, patch: {} }]))).toEqual({ ok: true, value: [{ label, patch: {} }] })
    expect(encodeLevers([])).toBe('eyJ2IjoxLCJsZXZlcnMiOltdfQ')
  })

  it('returns a named error for a link that is not base64url, UTF-8 or JSON, and checks the levers it holds', () => {
    expect(decodeLevers('abc$')).toEqual({ ok: false, errors: ['bad_link: the link is not base64url text'] })
    expect(decodeLevers('A')).toEqual({ ok: false, errors: ['bad_link: the link is not base64url text'] })
    expect(decodeLevers('_w')).toEqual({ ok: false, errors: ['bad_link: the link is not UTF-8 text'] })
    expect(decodeLevers('eyJ2Ijox')).toEqual({ ok: false, errors: [expect.stringMatching(/^bad_json: /)] })
    const text = (value: unknown) => base64url(JSON.stringify(value))
    expect(decodeLevers(text({ v: 1, levers: [{ label: 'Rent', patch: { items: { rent: { amount: 1 } } } }], extra: true }))).toEqual({
      ok: false,
      errors: ["levers[0].patch.items.rent: Unknown key 'amount'; allowed keys: amount_minor, day, from_month, ends_on, removed, include_upside", "(root): Unknown key 'extra'; allowed keys: v, levers"],
    })
    expect(() => encodeLevers([{ label: '', patch: {} }])).toThrow('These levers cannot make a link: levers[0].label: must not be empty')
  })
})
