import { addDays, buildSnapshot, daysBetween, lastDayOfMonth, ledgerSum, runEngine, walkMetrics, type ImportDocInput, type Snapshot, type Walk } from '@waypoint/core'
import { abroad, markSize, mortgage, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { drawnLines } from '../../ui/chart/plot'
import { contrast } from '../../ui/contrast'
import { COLORS } from '../../ui/tokens'
import {
  centreOffset,
  chipFill,
  chipLabels,
  chipWidth,
  clampMonth,
  monthPanes,
  monthSummary,
  NO_SCROLL,
  paneSummary,
  paneTitle,
  planPanes,
  strip,
  chipShown,
  stripScroll,
  stripWord,
  wordFill,
  type MonthKind,
  type Pane,
  type StripEvent,
  type StripScroll,
  type Words,
} from './months.model'

const AS_OF = '2026-10-09'

function world(build: (asOf: string) => Sample, asOf = AS_OF, edit?: (doc: SampleDoc) => void): { snapshot: Snapshot; walk: Walk } {
  const sample = build(asOf)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, asOf, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return { snapshot, walk: run.walk }
}

// One euro account holding 1,000.00 with no plan: October's floor is above it, November's target is, December on has a lower floor. A second one is tight in October and short in January.
function words(): { snapshot: Snapshot; walk: Walk } {
  const doc: ImportDocInput = {
    version: 1,
    household: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-IE', track_from: '2026-10-01' },
    accounts: [
      {
        id: 'a',
        name: 'A',
        kind: 'cash',
        currency: 'EUR',
        opening_balance_minor: 100000,
        opening_date: '2026-10-01',
        floor_windows: [
          { from_month: '2026-10', to_month: '2026-10', amount_minor: 200000 },
          { from_month: '2026-11', to_month: '2026-11', amount_minor: 50000 },
          { from_month: '2026-11', to_month: '2026-11', amount_minor: 200000 },
          { from_month: '2026-12', to_month: null, amount_minor: 50000 },
        ],
      },
      {
        id: 'b',
        name: 'B',
        kind: 'cash',
        currency: 'EUR',
        opening_balance_minor: 500000,
        opening_date: '2026-10-01',
        floor_windows: [
          { from_month: '2026-10', to_month: '2026-10', amount_minor: 100000 },
          { from_month: '2026-10', to_month: '2026-10', amount_minor: 600000 },
          { from_month: '2027-01', to_month: '2027-01', amount_minor: 600000 },
        ],
      },
    ],
  }
  const snapshot = buildSnapshot(doc, AS_OF, [{ quote: 'EUR', rate: 1, day: AS_OF }])
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error('the engine did not run')
  return { snapshot, walk: run.walk }
}

const WORDS: Words = {
  name: (id) => ({ main: 'Main', tax: 'Tax', pesos: 'Pesos' })[id] ?? id,
  day: (day, withYear) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`)),
}

describe('the month word', () => {
  it('gives Short, Tight and OK across the cash accounts, the worst one winning, and nothing for past months', () => {
    const { walk } = words()
    const both = ['a', 'b']
    expect(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02'].map((m) => stripWord(walk, both, m))).toEqual(['Short', 'Tight', 'OK', 'Short', 'OK'])
    expect(['2026-10', '2026-11', '2027-01'].map((m) => stripWord(walk, ['b'], m))).toEqual(['Tight', 'OK', 'Short'])
    expect(['2026-09', '2025-10'].map((m) => stripWord(walk, both, m))).toEqual([null, null])
  })

  it('makes 73 chips from 12 months back to the walk’s last month, past ones with no word', () => {
    const { snapshot, walk } = world(abroad)
    const chips = strip(snapshot, walk)
    expect(chips).toHaveLength(73)
    expect([chips[0]?.month, chips[11]?.month, chips[12]?.month, chips.at(-1)?.month]).toEqual(['2025-10', '2026-09', '2026-10', '2031-10'])
    expect(chips.map((c) => c.kind)).toEqual([...Array(12).fill('past'), 'current', ...Array(60).fill('projected')])
    expect(chips.slice(0, 12).every((c) => c.word === null)).toBe(true)
    // Main and Pesos dip under their floors before October's top-ups land; every later month holds.
    expect(chips.slice(12).map((c) => c.word)).toEqual(['Short', ...Array(60).fill('OK')])
  })

  it('opens a month outside the strip at its nearest end', () => {
    const { snapshot, walk } = world(abroad)
    const chips = strip(snapshot, walk)
    expect(['2020-01', '2025-10', '2027-03', '2031-10', '2040-01'].map((m) => clampMonth(chips, m))).toEqual(['2025-10', '2025-10', '2027-03', '2031-10', '2031-10'])
  })

  it('labels each chip with its short month, the year where one starts, Now on this month, and a spoken name with its word', () => {
    const { snapshot, walk } = world(abroad)
    const labels = chipLabels(strip(snapshot, walk), 'en-GB')
    expect(labels.slice(0, 5).map((l) => [l.month, l.above])).toEqual([
      ['Oct', '2025'],
      ['Nov', ''],
      ['Dec', ''],
      ['Jan', '2026'],
      ['Feb', ''],
    ])
    expect([labels[11]?.label, labels[12]?.label, labels[12]?.above, labels[13]?.label]).toEqual(['September 2026, past', 'October 2026, this month, Short', 'Now', 'November 2026, OK'])
    // The word's pill (7, a 14 pt icon, 4, 'Short' and 10) is wider than en-GB's longest short month, 'Sept': 69 plus 8 a side, to the 4-point grid.
    expect(chipWidth(labels)).toBe(88)
  })
})

describe('a month chip’s colours', () => {
  const KINDS: readonly MonthKind[] = ['past', 'current', 'projected']
  const WORDS = ['OK', 'Tight', 'Short'] as const
  const fills = [...new Set(KINDS.flatMap((kind) => [true, false].flatMap((selected) => [true, false].map((active) => chipFill(kind, selected, active)))))]

  it('fills the selected month brand-soft, a hovered or pressed chip surface-2, a past month bg and the rest surface', () => {
    expect([chipFill('projected', true, true), chipFill('past', true, false), chipFill('past', false, true), chipFill('past', false, false), chipFill('current', false, false), chipFill('projected', false, false)]).toEqual(['brandSoft', 'brandSoft', 'surface2', 'bg', 'surface', 'surface'])
    expect(fills).toEqual(['brandSoft', 'surface2', 'bg', 'surface'])
  })

  it('puts every word in a pill on its own status fill, OK included, as an account row does', () => {
    expect(WORDS.map(wordFill)).toEqual(['positiveFill', 'cautionFill', 'negativeFill'])
  })

  it.each(['light', 'dark'] as const)('holds 4.5 to 1 for the word on every chip in %s, which bare Short on the selected light chip would miss', (scheme) => {
    const p = COLORS[scheme]
    const ink = { OK: p.positive, Tight: p.caution, Short: p.negative }
    const pairs = WORDS.flatMap((word) => fills.map((fill) => ({ word, fill, ratio: contrast(ink[word], p[wordFill(word)]) })))
    expect(pairs.length).toBe(12)
    expect(pairs.filter((x) => x.ratio < 4.5)).toEqual([])
    expect(Math.round(contrast(p.negative, p.brandSoft) * 1e4) / 1e4).toBe(scheme === 'light' ? 4.4996 : 5.0076)
  })
})

describe('one scroll per selection (rule 183)', () => {
  const run = (events: StripEvent[], from: StripScroll = NO_SCROLL) => {
    let state = from
    const scrolls: { month: string; width: number; animated: boolean }[] = []
    for (const e of events) {
      const step = stripScroll(state, e)
      state = step.state
      if (step.scroll) scrolls.push(step.scroll)
    }
    return { state, scrolls }
  }

  it('waits for the strip’s width, then scrolls once, without animating the first time', () => {
    expect(run([{ type: 'select', month: '2027-03' }]).scrolls).toEqual([])
    expect(run([{ type: 'select', month: '2027-03' }, { type: 'layout', width: 390 }]).scrolls).toEqual([{ month: '2027-03', width: 390, animated: false }])
  })

  it('never scrolls again for a new width that keeps the month in view, the same month or a repeated layout', () => {
    const { scrolls } = run([
      { type: 'select', month: '2027-03' },
      { type: 'layout', width: 390 },
      { type: 'layout', width: 640, shows: true },
      { type: 'select', month: '2027-03' },
      { type: 'layout', width: 640 },
      { type: 'layout', width: 640, shows: false },
    ])
    expect(scrolls).toHaveLength(1)
  })

  it('brings the month back without animating when a new width pushed it out of view, as crossing the sidebar’s width does', () => {
    const { scrolls } = run([
      { type: 'select', month: '2027-03' },
      { type: 'layout', width: 390 },
      { type: 'layout', width: 1040, shows: false },
      { type: 'layout', width: 390, shows: false },
    ])
    expect(scrolls).toEqual([
      { month: '2027-03', width: 390, animated: false },
      { month: '2027-03', width: 1040, animated: false },
      { month: '2027-03', width: 390, animated: false },
    ])
    // A pick still waiting for its scroll is the pick's to make, not the resize's.
    expect(run([{ type: 'layout', width: 390 }, { type: 'select', month: '2026-10' }, { type: 'select', month: '2027-03' }]).scrolls).toHaveLength(2)
  })

  it('brings the month back when a tablet turns from 820 to 1,180 px, which drops the offset while the strip stays 720 wide', () => {
    const turned = run([
      { type: 'select', month: '2027-08' },
      { type: 'layout', width: 720, screen: 820 },
      { type: 'layout', width: 720, screen: 1180, shows: false },
      { type: 'layout', width: 720, screen: 820, shows: false },
    ])
    expect(turned.scrolls).toEqual([
      { month: '2027-08', width: 720, animated: false },
      { month: '2027-08', width: 720, animated: false },
      { month: '2027-08', width: 720, animated: false },
    ])
    // The same window and strip with the month out of view is the person's own scroll, which stays.
    expect(run([{ type: 'select', month: '2027-08' }, { type: 'layout', width: 720, screen: 1180 }, { type: 'layout', width: 720, screen: 1180, shows: false }]).scrolls).toHaveLength(1)
    // A new window width that keeps the month in view moves nothing.
    expect(run([{ type: 'select', month: '2027-08' }, { type: 'layout', width: 720, screen: 820 }, { type: 'layout', width: 720, screen: 1180, shows: true }]).scrolls).toHaveLength(1)
  })

  it('tells a chip in view from one scrolled past either edge', () => {
    const g = { count: 12, chip: 60, gap: 8, pad: 16 }
    expect([chipShown(g, 0, 0, 390), chipShown(g, 4, 0, 390), chipShown(g, 5, 0, 390), chipShown(g, 0, 20, 390), chipShown(g, 6, 100, 390)]).toEqual([true, true, false, false, true])
  })

  it('scrolls once, animated, for each later pick, and only to the last of picks made before the strip had a width', () => {
    expect(
      run([
        { type: 'layout', width: 390 },
        { type: 'select', month: '2026-10' },
        { type: 'select', month: '2027-03' },
        { type: 'select', month: '2026-12' },
      ]).scrolls,
    ).toEqual([
      { month: '2026-10', width: 390, animated: false },
      { month: '2027-03', width: 390, animated: true },
      { month: '2026-12', width: 390, animated: true },
    ])
    expect(run([{ type: 'select', month: '2026-10' }, { type: 'select', month: '2027-03' }, { type: 'layout', width: 390 }]).scrolls).toEqual([{ month: '2027-03', width: 390, animated: false }])
  })

  it('centres a chip, and keeps the first and last chips inside the strip', () => {
    const g = { count: 73, chip: 64, gap: 8, pad: 16 }
    // Chip 12 starts at 16 + 12 × 72 = 880; its centre, 912, sits at 195 in a 390-wide strip.
    expect(centreOffset(g, 12, 390)).toBe(717)
    expect(centreOffset(g, 0, 390)).toBe(0)
    expect(centreOffset(g, 72, 390)).toBe(2 * 16 + 73 * 64 + 72 * 8 - 390)
  })
})

describe('the month under each currency', () => {
  it('reads a past month from its rows alone: opening, money in and out, and closing', () => {
    const { snapshot, walk } = world(abroad)
    const september = monthSummary(snapshot, walk, '2026-09')
    expect(september.kind).toBe('past')
    expect(september.groups.map((g) => [g.currency, g.accounts.map((a) => a.account_id)])).toEqual([
      ['EUR', ['main', 'tax']],
      ['PHP', ['pesos']],
    ])
    for (const a of september.groups.flatMap((g) => g.accounts)) {
      const account = snapshot.doc.accounts.find((x) => x.id === a.account_id)
      const rows = snapshot.doc.transactions.filter((t) => t.account_id === a.account_id)
      const before = rows.filter((t) => t.posted_on < '2026-09-01').reduce((s, t) => s + t.amount_minor, account?.opening_balance_minor ?? NaN)
      const inMonth = rows.filter((t) => t.posted_on.startsWith('2026-09'))
      const moneyIn = inMonth.filter((t) => t.amount_minor > 0).reduce((s, t) => s + t.amount_minor, 0)
      const moneyOut = inMonth.filter((t) => t.amount_minor < 0).reduce((s, t) => s - t.amount_minor, 0)
      expect([a.opening_minor, a.in_minor, a.out_minor, a.closing_minor]).toEqual([before, moneyIn, moneyOut, before + moneyIn - moneyOut])
      expect([a.word, a.lowest_minor, a.floor_minor]).toEqual([null, null, null])
    }
    // Main: rent, three shops, a top-up and the tax set-aside out; the salary in.
    expect(september.groups[0]?.accounts[0]).toMatchObject({ opening_minor: 646000, in_minor: 400000, out_minor: 246000, closing_minor: 800000 })
    expect(monthSummary(snapshot, walk, '2026-08').groups).toEqual([])
  })

  it('closes a projected month on the engine’s balance for its last day and opens it on the day before', () => {
    const { snapshot, walk } = world(abroad)
    for (const month of walk.months.slice(1)) {
      const summary = monthSummary(snapshot, walk, month)
      expect(summary.kind).toBe('projected')
      for (const a of summary.groups.flatMap((g) => g.accounts)) {
        const days = walk.balances.get(a.account_id) as Float64Array
        expect(a.closing_minor).toBe(days[daysBetween(AS_OF, lastDayOfMonth(month))])
        expect(a.opening_minor).toBe(days[daysBetween(AS_OF, `${month}-01`) - 1])
      }
    }
    expect(monthSummary(snapshot, walk, '2027-03').groups[0]?.accounts[0]).toMatchObject({ word: 'OK', floor_minor: 300000, target_minor: 600000, lowest_on: '2027-03-27', days_under_floor: 0 })
  })

  it('shows this month live → projected, everything between them from the plan, rows dated after today apart', () => {
    const { snapshot, walk } = world(abroad, AS_OF, (doc) => {
      doc.transactions.push({ id: 'in-transit', account_id: 'main', posted_on: addDays(AS_OF, 2), amount_minor: 10000, kind: 'income', description: 'Refund on its way' })
    })
    const october = monthSummary(snapshot, walk, '2026-10')
    expect([october.kind, october.from, october.to]).toEqual(['current', AS_OF, '2026-10-31'])
    for (const a of october.groups.flatMap((g) => g.accounts)) {
      expect(a.opening_minor).toBe(walk.start.get(a.account_id))
      expect(a.closing_minor).toBe(walk.balances.get(a.account_id)?.[daysBetween(AS_OF, '2026-10-31')])
      expect(a.opening_minor + a.in_minor - a.out_minor + a.later_rows_minor).toBe(a.closing_minor)
    }
    const main = october.groups[0]?.accounts[0]
    // Live is opening plus rows to today; the salary on the 28th is planned, the refund in transit is not.
    expect(main).toMatchObject({ opening_minor: ledgerSum(snapshot, 'main', AS_OF), later_rows_minor: 10000, word: 'Short', floor_minor: 600000, days_under_floor: 11 })
    expect(main?.in_minor).toBeGreaterThanOrEqual(400000)
  })
})

describe('the chart', () => {
  it('draws this month from rows before today and the walk from today, each floor on its own account', () => {
    const { snapshot, walk } = world(abroad)
    const [eur, php] = monthPanes(snapshot, walk, '2026-10')
    expect([eur?.currency, eur?.startDate, eur?.todayIndex, eur?.lines.map((l) => [l.account_id, l.colour, l.points.length])]).toEqual([
      'EUR',
      '2026-10-01',
      8,
      [
        ['main', 0, 31],
        ['tax', 1, 31],
      ],
    ])
    const main = eur?.lines[0]?.points as Float64Array
    for (let i = 0; i < 8; i++) expect(main[i]).toBe(ledgerSum(snapshot, 'main', addDays('2026-10-01', i)))
    expect([...main.subarray(8)]).toEqual([...(walk.balances.get('main') as Float64Array).subarray(0, 23)])
    expect(eur?.floors).toEqual([{ account_id: 'main', fromIndex: 0, toIndex: 30, value: 600000 }])
    expect(eur?.lines.map((l) => l.opening)).toEqual([ledgerSum(snapshot, 'main', '2026-09-30'), ledgerSum(snapshot, 'tax', '2026-09-30')])
    expect(php?.floors).toEqual([{ account_id: 'pesos', fromIndex: 0, toIndex: 30, value: 2000000 }])
    expect(php?.lines.map((l) => l.colour)).toEqual([2])
  })

  it('places today before a later month and after an earlier one, and draws nothing before the accounts opened', () => {
    const { snapshot, walk } = world(abroad)
    const [march] = monthPanes(snapshot, walk, '2027-03')
    expect([march?.startDate, march?.todayIndex]).toEqual(['2027-03-01', daysBetween('2027-03-01', AS_OF)])
    expect(march?.lines[0]?.opening).toBe(walk.balances.get('main')?.[daysBetween(AS_OF, '2027-02-28')])
    expect([...(march?.lines[0]?.points as Float64Array)]).toEqual([...(walk.balances.get('main') as Float64Array).subarray(daysBetween(AS_OF, '2027-03-01'), daysBetween(AS_OF, '2027-03-31') + 1)])
    const [september] = monthPanes(snapshot, walk, '2026-09')
    expect([september?.todayIndex, september?.floors]).toEqual([38, []])
    expect(monthPanes(snapshot, walk, '2026-08')).toEqual([])
  })

  it('draws the whole plan from today, and its lowest drawn point is the engine’s lowest day for every account', () => {
    for (const build of [abroad, usCardsCar, mortgage, markSize]) {
      const { snapshot, walk } = world(build)
      const lowest = new Map(walkMetrics(snapshot, walk).cash.map((c) => [c.account_id, c]))
      for (const pane of planPanes(snapshot, walk)) {
        expect([pane.startDate, pane.todayIndex]).toEqual([AS_OF, 0])
        expect(pane.lines.map((l) => l.opening)).toEqual(pane.lines.map((l) => walk.start.get(l.account_id)))
        const drawn = drawnLines(pane.lines, pane.startDate, pane.todayIndex)
        pane.lines.forEach((line, k) => {
          const way = drawn[k]
          const kept = way?.buckets ? way.buckets.flatMap((b) => [b.lo, b.hi]) : (way?.line.map((p) => p[0]) ?? [])
          expect(line.points.length).toBe(walk.days.length)
          expect(kept.length).toBeLessThan(line.points.length)
          const at = kept.reduce((best, i) => ((line.points[i] as number) < (line.points[best] as number) ? i : best), kept[0] as number)
          expect([line.points[at], walk.days[at]]).toEqual([lowest.get(line.account_id)?.lowest_minor, lowest.get(line.account_id)?.lowest_on])
        })
      }
    }
  })

  it('joins months with one floor into one floor line on the whole plan', () => {
    const { snapshot, walk } = world(abroad)
    const [eur] = planPanes(snapshot, walk)
    const novemberAt = daysBetween(AS_OF, '2026-11-01')
    const lateAt = daysBetween(AS_OF, '2028-12-01')
    expect(eur?.floors).toEqual([
      { account_id: 'main', fromIndex: 0, toIndex: novemberAt - 1, value: 600000 },
      { account_id: 'main', fromIndex: novemberAt, toIndex: lateAt - 1, value: 300000 },
      { account_id: 'main', fromIndex: lateAt, toIndex: walk.days.length - 1, value: 600000 },
    ])
  })

  it('titles each pane with its takeaway and no amount, and says whose days it reads and which are recorded', () => {
    const { snapshot, walk } = world(abroad)
    const october = monthPanes(snapshot, walk, '2026-10')
    expect(october.map((p) => paneTitle(p, WORDS))).toEqual(['Main goes under its floor on 17 Oct', 'Pesos goes under its floor on 1 Oct'])
    expect(paneSummary(october[0] as Pane, WORDS)).toBe('Daily balances of Main and Tax from 1 Oct 2026 to 31 Oct 2026, recorded to 8 Oct, projected from 9 Oct. Dashed lines mark the floor of Main.')
    expect(monthPanes(snapshot, walk, '2026-11').map((p) => paneTitle(p, WORDS))).toEqual(['Main stays above its floor', 'Pesos stays above its floor'])
    const september = monthPanes(snapshot, walk, '2026-09')
    // No floors in September: Main and Tax rose, Pesos ended below zero.
    expect(september.map((p) => paneTitle(p, WORDS))).toEqual(['Main and Tax together end the month higher than they began', 'Pesos ends the month lower than it began'])
    const flat: Pane = { currency: 'EUR', lines: [{ account_id: 'tax', colour: 1, opening: 5000, points: [5000, 6000, 5000] }], floors: [], startDate: AS_OF, todayIndex: 0, span: 'plan', takeaway: { kind: 'change', account_ids: ['tax'], direction: 'flat' } }
    expect(paneTitle(flat, WORDS)).toBe('Tax ends the projection where it stands today')
    expect(paneTitle({ ...flat, takeaway: { kind: 'change', account_ids: ['main', 'tax'], direction: 'down' } }, WORDS)).toBe('Main and Tax together end the projection lower than today')
    expect(paneSummary(september[1] as Pane, WORDS)).toBe('Daily balances of Pesos from 1 Sept 2026 to 30 Sept 2026, all recorded.')
    const plan = planPanes(snapshot, walk)
    expect(plan.map((p) => paneTitle(p, WORDS))).toEqual(['Main goes under its floor on 17 Oct 2026', 'Pesos goes under its floor on 16 Oct 2026'])
    expect(paneSummary(plan[1] as Pane, WORDS)).toBe('Daily balances of Pesos from 9 Oct 2026 to 31 Oct 2031, all projected. Dashed lines mark the floor of Pesos.')
  })
})
