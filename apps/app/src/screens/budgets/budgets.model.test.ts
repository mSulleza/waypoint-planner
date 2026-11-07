import { buildSnapshot, type Snapshot } from '@waypoint/core'
import { abroad, markSize, type Sample } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { budgetsModel, monthName, patternWords, weekdayName } from './budgets.model'

function snapshotOf(build: (asOf: string) => Sample, asOf: string): Snapshot {
  const sample = build(asOf)
  return buildSnapshot(sample.doc, asOf, sample.rates)
}

describe('budgets', () => {
  it('lists the weekly budgets with this week and the month by week, and keeps the lumpy ones by the month', () => {
    const m = budgetsModel(snapshotOf(markSize, '2026-10-21'))
    expect([m.from, m.to, m.day, m.days]).toEqual(['2026-10-19', '2026-10-25', 3, 7])
    expect(m.weekly.map((l) => l.category_id)).toEqual(['cat-groceries'])
    // Spent in fewer than half of the 8 weeks seen, by budget size in euros; the peso budgets are the smallest at ₱70.
    expect(m.monthly.map((b) => b.category_id)).toEqual(['cat-transport', 'cat-fun', 'cat-health', 'cat-personal', 'cat-pets', 'cat-gifts'])
    const [groceries] = m.weekly
    expect(groceries?.weeks.map((w) => [w.from, w.to, w.state])).toEqual([
      ['2026-10-01', '2026-10-04', 'past'],
      ['2026-10-05', '2026-10-11', 'past'],
      ['2026-10-12', '2026-10-18', 'past'],
      ['2026-10-19', '2026-10-25', 'current'],
      ['2026-10-26', '2026-10-31', 'future'],
    ])
    expect([groceries?.spent_minor, groceries?.left_minor, groceries?.word]).toEqual([4500, (groceries?.budget_minor ?? 0) - 4500, 'On pace'])
  })

  it('draws the week bar as spent over the week, with the mark at the usual plan by today', () => {
    const [groceries] = budgetsModel(snapshotOf(abroad, '2026-10-09')).weekly
    if (!groceries) throw new Error('no groceries')
    expect(groceries.bar).toEqual({ spent: groceries.spent_minor / groceries.budget_minor, mark: groceries.plan_by_today_minor / groceries.budget_minor, fill: 'brandText' })
    expect(groceries.weeks.find((w) => w.state === 'current')).toMatchObject({ spent_minor: groceries.spent_minor, budget_minor: groceries.budget_minor, over: false })
  })

  it('fills a week past its budget whole and marks it over', () => {
    const m = budgetsModel(snapshotOf(markSize, '2026-10-09'))
    const week = m.weekly[0]?.weeks.find((w) => w.state === 'current')
    expect([m.weekly[0]?.word, week?.share, week?.over, m.weekly[0]?.bar.fill]).toEqual(['Spending fast', 1, true, 'caution'])
  })

  it('words the pattern by its peak days, evenly with the days seen, or evenly until 2 weeks are recorded', () => {
    expect([weekdayName(0, 'en-GB'), weekdayName(6, 'en-GB'), monthName('2026-10', 'en-GB')]).toEqual(['Monday', 'Sunday', 'October'])
    expect(patternWords({ pattern: 'peaks', peaks: [5, 3] }, 'en-GB')).toBe('Most on Saturday and Thursday')
    expect(patternWords({ pattern: 'peaks', peaks: [4] }, 'en-GB')).toBe('Most on Friday')
    expect(patternWords({ pattern: 'even', peaks: [] }, 'en-GB')).toBe('Spread through the week')
    expect(patternWords({ pattern: 'learning', peaks: [] }, 'en-GB')).toBe('Spread evenly until 2 weeks are recorded')
  })
})
