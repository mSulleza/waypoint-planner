import { describe, expect, it } from 'vitest'
import type { SampleDoc } from '../fixtures'
import type { PlanItemInput, TransactionInput } from '../fixtures/relative'
import { addDays } from '../src/dates'
import { mondayOf, monthPlan, monthWeeks, SHARE_PARTS, weekday, weekPace, weekPattern } from '../src/pace'
import { cashHousehold } from './walk-helpers'

const allowance = (id: string, category_id: string, amount_minor: number, from_account_id = 'bank'): PlanItemInput => ({ id, kind: 'allowance', name: id, from_account_id, category_id, amount_minor, starts_on: '2026-09-01' })

const spend = (id: string, day: string, amount_minor: number, category_id = 'food', account_id = 'bank'): TransactionInput => ({ id, account_id, posted_on: day, amount_minor: -amount_minor, kind: 'expense', category_id })

// One shop of `amount` every Saturday from 19 Sep to 17 Oct 2026: five weeks of history before the week of 19 Oct.
const saturdays = (doc: SampleDoc, amount: number, category_id = 'food', account_id = 'bank') => {
  for (let day = '2026-09-19'; day <= '2026-10-17'; day = addDays(day, 7)) doc.transactions.push(spend(`sat-${category_id}-${day}`, day, amount, category_id, account_id))
}

const even = Array.from({ length: 7 }, (_, i) => (i === 0 ? SHARE_PARTS - 6 * Math.round(SHARE_PARTS / 7) : Math.round(SHARE_PARTS / 7)))

describe('weekly pace', () => {
  it('counts weekdays from Monday, so 19 Oct 2026 is a Monday and 1 Jan 1970 a Thursday', () => {
    expect([weekday('2026-10-19'), weekday('2026-10-25'), weekday('1970-01-01'), mondayOf('2026-10-21'), mondayOf('2026-10-19')]).toEqual([0, 6, 3, '2026-10-19', '2026-10-19'])
  })

  it('cuts a month into Monday-to-Sunday weeks and joins a part-week of 1 to 3 days to the week beside it', () => {
    const spans = (asOf: string) => monthWeeks(asOf).map((w) => `${w.from.slice(8)}-${w.to.slice(8)}`)
    // October 2026 starts on a Thursday, so its first week is 4 days and stays.
    expect(spans('2026-10-21')).toEqual(['01-04', '05-11', '12-18', '19-25', '26-31'])
    // November starts on a Sunday and ends on a Monday: both single days join their neighbours.
    expect(spans('2026-11-01')).toEqual(['01-08', '09-15', '16-22', '23-30'])
    // January 2027 starts on a Friday: 3 days join the first full week.
    expect(spans('2027-01-15')).toEqual(['01-10', '11-17', '18-24', '25-31'])
  })

  it('splits a budget over the month by weekday share, to the cent, with the whole budget by the last day', () => {
    const saturday = [0, 0, 0, 0, 0, SHARE_PARTS, 0]
    const plan = monthPlan(31000, saturday, '2026-10')
    // October 2026 has five Saturdays: 3, 10, 17, 24 and 31.
    expect([plan('2026-09-30'), plan('2026-10-02'), plan('2026-10-03'), plan('2026-10-30'), plan('2026-10-31')]).toEqual([0, 0, 6200, 24800, 31000])
    const flat = monthPlan(31000, even, '2026-10')
    expect([flat('2026-10-07'), flat('2026-10-31')]).toEqual([7000, 31000])
  })

  it('reads an even week with no history, weekly, with no usual day', () => {
    const pattern = weekPattern(undefined, null, '2026-10-18')
    expect(pattern).toMatchObject({ days_seen: 0, weeks_seen: 0, weeks_spent: 0, peaks: [], usual_day_minor: null, rhythm: 'weekly' })
    expect(pattern.shares.reduce((a, b) => a + b, 0)).toBe(SHARE_PARTS)
  })

  it('tilts the week toward the days spent on, pulled toward even by 4 weeks, and names the usual day as the median', () => {
    const daily = new Map([
      ['2026-09-26', 4000],
      ['2026-10-03', 6000],
      ['2026-10-10', 5000],
      ['2026-10-17', 9000],
    ])
    const pattern = weekPattern(daily, '2026-09-21', '2026-10-18')
    // Four weeks seen, all spent on Saturday: (4 × 1 + 4 ÷ 7) ÷ 8 of the week, and 1 ÷ 14 for each other day.
    expect(pattern.shares).toEqual([71429, 71429, 71429, 71429, 71429, 571426, 71429])
    expect(pattern).toMatchObject({ days_seen: 28, weeks_seen: 4, weeks_spent: 4, peaks: [5], usual_day_minor: 5500, rhythm: 'weekly' })
  })

  it('keeps a category spent in fewer than half its weeks monthly, with the month word', () => {
    const snapshot = cashHousehold('2026-10-21', (doc) => {
      doc.categories.push({ id: 'phone', name: 'Phone' })
      doc.plan_items.push(allowance('phone-budget', 'phone', 2200))
      doc.transactions.push(spend('top-up', '2026-10-03', 1000, 'phone'))
    })
    const [row] = weekPace(snapshot).rows
    expect([row?.category_id, row?.pattern.rhythm, row?.pattern.weeks_spent, row?.pattern.weeks_seen, row?.word, row?.word === row?.month.word]).toEqual(['phone', 'monthly', 1, 3, 'On pace', true])
  })

  it('plans a Saturday shopper light until Saturday, reads a usual shop early in the week On pace, and the week past its budget Spending fast', () => {
    const week = (asOf: string, extra: TransactionInput[] = []) =>
      weekPace(
        cashHousehold(asOf, (doc) => {
          doc.plan_items.push(allowance('food-budget', 'food', 37000))
          saturdays(doc, 8000)
          doc.transactions.push(...extra)
        }),
      )
    const wednesday = week('2026-10-21')
    const [row] = wednesday.rows
    expect([wednesday.from, wednesday.to, wednesday.day, wednesday.days]).toEqual(['2026-10-19', '2026-10-25', 3, 7])
    // Spent on Saturdays only, the plan by Wednesday is under 3 ÷ 7 of the week's budget.
    expect(row?.plan_by_today_minor).toBeLessThan(Math.floor(((row?.weeks[row.current]?.budget_minor ?? 0) * 3) / 7))
    expect([row?.pattern.peaks, row?.pattern.usual_day_minor, row?.word]).toEqual([[5], 8000, 'On pace'])
    // One usual shop on Monday is within the plan by today plus a usual day.
    expect(week('2026-10-19', [spend('mon-shop', '2026-10-19', 7500)]).rows[0]?.word).toBe('On pace')
    // Two shops by Wednesday pass the week's budget.
    const twice = week('2026-10-21', [spend('mon-shop', '2026-10-19', 7500), spend('wed-shop', '2026-10-21', 7500)]).rows[0]
    expect([twice?.weeks[twice.current]?.spent_minor, twice?.word]).toEqual([15000, 'Spending fast'])
    expect(twice && twice.weeks[twice.current]!.spent_minor > twice.limit_minor).toBe(true)
  })

  it('lists the month by week, past weeks with their spending, and what is left as an even week from today', () => {
    const pace = weekPace(
      cashHousehold('2026-10-21', (doc) => {
        doc.plan_items.push(allowance('food-budget', 'food', 31000))
        doc.transactions.push(spend('early', '2026-10-02', 5000), spend('mid', '2026-10-14', 3000), { id: 'returned', account_id: 'bank', posted_on: '2026-10-15', amount_minor: 1000, kind: 'refund', category_id: 'food' })
      }),
    )
    const [row] = pace.rows
    expect(row?.weeks.map((w) => [w.from, w.spent_minor, w.state])).toEqual([
      ['2026-10-01', 5000, 'past'],
      ['2026-10-05', 0, 'past'],
      ['2026-10-12', 2000, 'past'],
      ['2026-10-19', 0, 'current'],
      ['2026-10-26', 0, 'future'],
    ])
    expect(row?.weeks.reduce((t, w) => t + w.budget_minor, 0)).toBe(31000)
    // 310.00 − 70.00 spent leaves 240.00 for 11 days, today included: 152.72 a week.
    expect([row?.month.left_minor, row?.month.days_left, row?.per_week_minor]).toEqual([24000, 11, 15272])
  })

  it('adds the weekly rows in the base currency for the total, leaving the monthly ones out', () => {
    const pace = weekPace(
      cashHousehold('2026-10-21', (doc) => {
        doc.categories.push({ id: 'fun', name: 'Fun' }, { id: 'phone', name: 'Phone' })
        doc.plan_items.push(allowance('food-budget', 'food', 37000), allowance('fun-budget', 'fun', 700000, 'pesos'), allowance('phone-budget', 'phone', 2200))
        saturdays(doc, 8000)
        saturdays(doc, 140000, 'fun', 'pesos')
        doc.transactions.push(spend('top-up', '2026-10-03', 1000, 'phone'))
      }),
    )
    expect(pace.rows.map((r) => [r.category_id, r.currency, r.pattern.rhythm])).toEqual([
      ['food', 'EUR', 'weekly'],
      ['fun', 'PHP', 'weekly'],
      ['phone', 'EUR', 'monthly'],
    ])
    const [food, fun] = pace.rows
    const total = pace.total
    // ₱ amounts at ₱70 to the euro.
    expect(total?.currency).toBe('EUR')
    expect(total?.weeks[3]?.budget_minor).toBe((food?.weeks[3]?.budget_minor ?? 0) + Math.round((fun?.weeks[3]?.budget_minor ?? 0) / 70))
    // Each Saturday together is 80.00 + 20.00.
    expect([total?.usual_day_minor, total?.word]).toEqual([10000, 'On pace'])
  })

  it('has no total without a weekly budget', () => {
    const pace = weekPace(cashHousehold('2026-10-21'))
    expect([pace.rows, pace.total]).toEqual([[], null])
  })
})
