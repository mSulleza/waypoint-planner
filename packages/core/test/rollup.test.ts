import { describe, expect, it } from 'vitest'
import { markSize, SAMPLES } from '../fixtures'
import { addDays } from '../src/dates'
import { balanceRange, monthFigures, monthWord } from '../src/engine/rollup'
import type { LineItem, Walk } from '../src/engine/types'
import { netOf } from '../src/money'
import { floorAndTarget } from '../src/schema/rows'
import { buildSnapshot, snapshotIndex } from '../src/snapshot'
import { abroadAt } from './plan-helpers'
import { account, balanceOn, cashHousehold, payEnteredStatements, topUpPairs, walked } from './walk-helpers'

const DATES = ['2026-10-07', '2027-03-15'] as const
const ALL = [...SAMPLES.map((s) => s.build), markSize]
const window = (amount_minor: number, from_month = '2026-10', to_month: string | null = null) => ({ from_month, to_month, amount_minor })
const sum = (lines: readonly LineItem[]) => lines.reduce((total, l) => total + l.amount_minor, 0)
const linesIn = (w: Walk, accountIds: readonly string[], month: string) => w.lines.filter((l) => accountIds.includes(l.account_id) && l.date.startsWith(month))

describe('month figures', () => {
  it('words a month Short, Tight or OK and gives past months none', () => {
    const w = walked(
      cashHousehold('2026-10-07', (doc) => {
        account(doc, 'bank').floor_windows = [window(400000), window(600000)]
        account(doc, 'savings').floor_windows = [window(200000, '2026-10', '2026-10')]
      }),
    )
    expect(['bank', 'savings', 'pesos'].map((id) => monthWord(w, id, '2026-10'))).toEqual(['Tight', 'Short', 'OK'])
    expect(['bank', 'savings', 'pesos'].map((id) => monthWord(w, id, '2026-11'))).toEqual(['Tight', 'OK', 'OK'])
    expect(['bank', 'savings', 'pesos'].map((id) => monthWord(w, id, '2026-09'))).toEqual([null, null, null])
    expect(monthFigures(w, 'bank', '2026-10')).toMatchObject({ floor_minor: 400000, target_minor: 600000, floor_set: true, lowest_minor: 500000, days_under_floor: 0, days_under_target: 25 })
    expect(() => monthWord(w, 'nope', '2026-10')).toThrow(RangeError)
  })

  it('measures each month against the floor and target in force that month', () => {
    const snapshot = abroadAt('2026-10-07')
    const w = walked(snapshot, { cards: payEnteredStatements })
    const main = snapshotIndex(snapshot).accounts.get('main')
    if (main?.kind !== 'cash') throw new Error('abroad has no Main')
    for (const f of w.figures.get('main') ?? []) {
      expect([f.month, f.floor_minor, f.target_minor]).toEqual([f.month, floorAndTarget(main.floor_windows, f.month).floor, floorAndTarget(main.floor_windows, f.month).target])
      let under = 0
      for (let day = f.first_day; day <= f.last_day; day = addDays(day, 1)) if (balanceOn(w, 'main', day) < f.floor_minor) under++
      expect([f.month, f.days_under_floor]).toEqual([f.month, under])
    }
    // The 3,000.00 window under the 6,000.00 one relaxes the floor while it lasts; the target stays the larger.
    expect(['2026-10', '2026-11', '2028-11', '2028-12'].map((m) => [monthFigures(w, 'main', m)?.floor_minor, monthFigures(w, 'main', m)?.target_minor])).toEqual([
      [600000, 600000],
      [300000, 600000],
      [300000, 600000],
      [600000, 600000],
    ])
    expect(monthFigures(w, 'tax', '2026-10')).toMatchObject({ floor_set: false, floor_minor: 0, target_minor: 0, word: 'OK' })
  })

  it('sums each account month lines to its closing minus its opening', () => {
    for (const asOf of DATES) {
      for (const build of ALL) {
        const { doc, rates } = build(asOf)
        const w = walked(buildSnapshot(doc, asOf, rates), { cards: payEnteredStatements })
        for (const [id, list] of w.figures) {
          for (const f of list) {
            const own = linesIn(w, [id], f.month)
            const [moves, topUps] = [own.filter((l) => l.source !== 'top_up'), own.filter((l) => l.source === 'top_up')]
            expect([id, f.month, sum(own), f.in_minor, f.out_minor, f.top_up_in_minor, f.top_up_out_minor]).toEqual([
              id,
              f.month,
              f.closing_minor - f.opening_minor,
              sum(moves.filter((l) => l.amount_minor > 0)),
              0 - sum(moves.filter((l) => l.amount_minor < 0)),
              sum(topUps.filter((l) => l.amount_minor > 0)),
              0 - sum(topUps.filter((l) => l.amount_minor < 0)),
            ])
          }
        }
      }
    }
  })

  it('matches the line totals in both currencies under a shifted rate', () => {
    const snapshot = abroadAt('2026-10-07')
    const w = walked(snapshot, { cards: payEnteredStatements, fx_shift_pct: -0.15 })
    expect(w.rates.PHP).toBe(59.5)
    for (const currency of ['EUR', 'PHP']) {
      const ids = snapshot.doc.accounts.filter((a) => a.kind === 'cash' && a.currency === currency).map((a) => a.id)
      for (const month of w.months) {
        const change = ids.reduce((total, id) => total + (monthFigures(w, id, month)?.closing_minor ?? 0) - (monthFigures(w, id, month)?.opening_minor ?? 0), 0)
        expect([currency, month, change]).toEqual([currency, month, sum(linesIn(w, ids, month))])
      }
    }
    for (const [, from, to, sent, landed] of topUpPairs(w)) expect([from, to, landed]).toEqual(['main', 'pesos', netOf(sent, 59.5, 0.007)])
  })

  it('reports the unfixable gap as the shortfall no later top-up covers', () => {
    const w = walked(abroadAt('2026-10-07'), { cards: payEnteredStatements })
    const [pesos, main] = [monthFigures(w, 'pesos', '2026-10'), monthFigures(w, 'main', '2026-10')]
    // Pesos is short from the 16th, but the 28th covers it; Main has no funder, so its dip stays.
    expect([pesos?.word, pesos?.unfixable_gap_minor, main?.word, main?.unfixable_gap_minor]).toEqual(['Short', 0, 'Short', 600000 - (main?.lowest_minor ?? 0)])
    expect(main?.unfixable_gap_minor).toBeGreaterThan(0)

    // A target whose source runs dry keeps its shortfall, a balance carried into later months rather than a month's bill.
    const dry = walked(
      cashHousehold('2026-10-07', (doc) => {
        account(doc, 'bank').floor_windows = [window(300000)]
        Object.assign(account(doc, 'pesos'), { funded_from_account_id: 'bank', floor_windows: [window(30000000)] })
      }),
    )
    const gap = 30000000 - 1000000 - netOf(200000, 70, 0.005)
    expect(['2026-10', '2026-11', '2031-10'].map((m) => monthFigures(dry, 'pesos', m)?.unfixable_gap_minor)).toEqual([gap, gap, gap])
  })

  it('gives a window of days its own lowest and highest balance', () => {
    const w = walked(abroadAt('2026-10-07'), { cards: payEnteredStatements })
    expect(balanceRange(w, 'pesos', '2026-10-07', '2026-10-15')).toEqual({ lowest_minor: 2880000, lowest_on: '2026-10-10', highest_minor: 3000000, highest_on: '2026-10-07' })
    const late = balanceRange(w, 'pesos', '2026-10-28', '2026-10-31')
    const month = balanceRange(w, 'pesos', '2026-10-01', '2026-10-31')
    expect([late?.lowest_minor, late?.lowest_on, month?.lowest_minor, month?.lowest_on]).toEqual([balanceOn(w, 'pesos', '2026-10-28'), '2026-10-28', balanceOn(w, 'pesos', '2026-10-22'), '2026-10-22'])
    expect((late?.lowest_minor ?? 0) > (month?.lowest_minor ?? 0)).toBe(true)
    expect([balanceRange(w, 'pesos', '2026-09-01', '2026-09-30'), balanceRange(w, 'pesos', '2032-01-01', '2032-01-31')]).toEqual([null, null])
  })
})
