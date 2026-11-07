import { describe, expect, it } from 'vitest'
import { abroad, mortgage, revolvingDaily, SAMPLES, type SampleDoc } from '../fixtures'
import { ALERT_TITLES, alerts, dropSameSubject, type Alert } from '../src/alerts'
import { TABS } from '../src/copy'
import { addDays } from '../src/dates'
import { CARDS } from '../src/engine/cards'
import { LOANS } from '../src/engine/loans'
import { nextAction } from '../src/next-action'
import { REVIEW_TITLES, reviewList } from '../src/review'
import { buildSnapshot, type Snapshot } from '../src/snapshot'
import { advise, sampleAt, titlesOf, type Advice } from './advice-helpers'
import { account, cashHousehold, walked } from './walk-helpers'

const DATES = ['2026-10-07', '2026-10-23'] as const

const idsOf = (list: readonly Alert[]) => list.map((a) => [a.id, a.severity])

async function everyFixture(): Promise<Advice[]> {
  const out: Advice[] = []
  for (const asOf of DATES) for (const s of SAMPLES) out.push(await advise(sampleAt(s.build, asOf)))
  return out
}

function revolving(asOf: string, edit: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = revolvingDaily('2026-10-07')
  edit(doc)
  return buildSnapshot(doc, asOf, rates)
}

const lastOf = (doc: SampleDoc) => {
  const found = doc.statements.find((s) => s.id === 'last')
  if (!found) throw new Error('No last statement')
  return found
}

describe('alerts', () => {
  it('gives each fixture its expected alert set, and an alert and its review item share an id', async () => {
    const found = await everyFixture()
    expect(found.map((a) => [a.snapshot.as_of, idsOf(a.alerts)])).toEqual([
      ['2026-10-07', [['below_floor:pesos:2026-10', 'critical'], ['unfixable_gap:main:2026-10', 'critical']]],
      ['2026-10-07', []],
      ['2026-10-07', []],
      [
        '2026-10-23',
        [
          ['overdue_outflow:mobile:2026-10-01', 'critical'],
          ['overdue_outflow:insurance:2026-10-01', 'critical'],
          ['statement_to_enter:rewards-card:2026-10-20', 'warning'],
        ],
      ],
      [
        '2026-10-23',
        [
          ['overdue_outflow:utilities:2026-10-01', 'critical'],
          ['overdue_outflow:payment:car-loan:2026-10-20', 'critical'],
          ['statement_to_enter:travel-card:2026-10-20', 'warning'],
        ],
      ],
      ['2026-10-23', [['overdue_outflow:energy:2026-10-01', 'critical']]],
    ])
    for (const a of found) {
      for (const r of a.review) {
        const alert = a.alerts.find((x) => x.id === r.id)
        expect(alert).toEqual({ id: r.id, kind: r.kind, subject: { review_id: r.id }, severity: alert?.severity, title: r.title, body: r.body, route: r.route, act_by: r.act_by })
      }
    }
    const [first] = found
    expect(first?.alerts.map((x) => [x.act_by, first.say(x.body)])).toEqual([
      ['2026-10-16', 'Pesos goes below its floor of ₱20,000.00 on 2026-10-16; lowest ₱8,018.70 on 2026-10-22.'],
      ['2026-10-17', 'Main is short €88.00 in 2026-10 that no top-up covers; lowest €5,912.00 on 2026-10-27.'],
    ])
  })

  it('ranks a dip fifteen months out below a bill overdue today', async () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      account(doc, 'bank').floor_windows = [{ from_month: '2026-10', to_month: null, amount_minor: 100000 }]
      doc.plan_items.push(
        { id: 'tax', kind: 'bill', name: 'Tax bill', from_account_id: 'bank', amount_minor: 400000, every: 'once', starts_on: '2028-01-15' },
        { id: 'gym', kind: 'bill', name: 'Gym', from_account_id: 'bank', amount_minor: 20000, every: 'once', starts_on: '2026-10-06' },
      )
    })
    const a = await advise(snapshot)
    expect(a.alerts.map((x) => [x.id, x.severity, x.act_by])).toEqual([
      ['overdue_outflow:gym:2026-10-01', 'critical', '2026-10-06'],
      ['unfixable_gap:bank:2028-01', 'critical', '2028-01-15'],
    ])
  })

  it('raises one alert per shortfall, a dip under target only when it comes before a worse one', async () => {
    const household = (lateBill: boolean) =>
      cashHousehold('2026-10-07', (doc) => {
        account(doc, 'bank').floor_windows = [
          { from_month: '2026-10', to_month: null, amount_minor: 100000 },
          { from_month: '2026-10', to_month: null, amount_minor: 300000 },
        ]
        doc.plan_items.push({ id: 'car', kind: 'bill', name: 'Car repair', from_account_id: 'bank', amount_minor: 250000, every: 'once', starts_on: '2026-11-10' })
        if (lateBill) doc.plan_items.push({ id: 'tax', kind: 'bill', name: 'Tax bill', from_account_id: 'bank', amount_minor: 200000, every: 'once', starts_on: '2027-03-10' })
      })
    const tight = await advise(household(false))
    expect(tight.alerts.map((x) => [x.id, x.severity, x.act_by, tight.say(x.body)])).toEqual([
      ['below_target:bank:2026-11', 'warning', '2026-11-10', 'Bank dips under its target of €3,000.00 on 2026-11-10; lowest €2,500.00 on 2026-11-10.'],
    ])
    expect(idsOf((await advise(household(true))).alerts)).toEqual([
      ['unfixable_gap:bank:2027-03', 'critical'],
      ['below_target:bank:2026-11', 'warning'],
    ])
    // A dip under target after a worse month says nothing new: November's gap, then only Tight from December's refund on.
    const after = await advise(
      cashHousehold('2026-10-07', (doc) => {
        account(doc, 'bank').floor_windows = [
          { from_month: '2026-10', to_month: null, amount_minor: 100000 },
          { from_month: '2026-10', to_month: null, amount_minor: 300000 },
        ]
        doc.plan_items.push(
          { id: 'car', kind: 'bill', name: 'Car repair', from_account_id: 'bank', amount_minor: 450000, every: 'once', starts_on: '2026-11-10' },
          { id: 'refund', kind: 'income', name: 'Insurance refund', to_account_id: 'bank', amount_minor: 200000, every: 'once', starts_on: '2026-12-01' },
        )
      }),
    )
    expect(after.walk.figures.get('bank')?.slice(1, 3).map((m) => [m.month, m.word])).toEqual([
      ['2026-11', 'Short'],
      ['2026-12', 'Tight'],
    ])
    expect(idsOf(after.alerts)).toEqual([['unfixable_gap:bank:2026-11', 'critical']])
  })

  it('leaves out the alerts on the next action account and month when abroad needs a top-up, so the worst alert is a different one or none', async () => {
    // With September's mobile bill paid on time, the top-up's own account leads the alerts before the drop.
    const linked = await advise(
      sampleAt(abroad, '2026-10-16', (doc) => {
        doc.transactions.push({ id: 'mobile-now', account_id: 'pesos', posted_on: '2026-10-10', amount_minor: -120000, kind: 'expense', plan_item_id: 'mobile', period: '2026-10-01' })
      }),
    )
    const plain = await advise(sampleAt(abroad, '2026-10-16'))
    for (const a of [linked, plain]) {
      expect([a.next.kind, a.next.subject]).toEqual(['send', { account_id: 'pesos', month: '2026-10' }])
      expect(a.alerts.some((x) => x.id === 'unfixable_gap:pesos:2026-10')).toBe(true)
    }
    expect([linked.alerts[0]?.id, dropSameSubject(linked.alerts, linked.next)[0]?.id]).toEqual(['unfixable_gap:pesos:2026-10', 'unfixable_gap:main:2026-10'])
    expect(idsOf(dropSameSubject(plain.alerts, plain.next))).toEqual([
      ['overdue_outflow:mobile:2026-10-01', 'critical'],
      ['unfixable_gap:main:2026-10', 'critical'],
    ])
    // Before its day the same top-up leads, so the same alert stays out; a next action with nothing to do leaves every alert in place.
    const early = await advise(sampleAt(abroad, '2026-10-07'))
    expect([early.next.kind, early.alerts.some((x) => x.id === 'below_floor:pesos:2026-10'), dropSameSubject(early.alerts, early.next).some((x) => x.subject !== null && 'account_id' in x.subject && x.subject.account_id === 'pesos')]).toEqual(['send', true, false])
    const quiet = await advise(sampleAt(mortgage, '2026-10-10'))
    expect([quiet.next.kind, dropSameSubject(quiet.alerts, quiet.next)]).toEqual(['none', quiet.alerts])
  })

  it('fires no statement warning or interest alert while the printed parts agree within a tenth, and exactly one for each real difference', async () => {
    const asOf = '2026-10-07'
    // Printed interest 500.00 against the modelled 534.00: 6.8% apart, under the tenth.
    const agreeing = await advise(revolving(asOf, () => {}))
    expect([agreeing.review, agreeing.alerts]).toEqual([[], []])
    // A total-only statement has no parts to compare, so nothing fires for it either.
    const totalOnly = await advise(revolving(asOf, (doc) => Object.assign(lastOf(doc), { previous_balance_minor: null, payments_and_credits_minor: null, charges_minor: null, installments_minor: null, interest_minor: null, fees_minor: null })))
    expect(totalOnly.alerts).toEqual([])
    // Printed interest 400.00: 33.5% apart.
    const interest = await advise(revolving(asOf, (doc) => Object.assign(lastOf(doc), { interest_minor: 40000, total_due_minor: 2990000 })))
    expect(idsOf(interest.alerts)).toEqual([['interest_variance:last', 'warning']])
    expect(interest.say(interest.alerts[0]?.body ?? [])).toBe('Card: Interest differs; printed ₱400.00, the card terms give ₱534.00.')
    const over = await advise(revolving(asOf, (doc) => Object.assign(lastOf(doc), { available_credit_minor: -25000 })))
    expect(idsOf(over.alerts)).toEqual([['over_limit:card:2026-10', 'warning']])
    expect(over.say(over.alerts[0]?.body ?? [])).toBe('Card is ₱250.00 over its limit.')
  })

  it('names a cash account below zero at any exchange rate as its own alert', async () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      Object.assign(account(doc, 'bank'), { opening_balance_minor: 0 })
      Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'bank' })
      doc.plan_items.push({ id: 'school', kind: 'bill', name: 'School fees', from_account_id: 'pesos', amount_minor: 1500000, every: 'once', starts_on: '2026-11-10' })
    })
    const a = await advise(snapshot)
    expect(a.breakeven?.rate_independent).toEqual([{ account_id: 'pesos', date: '2026-11-10', days: 1817 }])
    expect(idsOf(a.alerts)).toEqual([
      ['rate_independent:pesos:2026-11', 'critical'],
      ['unfixable_gap:pesos:2026-11', 'critical'],
    ])
    expect(a.say(a.alerts[0]?.body ?? [])).toBe('Pesos goes below zero on 2026-11-10 at any rate.')
  })

  it('refuses to advise before every input has loaded, while a household of zero balances is advised like any other', async () => {
    const snapshot = sampleAt(abroad, '2026-10-16')
    const a = await advise(snapshot)
    const inputs = { snapshot, walk: a.walk, review: a.review, breakeven: a.breakeven, budgets: a.budgets }
    expect(() => alerts({ ...inputs, breakeven: null })).toThrow('The FX breakeven has not loaded for this two-currency household')
    expect(() => alerts({ ...inputs, breakeven: undefined as never })).toThrow('The FX breakeven has not loaded')
    expect(() => alerts({ ...inputs, review: undefined as never })).toThrow('The review list and budget rows must load before alerts')
    const tomorrow = await advise(sampleAt(abroad, '2026-10-17'))
    expect(() => alerts({ ...inputs, walk: tomorrow.walk })).toThrow("The walk is for 2026-10-17, not the snapshot's day 2026-10-16")
    expect(() => reviewList(snapshot, walked(snapshot, { loans: LOANS }))).toThrow('The review needs a walk that ran the card module')
    expect(() => nextAction({ snapshot, walk: walked(snapshot, { mode: 'metrics', cards: CARDS, loans: LOANS }), review: a.review })).toThrow('The next action reads the walk lines; walk in full mode')
    const zero = await advise(
      cashHousehold('2026-10-07', (doc) => {
        for (const x of doc.accounts) x.opening_balance_minor = 0
      }),
    )
    expect([zero.alerts, zero.next.kind, zero.next.context]).toEqual([[], 'none', []])
  })

  it('keeps every title imperative without digits in at most 50 characters, deadlines as real dates and ids apart from names, and drops a settled item rather than re-dating it', async () => {
    const found = await everyFixture()
    const titles = [...found.flatMap(titlesOf), ...Object.values(ALERT_TITLES), ...Object.values(REVIEW_TITLES)]
    for (const title of titles) {
      expect(title.length).toBeLessThanOrEqual(50)
      expect(title).not.toMatch(/[0-9]/)
    }
    for (const a of found) for (const x of a.alerts) expect(addDays(x.act_by, 0)).toBe(x.act_by)
    const renamed = await advise(
      sampleAt(abroad, '2026-10-23', (doc) => {
        for (const x of [...doc.accounts, ...doc.plan_items]) x.name = `${x.name} renamed`
      }),
    )
    expect(renamed.alerts.map((x) => x.id)).toEqual(found[3]?.alerts.map((x) => x.id))
    const paid = await advise(
      sampleAt(abroad, '2026-10-23', (doc) => {
        doc.transactions.push({ id: 'insurance-now', account_id: 'pesos', posted_on: '2026-10-23', amount_minor: -350000, kind: 'expense', plan_item_id: 'insurance', period: '2026-10-01' })
      }),
    )
    expect(paid.alerts.map((x) => x.id)).toEqual(['overdue_outflow:mobile:2026-10-01', 'statement_to_enter:rewards-card:2026-10-20'])
  })

  it('never suggests lowering a floor, as shortfall alerts ask for money and open Months or Plan', async () => {
    const found = [...(await everyFixture()), await advise(sampleAt(abroad, '2026-10-16'))]
    const short = found.flatMap((a) => a.alerts.filter((x) => ['below_floor', 'below_target', 'unfixable_gap', 'rate_independent'].includes(x.kind)).map((x) => ({ x, text: `${x.title} ${a.say(x.body)}` })))
    expect(short.length).toBe(4)
    for (const { x, text } of short) {
      expect(text).not.toMatch(/\b(lower|reduce|decrease|drop|cut)\b/i)
      expect(['months', 'plan']).toContain(x.route.tab)
    }
  })

  it('routes every alert and next action to one of the five tabs, and a missing rate is its own alert with no stand-in rate', async () => {
    const snapshot = cashHousehold('2026-10-07', (doc) => {
      doc.accounts.push({ id: 'dollars', name: 'Dollars', kind: 'cash', currency: 'USD', opening_balance_minor: 50000, opening_date: '2026-01-01', sort_order: 3 })
    })
    const missing = await advise(snapshot)
    expect(idsOf(missing.alerts)).toEqual([['missing_rate:USD', 'warning']])
    expect([missing.alerts[0]?.subject, missing.alerts[0]?.route, missing.say(missing.alerts[0]?.body ?? [])]).toEqual([
      { account_id: 'dollars', month: '2026-10' },
      { tab: 'money' },
      'No reference rate for USD, so totals that need it are not shown.',
    ])
    const found = [...(await everyFixture()), missing, await advise(sampleAt(abroad, '2026-10-16'))]
    const routes = found.flatMap((a) => [...a.alerts.map((x) => x.route), a.next.route])
    expect(routes.length).toBeGreaterThan(15)
    for (const route of routes) expect(TABS).toContain(route.tab)
  })
})
