import { addDays, addMonths, buildSnapshot, runEngine, type Snapshot, type Walk } from '@waypoint/core'
import { abroad, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { goalRange, incomeGoal, lendingModel, raiseBy, withRaises, monthLines, monthlyYield, plannedInjections, project, readInputs, readNumber, roundGrowth, schedule, RANGES, ROUND_DAYS, YEARS_PAST_GOAL, type Inputs, type Injection } from './lending.model'

const AS_OF = '2026-11-06'

const plan = (over: Partial<Inputs> = {}): Inputs => ({ loss: 15, topup: 0, goal: null, rate: 20, growth: 0, ...over })

function world(edit?: (doc: SampleDoc) => void): { snapshot: Snapshot; walk: Walk } {
  const sample = abroad(AS_OF)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, AS_OF, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return { snapshot, walk: run.walk }
}

// Two made-up €5,000 loans out of the euro account.
const twoLoans = (doc: SampleDoc) => {
  doc.plan_items.push(
    { id: 'loan-1', kind: 'bill', name: 'Lending: loan 1 out', from_account_id: 'main', amount_minor: 500000, every: 'once', starts_on: '2029-04-01' },
    { id: 'loan-2', kind: 'bill', name: 'lending: loan 2 out', from_account_id: 'main', amount_minor: 500000, every: 'once', starts_on: '2029-08-01' },
    { id: 'payout', kind: 'income', name: 'Lending: payout', to_account_id: 'main', amount_minor: 1000000, every: 'once', starts_on: '2031-02-15', confidence: 'upside' },
    { id: 'maybe', kind: 'bill', name: 'Lending: maybe', from_account_id: 'main', amount_minor: 500000, every: 'once', starts_on: '2030-01-30', confidence: 'upside' },
  )
}

describe('the terms', () => {
  it('turns 120% a round into a monthly yield, less the loss buffer', () => {
    expect(roundGrowth(0)).toBeCloseTo(1.2, 10)
    expect(roundGrowth(15)).toBeCloseTo(1.2 * (1 - (0.15 * 180) / 365), 10)
    // 20% every 180 days is about 3.4% a month; 15% a year lost leaves about 1.9%.
    expect(monthlyYield(0)).toBeCloseTo(0.0338, 4)
    expect(monthlyYield(15)).toBeCloseTo(0.0188, 4)
  })
})

describe('the money put in', () => {
  it('reads plan items named Lending that pay money out, in any case, and leaves out upside and income', () => {
    const { snapshot } = world(twoLoans)
    expect(plannedInjections(snapshot, '2056-11-06').map((i) => [i.day, i.minor, i.item_id, i.name])).toEqual([
      ['2029-04-01', 500000, 'loan-1', 'loan 1 out'],
      ['2029-08-01', 500000, 'loan-2', 'loan 2 out'],
    ])
  })

  it('takes the goal from committed monthly income with no end, not the lending payouts', () => {
    const { snapshot } = world(twoLoans)
    expect(incomeGoal(snapshot)).toBe(400000)
  })

  it('has nothing to draw without a lending item', () => {
    const { snapshot, walk } = world()
    expect(lendingModel(snapshot, walk, plan())).toBeNull()
  })
})

describe('the projection', () => {
  const one: Injection[] = [{ day: '2027-01-01', minor: 500000, item_id: 'x', name: 'x', grows: false }]

  it('grows a loan 20% a round with no losses', () => {
    const p = project(one, '2027-01-01', 15, 600000)
    expect(p.lossless.values[ROUND_DAYS]).toBeCloseTo(500000 * 1.2, 0)
    expect(p.lossless.values[2 * ROUND_DAYS]).toBeCloseTo(500000 * 1.2 ** 2, 0)
    expect(p.buffered.values[ROUND_DAYS]).toBeCloseTo(500000 * roundGrowth(15), 0)
  })

  it('reaches the goal when the book pays it each month, later with the loss buffer', () => {
    const p = project(one, '2027-01-01', 15, 600000)
    expect(p.lossless.target).toBe(Math.round(600000 / monthlyYield(0)))
    expect(p.buffered.target).toBe(Math.round(600000 / monthlyYield(15)))
    const { lossless, buffered } = p
    if (!lossless.goal_day || !buffered.goal_day) throw new Error('no goal day')
    expect(lossless.goal_day < buffered.goal_day).toBe(true)
    // The day before the goal is under the target and the goal day is at or over it.
    const at = (day: string) => buffered.values[Math.round((Date.parse(day) - Date.parse(p.start)) / 86400000)] ?? NaN
    expect(at(addDays(buffered.goal_day, -1))).toBeLessThan(buffered.target)
    expect(at(buffered.goal_day)).toBeGreaterThanOrEqual(buffered.target)
    // The view runs five years past it, and the book keeps growing: every round is relent.
    expect(p.end).toBe(addMonths(buffered.goal_day, YEARS_PAST_GOAL * 12))
    expect(buffered.values.at(-1)).toBeGreaterThan(at(buffered.goal_day) * roundGrowth(15) ** 10)
  })

  it('adds money put in after the goal to the book', () => {
    const goal = project(one, '2027-01-01', 15, 600000).buffered.goal_day
    if (!goal) throw new Error('no goal day')
    const later: Injection = { day: addMonths(goal, 12), minor: 100000, item_id: 'y', name: 'y', grows: false }
    const [without, withIt] = [project(one, '2027-01-01', 15, 600000), project([...one, later], '2027-01-01', 15, 600000)]
    expect(withIt.buffered.goal_day).toBe(goal)
    expect(withIt.end).toBe(without.end)
    expect((withIt.buffered.values.at(-1) ?? 0) - (without.buffered.values.at(-1) ?? 0)).toBeGreaterThan(100000)
  })

  it('keeps every day in whole minor units, as the chart needs', () => {
    const p = project(one, '2027-01-01', 15, 600000)
    expect(p.buffered.values.every(Number.isInteger)).toBe(true)
    expect(p.lossless.values.every(Number.isInteger)).toBe(true)
  })

  it('says the goal is out of reach with no income to replace', () => {
    const p = project(one, '2027-01-01', 15, 0)
    expect(p.buffered.goal_day).toBeNull()
  })
})

describe('the schedule', () => {
  it('lists each loan, each round back to relend, the milestones and the goal, month by month, and carries on past the goal', () => {
    const { snapshot, walk } = world(twoLoans)
    const m = lendingModel(snapshot, walk, plan())
    if (!m) throw new Error('no model')
    const flat = m.months.flatMap((mo) => mo.lines)
    expect(flat[0]).toMatchObject({ kind: 'lend', day: '2029-04-01', minor: 500000, name: 'loan 1 out' })
    const firstBack = flat.find((l) => l.kind === 'relend')
    expect(firstBack).toMatchObject({ kind: 'relend', day: addDays('2029-04-01', ROUND_DAYS), minor: Math.round(500000 * roundGrowth(15)), loans: 1 })
    expect(flat.filter((l) => l.kind === 'milestone').map((l) => (l.kind === 'milestone' ? l.share : 0))).toEqual([0.25, 0.5, 0.75])
    const goal = flat.find((l) => l.kind === 'goal')
    if (goal?.kind !== 'goal') throw new Error('no goal line')
    expect(goal.monthly_minor).toBeGreaterThanOrEqual(400000)
    // Rounds keep coming back to relend after the goal, up to the end of the view.
    const after = flat.filter((l) => l.day > goal.day)
    expect(after.some((l) => l.kind === 'relend')).toBe(true)
    expect(after.every((l) => l.day <= m.projection.end)).toBe(true)
    expect(m.months.every((mo) => mo.lines.every((l) => l.day.startsWith(mo.month)))).toBe(true)
  })

  it('brings the goal closer with a monthly top-up after the last debt', () => {
    const { snapshot, walk } = world(twoLoans)
    const none = lendingModel(snapshot, walk, plan())
    const some = lendingModel(snapshot, walk, plan({ topup: 1000 }))
    const [a, b] = [none?.projection.buffered.goal_day, some?.projection.buffered.goal_day]
    if (!a || !b) throw new Error('no goal day')
    expect(b < a).toBe(true)
    expect(some?.months.flatMap((mo) => mo.lines).some((l) => l.kind === 'topup' && l.minor === 100000)).toBe(true)
    // The top-up carries on after the goal.
    expect(some?.months.flatMap((mo) => mo.lines).some((l) => l.kind === 'topup' && l.day > b)).toBe(true)
  })

  it('leaves out rounds and money in before today', () => {
    const injections: Injection[] = [{ day: '2026-01-01', minor: 100000, item_id: 'old', name: 'old', grows: false }]
    const p = project(injections, AS_OF, 0, 4000)
    const months = schedule(injections, p, AS_OF, 0)
    expect(months.flatMap((mo) => mo.lines).every((l) => l.day >= AS_OF)).toBe(true)
  })
})

describe('the choices in the address', () => {
  it('keeps a number inside its range and on its step, and falls back for anything else', () => {
    expect(readNumber('25', RANGES.loss, 15)).toBe(25)
    expect(readNumber('99', RANGES.loss, 15)).toBe(30)
    expect(readNumber('-4', RANGES.loss, 15)).toBe(0)
    expect(readNumber('nope', RANGES.loss, 15)).toBe(15)
    expect(readNumber(undefined, RANGES.topup, 0)).toBe(0)
    expect(readNumber(['1040'], RANGES.topup, 0)).toBe(1000)
  })

  it('reads every control, with the plan income when no goal is given', () => {
    expect(readInputs({})).toEqual({ loss: 15, topup: 0, goal: null, rate: 20, growth: 3 })
    expect(readInputs({ loss: '5', topup: '500', goal: '4500', rate: '18', growth: '2.5' })).toEqual({ loss: 5, topup: 500, goal: 4500, rate: 18, growth: 2.5 })
  })

  it('stretches the income slider past an income above its usual top', () => {
    expect(goalRange(600000).max).toBe(10000)
    expect(goalRange(1250000).max).toBe(13000)
  })
})

describe('the what-ifs', () => {
  it('reaches a smaller income sooner, and a better return sooner', () => {
    const { snapshot, walk } = world(twoLoans)
    const base = lendingModel(snapshot, walk, plan())?.projection.buffered.goal_day
    const smaller = lendingModel(snapshot, walk, plan({ goal: 2000 }))
    const better = lendingModel(snapshot, walk, plan({ rate: 25 }))?.projection.buffered.goal_day
    if (!base || !smaller?.projection.buffered.goal_day || !better) throw new Error('no goal day')
    expect(smaller.goal_minor).toBe(200000)
    expect(smaller.plan_goal_minor).toBe(400000)
    expect(smaller.projection.buffered.goal_day < base).toBe(true)
    expect(better < base).toBe(true)
  })

  it('never reaches the goal when losses outrun the return', () => {
    const { snapshot, walk } = world(twoLoans)
    const m = lendingModel(snapshot, walk, plan({ loss: 30, rate: 10 }))
    expect(m?.projection.buffered.goal_day).toBeNull()
    expect(m?.growth.growth.every((g) => g === 0)).toBe(true)
    expect(m?.growth.pays.every((v) => v === 0)).toBe(true)
  })
})

describe('the schedule table', () => {
  it('rolls the months into years that add up, with the book and what it pays at each end', () => {
    const { snapshot, walk } = world(twoLoans)
    const m = lendingModel(snapshot, walk, plan())
    if (!m) throw new Error('no model')
    const first = m.years[0]
    expect(first?.key).toBe('2029')
    expect(first?.put_in_minor).toBe(1000000)
    for (const y of m.years) {
      expect(y.put_in_minor).toBe(y.months.reduce((s, mo) => s + mo.put_in_minor, 0))
      expect(y.back_minor).toBe(y.months.reduce((s, mo) => s + mo.back_minor, 0))
      expect(y.months.every((mo) => mo.key.startsWith(y.key))).toBe(true)
      expect(y.pays_minor).toBe(Math.round(y.book_minor * monthlyYield(15)))
    }
    // One year holds the goal and its book pays the income; the table runs on to the year the view ends, still growing.
    const at = m.years.findIndex((y) => y.lines.some((l) => l.kind === 'goal'))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(m.years[at]?.pays_minor).toBeGreaterThanOrEqual(m.goal_minor)
    expect(Number(m.years.at(-1)?.key)).toBeGreaterThanOrEqual(Number(m.years[at]?.key) + YEARS_PAST_GOAL - 1)
    for (let i = at + 1; i < m.years.length; i++) expect(m.years[i]?.book_minor).toBeGreaterThan(m.years[i - 1]?.book_minor ?? 0)
  })
})

describe('a month in the table', () => {
  it('merges rounds coming back on several days into one line, and leaves a single one alone', () => {
    const one = monthLines([
      { kind: 'topup', day: '2030-01-01', minor: 50000 },
      { kind: 'relend', day: '2030-01-02', minor: 80500, loans: 1 },
    ])
    expect(one.map((l) => l.kind)).toEqual(['topup', 'relend'])
    const many = monthLines([
      { kind: 'topup', day: '2030-01-01', minor: 50000 },
      { kind: 'relend', day: '2030-01-02', minor: 80500, loans: 1 },
      { kind: 'relend', day: '2030-01-14', minor: 788500, loans: 2 },
      { kind: 'milestone', day: '2030-01-20', share: 0.25, monthly_minor: 1000 },
      { kind: 'relend', day: '2030-01-31', minor: 63400, loans: 1 },
    ])
    expect(many).toEqual([
      { kind: 'topup', day: '2030-01-01', minor: 50000 },
      { kind: 'relends', day: '2030-01-02', last: '2030-01-31', minor: 932400, loans: 4 },
      { kind: 'milestone', day: '2030-01-20', share: 0.25, monthly_minor: 1000 },
    ])
  })
})

describe('the growth chart', () => {
  it('splits the book into money put in and growth, from today to each month end', () => {
    const { snapshot, walk } = world(twoLoans)
    const m = lendingModel(snapshot, walk, plan())
    if (!m) throw new Error('no model')
    const g = m.growth
    expect(g.days[0]).toBe(AS_OF)
    expect(g.days[1]).toBe('2026-11-30')
    expect(g.days.length).toBe(g.put_in.length)
    // After both loans the money put in is €10,000 and the rest is growth.
    const i = g.days.indexOf('2030-12-31')
    expect(g.put_in[i]).toBe(1000000)
    expect((g.put_in[i] ?? 0) + (g.growth[i] ?? 0)).toBe(m.projection.buffered.values[Math.round((Date.parse('2030-12-31') - Date.parse(m.projection.start)) / 86400000)])
    expect([...g.put_in, ...g.growth, ...g.pays].every(Number.isInteger)).toBe(true)
    expect(g.pays[i]).toBe(Math.round(((g.put_in[i] ?? 0) + (g.growth[i] ?? 0)) * monthlyYield(15)))
  })

  it('keeps counting the money put in after the goal', () => {
    const { snapshot, walk } = world(twoLoans)
    const m = lendingModel(snapshot, walk, plan({ topup: 1000 }))
    const goal = m?.projection.buffered.goal_day
    if (!m || !goal) throw new Error('no goal day')
    const g = m.growth
    const at = g.days.findIndex((d) => d >= goal)
    expect(g.put_in.at(-1)).toBeGreaterThan(g.put_in[at] ?? Infinity)
    expect(m.put_in_minor).toBeLessThan(g.put_in.at(-1) ?? 0)
    // The chart ends where the table's last year does.
    expect(g.days.at(-1)).toBe(m.projection.end)
    expect((g.put_in.at(-1) ?? 0) + (g.growth.at(-1) ?? 0)).toBe(m.years.at(-1)?.book_minor)
  })
})

describe('salary growth', () => {
  // A monthly top-up from Dec 2029 on top of the two loans.
  const withTopUp = (doc: SampleDoc) => {
    twoLoans(doc)
    doc.plan_items.push({ id: 'top-up', kind: 'bill', name: 'Lending: monthly top-up', from_account_id: 'main', amount_minor: 100000, every: 'month', starts_on: '2029-12-01' })
  }

  it('raises the salary once each January after today', () => {
    expect(raiseBy(AS_OF, '2026-12-31', 3)).toBe(1)
    expect(raiseBy(AS_OF, '2027-01-01', 3)).toBeCloseTo(1.03, 10)
    expect(raiseBy(AS_OF, '2029-06-30', 3)).toBeCloseTo(1.03 ** 3, 10)
    expect(raiseBy(AS_OF, '2025-01-01', 3)).toBe(1)
    expect(raiseBy(AS_OF, '2040-01-01', 0)).toBe(1)
  })

  it('raises a top-up that repeats and leaves a one-off loan as planned', () => {
    const raised = withRaises(
      [
        { day: '2029-04-01', minor: 500000, item_id: 'loan', name: 'loan', grows: false },
        { day: '2029-12-01', minor: 100000, item_id: 'top', name: 'top', grows: true },
      ],
      AS_OF,
      3,
    )
    expect(raised.map((i) => i.minor)).toEqual([500000, Math.round(100000 * 1.03 ** 3)])
  })

  it('grows the monthly top-up from the plan each January, and puts more in each year', () => {
    const { snapshot, walk } = world(withTopUp)
    const m = lendingModel(snapshot, walk, plan({ growth: 3 }))
    if (!m) throw new Error('no model')
    const lends = m.months.flatMap((mo) => mo.lines).filter((l) => l.kind === 'lend')
    const on = (day: string) => lends.find((l) => l.day === day)?.minor
    expect(on('2029-04-01')).toBe(500000)
    expect(on('2029-12-01')).toBe(Math.round(100000 * 1.03 ** 3))
    expect(on('2030-01-01')).toBe(Math.round(100000 * 1.03 ** 4))
    const put = (year: string) => m.years.find((y) => y.key === year)?.put_in_minor ?? 0
    expect(put('2031')).toBeGreaterThan(put('2030'))
  })

  it('moves the goal to the month the book pays the salary as it is then', () => {
    const { snapshot, walk } = world(twoLoans)
    const flat = lendingModel(snapshot, walk, plan())
    const raised = lendingModel(snapshot, walk, plan({ growth: 3 }))
    const [a, b] = [flat?.projection.buffered.goal_day, raised?.projection.buffered.goal_day]
    if (!raised || !a || !b) throw new Error('no goal day')
    expect(b > a).toBe(true)
    const n = Number(b.slice(0, 4)) - Number(AS_OF.slice(0, 4))
    expect(raised.goal_then_minor).toBe(Math.round(raised.goal_minor * 1.03 ** n))
    expect(Math.abs(raised.projection.buffered.target - raised.projection.buffered.base_target * 1.03 ** n)).toBeLessThanOrEqual(1)
    const goal = raised.months.flatMap((mo) => mo.lines).find((l) => l.kind === 'goal')
    if (goal?.kind !== 'goal') throw new Error('no goal line')
    expect(goal.monthly_minor).toBeGreaterThanOrEqual(raised.goal_then_minor - 1)
  })

  it('marks a share of the way against the salary as it is on the day', () => {
    const { snapshot, walk } = world(twoLoans)
    const m = lendingModel(snapshot, walk, plan({ growth: 3 }))
    if (!m) throw new Error('no model')
    const p = m.projection
    for (const l of m.months.flatMap((mo) => mo.lines)) {
      if (l.kind !== 'milestone') continue
      const i = Math.round((Date.parse(l.day) - Date.parse(p.start)) / 86400000)
      expect(p.buffered.values[i]).toBeGreaterThanOrEqual(l.share * p.buffered.base_target * raiseBy(AS_OF, l.day, 3))
      expect(p.buffered.values[i - 1]).toBeLessThan(l.share * p.buffered.base_target * raiseBy(AS_OF, addDays(l.day, -1), 3))
    }
  })
})
