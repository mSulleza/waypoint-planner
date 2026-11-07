import { describe, expect, it } from 'vitest'
import { cardHousehold } from '../fixtures'
import { CARDS, cardModule, cardsOf, minimumDue, type CardReplay } from '../src/engine/cards'
import type { Walk } from '../src/engine/types'
import { CARD_BEHAVIOURS, CARD_PRESETS, cardPreset, termsFromPreset } from '../src/presets'
import { cardTerms } from '../src/schema/terms'
import { buildSnapshot } from '../src/snapshot'
import { walked } from './walk-helpers'

const card = { cut_day: 15, due: { days_after_cut: 25 }, due_roll: 'following' } as const

describe('card presets', () => {
  it('parses every preset as card terms', () => {
    expect(CARD_PRESETS.map((p) => p.id)).toEqual(['generic-in-full', 'PH-min-floor', 'US-generic', 'PH-round-up', 'PH-round-off', 'PH-daily-unpaid'])
    for (const preset of CARD_PRESETS) {
      const terms = termsFromPreset(preset.id, card)
      expect(cardTerms.parse(terms)).toEqual(terms)
      expect(terms).toEqual({ ...card, ...preset.rules, preset: preset.id })
    }
  })

  it('groups the variants by behaviour, each labelled with its source', () => {
    const byBehaviour = Object.fromEntries(CARD_BEHAVIOURS.map((b) => [b, CARD_PRESETS.filter((p) => p.behaviour === b).map((p) => p.id)]))
    expect(byBehaviour).toEqual({
      'Pays in full each month': ['generic-in-full', 'PH-min-floor'],
      'Revolving, interest on the average daily balance': ['US-generic', 'PH-round-up', 'PH-round-off'],
      'Revolving, interest daily on the unpaid statement balance': ['PH-daily-unpaid'],
    })
    for (const preset of CARD_PRESETS.filter((p) => p.id.startsWith('PH-'))) expect([preset.source, preset.currency]).toEqual(['example terms, not fitted to a bank', 'PHP'])
    expect(CARD_PRESETS.filter((p) => p.note?.includes('until calibrated')).map((p) => p.id)).toEqual(['PH-min-floor', 'PH-round-up', 'PH-round-off'])
  })

  it('pays generic-in-full in full in any currency, with a minimum of 1% of the total plus installments, interest and fees and no floor, at 24% a year', () => {
    expect([cardPreset('generic-in-full')?.currency, cardPreset('generic-in-full')?.rules]).toEqual([
      null,
      {
        interest: { method: 'average_daily_balance', rate: 0.24, period: 'year', day_count: 365, payment_effective_lag_days: 0 },
        minimum: { pct: 0.01, add_installments: true, add_interest: true, add_fees: true, floor_minor: 0, rounding: 'half_up' },
        pay: { mode: 'in_full', on: 'due_date' },
      },
    ])
  })

  it('pays PH-min-floor in full, with a minimum of 3% of the total plus installments, at least 60000, half up', () => {
    expect(cardPreset('PH-min-floor')?.rules).toEqual({
      interest: { method: 'average_daily_balance', rate: 0.03, period: 'month', day_count: 30, payment_effective_lag_days: 0 },
      minimum: { pct: 0.03, add_installments: true, add_interest: false, add_fees: false, floor_minor: 60000, rounding: 'half_up' },
      pay: { mode: 'in_full', on: 'due_date' },
    })
  })

  it('pays US-generic its minimum of 1% of the total plus interest and fees, at least 3500, at 24% a year', () => {
    expect(cardPreset('US-generic')?.rules).toEqual({
      interest: { method: 'average_daily_balance', rate: 0.24, period: 'year', day_count: 365, payment_effective_lag_days: 0 },
      minimum: { pct: 0.01, add_installments: false, add_interest: true, add_fees: true, floor_minor: 3500, rounding: 'half_up' },
      pay: { mode: 'minimum', on: 'due_date' },
    })
  })

  it('pays the PH revolving cards installments_plus at 3% a month, round-up by ceiling and round-off half up, and counts a daily-unpaid payment from the next day', () => {
    const minimum = (pct: number, rounding: string) => ({ pct, add_installments: false, add_interest: false, add_fees: false, floor_minor: 0, rounding })
    const pay = { mode: 'installments_plus', on: 'due_date' }
    const adb = { method: 'average_daily_balance', rate: 0.03, period: 'month', day_count: 30, payment_effective_lag_days: 0 }
    expect(cardPreset('PH-round-up')?.rules).toEqual({ interest: adb, minimum: minimum(0.035, 'ceil'), pay })
    expect(cardPreset('PH-round-off')?.rules).toEqual({ interest: adb, minimum: minimum(0.035, 'half_up'), pay })
    expect(cardPreset('PH-daily-unpaid')?.rules).toEqual({ interest: { method: 'daily_on_unpaid', rate: 0.03, period: 'month', day_count: 30, payment_effective_lag_days: 1 }, minimum: minimum(0.03, 'ceil'), pay })
  })

  it('hands out a copy, so editing a card never edits the preset', () => {
    const terms = termsFromPreset('PH-daily-unpaid', card)
    terms.interest.rate = 0.02
    terms.minimum.rounding = 'half_up'
    expect(cardPreset('PH-daily-unpaid')?.rules.interest.rate).toBe(0.03)
    expect(cardPreset('PH-daily-unpaid')?.rules.minimum.rounding).toBe('ceil')
    expect(() => termsFromPreset('PH-XX', card)).toThrow(RangeError)
  })
})

describe('a USD card on generic-in-full', () => {
  const asOf = '2026-10-08'
  const terms = termsFromPreset('generic-in-full', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })
  const none = { installments_minor: 0, interest_minor: 0, fees_minor: 0 }
  // Opened today owing 2,500.00, with a 400.00 card bill on the 10th of each month.
  const replay = (pays: boolean): [CardReplay, Walk] => {
    const { doc, rates } = cardHousehold({
      asOf,
      currency: 'USD',
      terms,
      opening_balance_minor: -250000,
      opening_date: asOf,
      plan_items: [{ id: 'streaming', kind: 'bill', name: 'Streaming', from_account_id: 'card', amount_minor: 40000, starts_on: '2026-10-10' }],
    })
    const w = walked(buildSnapshot(doc, asOf, rates), { cards: pays ? CARDS : cardModule(() => 0) })
    const found = cardsOf(w)?.get('card')
    if (!found) throw new Error('The walk has no replay for the card')
    return [found, w]
  }
  const figures = (r: CardReplay) => r.statements.slice(0, 3).map((s) => [s.cut_date, s.due_date, s.total_due_minor, s.minimum_due_minor, s.grace, s.model?.interest_minor ?? null, s.pay_on, s.paid_minor])

  it('pays each statement total on its due date', () => {
    const [r, w] = replay(true)
    expect(figures(r)).toEqual([
      ['2026-10-08', '2026-10-16', 250000, 2500, null, null, '2026-10-16', 250000],
      ['2026-10-20', '2026-11-16', 40000, 400, true, 0, '2026-11-16', 40000],
      ['2026-11-20', '2026-12-16', 40000, 400, true, 0, '2026-12-16', 40000],
    ])
    expect(r.statements.slice(0, 3).map((s) => s.payment?.base_minor)).toEqual([250000, 40000, 40000])
    expect(w.lines.filter((l) => l.account_id === 'cash' && l.kind === 'payment' && l.date <= '2026-12-31').map((l) => [l.date, l.amount_minor])).toEqual([
      ['2026-10-16', -250000],
      ['2026-11-16', -40000],
      ['2026-12-16', -40000],
    ])
  })

  it('bears no interest while paid in full by the due date, and 24% a year on the average daily balance once it is not', () => {
    expect(replay(true)[0].statements.slice(1, 4).map((s) => [s.grace, s.model?.interest_minor])).toEqual([
      [true, 0],
      [true, 0],
      [true, 0],
    ])
    // Unpaid: October (2,500.00 x 13 days from opening + 400.00 x 11) x 24% / 365 = 24.26; November (2,924.26 x 31 + 400.00 x 11) x 24% / 365 = 62.50.
    const [unpaid] = replay(false)
    expect(unpaid.statements.slice(1, 3).map((s) => [s.cut_date, s.grace, s.total_due_minor, s.model?.interest_minor])).toEqual([
      ['2026-10-20', false, 292426, 2426],
      ['2026-11-20', false, 338676, 6250],
    ])
  })

  it('sizes its minimum with no currency floor: 1% of the total plus the add-ons, capped at the total', () => {
    const us = termsFromPreset('US-generic', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })
    const floored = termsFromPreset('PH-min-floor', { cut_day: 20, due: { day_of_month: 16 }, due_roll: 'none' })
    // On 2,500.00 the US $35.00 and PH-min-floor PHP 600.00 floors would stand; this one takes its 1%.
    expect([minimumDue(terms, 250000, none), minimumDue(us, 250000, none), minimumDue(floored, 250000, none)]).toEqual([2500, 3500, 60000])
    expect([minimumDue(terms, 250000, { installments_minor: 10000, interest_minor: 2426, fees_minor: 500 }), minimumDue(terms, 300, none), minimumDue(terms, 0, none)]).toEqual([15426, 3, 0])
    // Unpaid, October's minimum is 1% of 2,924.26 plus its 24.26 interest: 29.24 + 24.26.
    expect(replay(false)[0].statements[1]?.minimum_due_minor).toBe(5350)
  })
})
