import { describe, expect, it } from 'vitest'
import { markSize, SAMPLES } from '../fixtures'
import { daysBetween } from '../src/dates'
import { expandPlan } from '../src/engine/events'
import { billedThrough, cutIn, cutOnOrAfter, historyFrom, horizonEnd, latestCut, slotCut } from '../src/engine/occurrences'
import { buildSnapshot } from '../src/snapshot'
import { abroadAt, bare, counted, item, occurrence } from './plan-helpers'

const of = (plan: ReturnType<typeof expandPlan>, itemId: string) => plan.occurrences.filter((o) => o.plan_item_id === itemId)

describe('expanding plan items', () => {
  it('puts a 31st-of-month item on the last day of February and back on the 31st in March', () => {
    const plan = expandPlan(bare('2027-01-15', { plan_items: [item({ id: 'gym', kind: 'bill', from_account_id: 'bank', amount_minor: 3000, starts_on: '2027-01-31' })] }))
    expect(of(plan, 'gym').slice(0, 4).map((o) => [o.id, o.scheduled_on])).toEqual([
      ['gym:2027-01-01', '2027-01-31'],
      ['gym:2027-02-01', '2027-02-28'],
      ['gym:2027-03-01', '2027-03-31'],
      ['gym:2027-04-01', '2027-04-30'],
    ])
    expect(occurrence(plan, 'gym:2028-02-01').scheduled_on).toBe('2028-02-29')
  })

  it('counts a 2weeks item from its anchor, with each date as its own period', () => {
    const pay = item({ id: 'pay', kind: 'income', to_account_id: 'bank', amount_minor: 200000, every: '2weeks', starts_on: '2026-09-05', roll: 'preceding' })
    const plan = expandPlan(bare('2026-10-07', { plan_items: [pay] }, '2026-09-01'))
    expect(of(plan, 'pay').slice(0, 5).map((o) => [o.period, o.date])).toEqual([
      ['2026-09-05', '2026-09-04'],
      ['2026-09-19', '2026-09-18'],
      ['2026-10-03', '2026-10-02'],
      ['2026-10-17', '2026-10-16'],
      ['2026-10-31', '2026-10-30'],
    ])
    const later = expandPlan(bare('2028-01-10', { plan_items: [pay] }, '2026-09-01'))
    expect(later.history_from).toBe('2027-01-01')
    expect(of(later, 'pay')[0]?.period).toBe('2027-01-09')
    expect(of(later, 'pay').every((o) => daysBetween('2026-09-05', o.period) % 14 === 0)).toBe(true)
    expect(of(later, 'pay').at(-1)?.period).toBe('2033-01-29')
  })

  it('yields 12 occurrences for an installment from 2026-06-01 to 2027-05-01, each billed at its month cut', () => {
    const phone = item({ id: 'phone', kind: 'installment', from_account_id: 'card', amount_minor: 10000, starts_on: '2026-06-01', ends_on: '2027-05-01' })
    const plan = expandPlan(bare('2026-10-07', { plan_items: [phone] }, '2026-06-01'))
    const billed = of(plan, 'phone')
    expect(billed).toHaveLength(12)
    expect([billed[0]?.period, billed[0]?.date, billed[11]?.period, billed[11]?.date]).toEqual(['2026-06-01', '2026-06-20', '2027-05-01', '2027-05-20'])
    expect(billed.every((o) => o.date === cutIn(20, o.period) && o.flow === 'installment')).toBe(true)
  })

  it('rolls a weekend date without changing its period', () => {
    const plan = expandPlan(abroadAt('2026-10-07'))
    const rent = occurrence(plan, 'rent:2026-11-01')
    expect([rent.period, rent.scheduled_on, rent.date]).toEqual(['2026-11-01', '2026-11-01', '2026-11-02'])
    expect(counted(plan, 'rent:2026-11-01')).toEqual([['2026-11-02', 'main', -90000]])
  })

  it('stops a recurring item at its own ends_on', () => {
    const plan = expandPlan(
      bare('2026-10-07', {
        plan_items: [
          item({ id: 'car-insurance', kind: 'bill', from_account_id: 'bank', amount_minor: 8000, starts_on: '2026-09-15', ends_on: '2027-02-15' }),
          item({ id: 'car-tax', kind: 'bill', from_account_id: 'bank', amount_minor: 20000, every: 'year', starts_on: '2026-11-01' }),
        ],
      }),
    )
    expect(of(plan, 'car-insurance').map((o) => o.period)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'])
    expect(of(plan, 'car-tax').map((o) => o.period)).toEqual(['2026-11-01', '2027-11-01', '2028-11-01', '2029-11-01', '2030-11-01'])
  })

  it('counts a quarterly item every 3 months from starts_on, across year ends, through its ends_on', () => {
    const fee = item({ id: 'fee', kind: 'bill', from_account_id: 'bank', amount_minor: 45000, every: 'quarter', starts_on: '2026-11-20', ends_on: '2028-02-19', roll: 'following' })
    const last = item({ id: 'last-day', kind: 'bill', from_account_id: 'bank', amount_minor: 1000, every: 'quarter', starts_on: '2026-08-31', roll: 'following' })
    const plan = expandPlan(bare('2026-10-07', { plan_items: [fee, last] }))
    // Saturdays roll to Monday; the February 2028 occurrence falls on the 20th, a day after ends_on.
    expect(of(plan, 'fee').map((o) => [o.period, o.date, o.amount_minor])).toEqual([
      ['2026-11-01', '2026-11-20', 45000],
      ['2027-02-01', '2027-02-22', 45000],
      ['2027-05-01', '2027-05-20', 45000],
      ['2027-08-01', '2027-08-20', 45000],
      ['2027-11-01', '2027-11-22', 45000],
    ])
    // A 31st lands on each third month's last day; a Sunday 28 Feb rolls into March and keeps February's period.
    expect(of(plan, 'last-day').slice(0, 4).map((o) => [o.period, o.scheduled_on, o.date])).toEqual([
      ['2026-08-01', '2026-08-31', '2026-08-31'],
      ['2026-11-01', '2026-11-30', '2026-11-30'],
      ['2027-02-01', '2027-02-28', '2027-03-01'],
      ['2027-05-01', '2027-05-31', '2027-05-31'],
    ])
    expect(counted(plan, 'fee:2027-02-01')).toEqual([['2027-02-22', 'bank', -45000]])
    expect(plan.occurrences.some((o) => o.plan_item_id === 'fee' && ['2026-12-01', '2027-01-01', '2027-03-01'].includes(o.period))).toBe(false)
  })

  it('keeps an old quarterly item on its own cadence from history_from to the horizon end', () => {
    const plan = expandPlan(bare('2026-10-07', { plan_items: [item({ id: 'fee', kind: 'bill', from_account_id: 'bank', amount_minor: 45000, every: 'quarter', starts_on: '2024-02-10' })] }, '2025-01-01'))
    const periods = of(plan, 'fee').map((o) => o.period)
    expect([plan.history_from, periods.length, periods.slice(0, 3), periods.at(-1)]).toEqual(['2025-10-01', 24, ['2025-11-01', '2026-02-01', '2026-05-01'], '2031-08-01'])
  })

  it('settles a quarterly occurrence by a link to its first-of-month period, and a skipped one by its skip', () => {
    const consulting = item({ id: 'consulting', kind: 'income', to_account_id: 'bank', amount_minor: 120000, every: 'quarter', starts_on: '2026-07-05', skip_periods: ['2027-01-01'] })
    const paid = { id: 'paid', account_id: 'bank', posted_on: '2026-07-06', amount_minor: 120000, kind: 'income' as const, plan_item_id: 'consulting', period: '2026-07-01' }
    const plan = expandPlan(bare('2026-10-07', { plan_items: [consulting], transactions: [paid] }))
    expect(of(plan, 'consulting').slice(0, 4).map((o) => [o.id, o.state, o.linked_minor, o.open_minor])).toEqual([
      ['consulting:2026-07-01', 'settled', 120000, 0],
      ['consulting:2026-10-01', 'late', 0, 120000],
      ['consulting:2027-01-01', 'settled', 0, 0],
      ['consulting:2027-04-01', 'due', 0, 120000],
    ])
    expect(occurrence(plan, 'consulting:2027-01-01').skipped).toBe(true)
  })

  it('settles a skipped period, which counts nothing', () => {
    const gym = item({ id: 'gym', kind: 'bill', from_account_id: 'bank', amount_minor: 3000, starts_on: '2026-10-12', skip_periods: ['2026-11-01'] })
    const plan = expandPlan(bare('2026-10-07', { plan_items: [gym] }))
    const skipped = occurrence(plan, 'gym:2026-11-01')
    expect([skipped.state, skipped.skipped, skipped.open_minor, counted(plan, skipped.id)]).toEqual(['settled', true, 0, []])
    expect(counted(plan, 'gym:2026-12-01')).toEqual([['2026-12-12', 'bank', -3000]])
  })

  it('gives an item before track_from no occurrence, no state and no event', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.plan_items.push(item({ id: 'old-fee', kind: 'bill', from_account_id: 'main', amount_minor: 5000, every: 'once', starts_on: '2026-08-10' }))
      }),
    )
    expect(plan.history_from).toBe('2026-09-01')
    expect(of(plan, 'old-fee')).toEqual([])
    expect(plan.events.filter((e) => e.id.startsWith('old-fee'))).toEqual([])
    expect(of(plan, 'laptop')[0]?.id).toBe('laptop:2026-09-01')
  })

  it('reaches back 12 months at most, then the horizon ends with the 60th month after this one', () => {
    const snapshot = bare('2027-10-07', { plan_items: [item({ id: 'water', kind: 'bill', from_account_id: 'bank', amount_minor: 4000, starts_on: '2026-01-03' })] })
    expect([historyFrom(snapshot), horizonEnd(snapshot.as_of)]).toEqual(['2026-10-01', '2032-10-31'])
    const plan = expandPlan(snapshot)
    expect(of(plan, 'water').filter((o) => o.state === 'overdue').map((o) => o.period)).toHaveLength(13)
    expect(of(plan, 'water')[0]?.period).toBe('2026-10-01')
    expect(of(plan, 'water').at(-1)?.period).toBe('2032-10-01')
  })

  it('reads a sale as cash in hand, sold on terms or still listed', () => {
    const sale = (confidence: 'upside' | 'committed', linked: boolean) =>
      expandPlan(
        abroadAt('2026-10-07', (doc) => {
          const camera = doc.plan_items.find((p) => p.id === 'camera-sale')
          if (camera) camera.confidence = confidence
          if (linked) doc.transactions.push({ id: 'camera-paid', account_id: 'pesos', posted_on: '2026-10-06', amount_minor: 1500000, kind: 'income', plan_item_id: 'camera-sale', period: '2026-11-01' })
        }),
      )
    expect(of(sale('upside', false), 'camera-sale')).toEqual([])
    expect(counted(sale('committed', false), 'camera-sale:2026-11-01')).toEqual([['2026-11-15', 'pesos', 1500000]])
    const inHand = occurrence(sale('committed', true), 'camera-sale:2026-11-01')
    expect([inHand.state, inHand.open_minor]).toEqual(['settled', 0])
  })

  it('keeps upside proceeds out of every occurrence and event until the item is committed', () => {
    for (const asOf of ['2026-10-07', '2027-03-15']) {
      for (const build of [...SAMPLES.map((s) => s.build), markSize]) {
        const { doc, rates } = build(asOf)
        const upside = new Set(doc.plan_items.filter((p) => p.confidence === 'upside').map((p) => p.id))
        const plan = expandPlan(buildSnapshot(doc, asOf, rates))
        expect(plan.occurrences.filter((o) => upside.has(o.plan_item_id))).toEqual([])
        expect(plan.events.filter((e) => e.occurrence_ids.some((id) => upside.has(id.split(':')[0] ?? '')))).toEqual([])
      }
    }
  })
})

describe('reading states', () => {
  it('keeps last month card bill on statement and charges nothing', () => {
    const plan = expandPlan(abroadAt('2026-10-07'))
    const streaming = occurrence(plan, 'streaming:2026-09-01')
    expect([streaming.flow, streaming.date, latestCut(abroadAt('2026-10-07'), 'rewards-card')]).toEqual(['card_bill', '2026-09-05', '2026-09-20'])
    expect([streaming.state, streaming.open_minor, counted(plan, streaming.id)]).toEqual(['on_statement', 0, []])
    expect(plan.suggestions.filter((s) => s.occurrence_id === streaming.id)).toEqual([])
  })

  it('reads an unlinked salary from last month as late and holds it out while its unlinked row may settle it', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        const row = doc.transactions.find((t) => t.id === 'salary-last')
        if (row) Object.assign(row, { plan_item_id: null, period: null })
      }),
    )
    const salary = occurrence(plan, 'salary:2026-09-01')
    expect([salary.state, salary.open_minor, salary.carried_to, counted(plan, salary.id)]).toEqual(['late', 400000, '2026-11-01', []])
    expect(plan.suggestions.filter((s) => s.occurrence_id === salary.id).map((s) => s.row_id)).toEqual(['salary-last'])
    expect(counted(plan, 'salary:2026-10-01')).toEqual([['2026-10-28', 'main', 400000]])
  })

  it('keeps an occurrence open when an unlinked row of the same amount exists, since absent is not settled', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.transactions.push({ id: 'mobile-paid', account_id: 'pesos', posted_on: '2026-10-07', amount_minor: -120000, kind: 'expense' })
      }),
    )
    const mobile = occurrence(plan, 'mobile:2026-10-01')
    expect([mobile.state, mobile.linked_minor, mobile.open_minor]).toEqual(['due', 0, 120000])
    expect(plan.suggestions.map((s) => [s.row_id, s.occurrence_id])).toEqual([['mobile-paid', 'mobile:2026-10-01']])
    expect(counted(plan, mobile.id)).toEqual([['2026-10-10', 'pesos', -120000]])
  })

  it('settles only when linked rows reach the amount or the period is skipped', () => {
    const read = (paid: number[], skip = false) => {
      const plan = expandPlan(
        abroadAt('2026-10-07', (doc) => {
          paid.forEach((amount, i) => doc.transactions.push({ id: `mobile-${i}`, account_id: 'pesos', posted_on: '2026-10-06', amount_minor: -amount, kind: 'expense', plan_item_id: 'mobile', period: '2026-10-01' }))
          const mobile = doc.plan_items.find((p) => p.id === 'mobile')
          if (mobile && skip) mobile.skip_periods = ['2026-10-01']
        }),
      )
      const o = occurrence(plan, 'mobile:2026-10-01')
      return [o.state, o.linked_minor, o.open_minor]
    }
    expect(read([])).toEqual(['due', 0, 120000])
    expect(read([50000, 20000])).toEqual(['partly_settled', 70000, 50000])
    expect(read([50000, 70000])).toEqual(['settled', 120000, 0])
    expect(read([], true)).toEqual(['settled', 0, 0])
  })

  it('settles a link only on the period it names', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.transactions.push({ id: 'salary-early', account_id: 'main', posted_on: '2026-10-06', amount_minor: 400000, kind: 'income', plan_item_id: 'salary', period: '2026-11-01' })
      }),
    )
    expect(occurrence(plan, 'salary:2026-11-01').links.map((t) => t.id)).toEqual(['salary-early'])
    expect([occurrence(plan, 'salary:2026-11-01').state, counted(plan, 'salary:2026-11-01')]).toEqual(['settled', []])
    expect([occurrence(plan, 'salary:2026-10-01').state, counted(plan, 'salary:2026-10-01')]).toEqual(['due', [['2026-10-28', 'main', 400000]]])
  })

  it('counts an overpaid occurrence as settled with nothing left, never below zero', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.transactions.push({ id: 'mobile-over', account_id: 'pesos', posted_on: '2026-10-06', amount_minor: -150000, kind: 'expense', plan_item_id: 'mobile', period: '2026-10-01' })
      }),
    )
    const mobile = occurrence(plan, 'mobile:2026-10-01')
    expect([mobile.state, mobile.linked_minor, mobile.open_minor, counted(plan, mobile.id)]).toEqual(['settled', 150000, 0, []])
  })

  it('gives a past unlinked transfer item into a card no state and no event', () => {
    const plan = expandPlan(
      abroadAt('2026-10-07', (doc) => {
        doc.plan_items.push(item({ id: 'card-extra', kind: 'transfer', to_account_id: 'rewards-card', amount_minor: 100000, every: 'once', starts_on: '2026-10-03' }))
      }),
    )
    const extra = occurrence(plan, 'card-extra:2026-10-01')
    expect([extra.flow, extra.account_id, extra.date, extra.state, extra.amount_minor]).toEqual(['debt_transfer', 'rewards-card', '2026-10-03', null, 100000])
    expect(counted(plan, extra.id)).toEqual([])
    expect(plan.suggestions).toEqual([])
  })

  it('finds the first cut on or after a day, clamped to the month end', () => {
    expect([cutOnOrAfter(20, '2026-10-10'), cutOnOrAfter(20, '2026-10-20'), cutOnOrAfter(20, '2026-10-21'), cutOnOrAfter(31, '2027-02-03')]).toEqual(['2026-10-20', '2026-10-20', '2026-11-20', '2027-02-28'])
  })

  it('reads a printed cut as the nearest cut by cut day, the earlier on a tie, across month ends', () => {
    expect([slotCut(20, '2026-10-18'), slotCut(20, '2026-10-23'), slotCut(1, '2026-10-31'), slotCut(31, '2027-03-02'), slotCut(20, '2026-12-05')]).toEqual(['2026-10-20', '2026-10-20', '2026-11-01', '2027-02-28', '2026-11-20'])
  })

  it('bills installments through the cut a statement printed early stands for, and through the opening day with none', () => {
    const early = abroadAt('2026-10-07', (doc) => {
      const last = doc.statements.find((s) => s.id === 'rewards-last')
      if (last) last.cut_date = '2026-09-18'
    })
    expect([latestCut(early, 'rewards-card'), billedThrough(early, 'rewards-card'), billedThrough(abroadAt('2026-10-07'), 'rewards-card')]).toEqual(['2026-09-18', '2026-09-20', '2026-09-20'])
    expect(occurrence(expandPlan(early), 'laptop:2026-09-01').state).toBe('on_statement')
    const none = abroadAt('2026-10-07', (doc) => {
      doc.statements = doc.statements.filter((s) => s.account_id !== 'rewards-card')
    })
    expect(billedThrough(none, 'rewards-card')).toBe('2026-09-01')
  })
})
