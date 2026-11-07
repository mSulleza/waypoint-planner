import { applyPatch, buildSnapshot, fxBreakeven, installmentProgress, monthsMoneyLasts, runEngine, walkMetrics, type CompareRow, type PlanItem, type Snapshot, type Walk } from '@waypoint/core'
import { compare } from '@waypoint/core/compare'
import { abroad, mortgage, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { markSize } from '@waypoint/core/fixtures/mark-size'
import { describe, expect, it } from 'vitest'
import { debtsModel } from '../debts/debts.model'
import { ended, fxView, GROUP_NOTES, groupHeading, ITEM_GROUPS, itemRows, itemSeries, lastsView, NEW_ITEM, ordinal, planHeadline, planList, scheduleWords, stepMonths, stepsOf, type ItemGroup, type ItemRow } from './plan.model'

const AS_OF = '2026-10-07'

function world(build: (asOf: string) => Sample, edit?: (doc: SampleDoc) => void): { snapshot: Snapshot; walk: Walk } {
  const sample = build(AS_OF)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, AS_OF, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return { snapshot, walk: run.walk }
}

async function baseline(snapshot: Snapshot): Promise<CompareRow> {
  const first = (await compare(snapshot, [], { pause: () => Promise.resolve() }).next()).value
  if (!first?.ok) throw new Error('the baseline did not run')
  return first
}

const lines = (snapshot: Snapshot, walk: Walk) => planHeadline(snapshot, walk).cash.flatMap((g) => g.accounts)

describe('Plan headline', () => {
  it('shows the FX margin and breakeven rate of core fxBreakeven on abroad', async () => {
    const { snapshot } = world(abroad)
    const result = await fxBreakeven(snapshot)
    if (!result?.ok) throw new Error('abroad has a breakeven')
    const fx = fxView(result)
    if (fx.state !== 'ready') throw new Error(`fx is ${fx.state}`)
    // The euro can lose 31.1% before Pesos ends a day below zero on 22 Oct: €1 = ₱48.23 against ₱70.00 today.
    expect([fx.margin, fx.below_range, fx.funding_currency]).toEqual([result.margin, result.below_range, result.funding_currency])
    expect(fx.margin).toBe(0.311)
    expect(fx.pairs).toEqual([{ from: 'EUR', to: 'PHP', unit_minor: 100, today_minor: 7000, breakeven_minor: 4823 }])
    expect(fx.pairs[0]?.breakeven_minor).toBe(Math.round((result.rates[0]?.breakeven ?? 0) * 100))
    expect(fx.binding).toEqual({ account_id: 'pesos', date: '2026-10-22' })
    expect(fx.rate_independent).toEqual([])
  })

  it('lists the days below zero at any rate apart, and says Calculating until the breakeven is back', async () => {
    const { snapshot } = world(markSize)
    const result = await fxBreakeven(snapshot)
    const fx = fxView(result)
    if (fx.state !== 'ready') throw new Error(`fx is ${fx.state}`)
    // Pesos is below zero on 12 days from 16 Oct even at m = 1.5, so the margin leaves them out and 0.5 already holds.
    expect([fx.below_range, fx.margin, fx.binding]).toEqual([true, 0.5, null])
    expect(fx.rate_independent).toEqual([{ account_id: 'pesos', date: '2026-10-16', days: 12 }])
    expect(fxView(undefined)).toEqual({ state: 'calculating' })
    expect(fxView(new Error('The breakeven search needs more than 14 walks'))).toEqual({ state: 'failed', message: 'The breakeven search needs more than 14 walks' })
  })

  it('shows no FX row in a one-currency household', async () => {
    for (const build of [usCardsCar, mortgage]) {
      const { snapshot } = world(build)
      const result = await fxBreakeven(snapshot)
      expect(result).toBeNull()
      expect(fxView(result)).toEqual({ state: 'none' })
    }
  })

  it('gives each cash account the lowest balance and days under floor that the engine and Compare count', async () => {
    for (const build of [abroad, usCardsCar, mortgage, markSize]) {
      const { snapshot, walk } = world(build)
      const metrics = walkMetrics(snapshot, walk)
      // Grouped by currency on screen, so compared by account.
      const shown = lines(snapshot, walk).sort((a, b) => (a.account_id < b.account_id ? -1 : 1))
      const byId = <T extends { account_id: string }>(list: readonly T[]) => [...list].sort((a, b) => (a.account_id < b.account_id ? -1 : 1))
      expect(shown.map((a) => [a.account_id, a.lowest_minor, a.lowest_on, a.days_under_floor])).toEqual(byId(metrics.cash).map((c) => [c.account_id, c.lowest_minor, c.lowest_on, c.days_under_floor]))
      // Compare sums the same per-account days over the household and reads the same lowest balances.
      const base = await baseline(snapshot)
      expect(shown.reduce((sum, a) => sum + a.days_under_floor, 0)).toBe(base.days_under_floor)
      expect(shown.map((a) => [a.account_id, a.lowest_minor, a.lowest_on])).toEqual(byId(base.lowest_by_account).map((l) => [l.account_id, l.lowest_minor, l.lowest_on]))
    }
    // abroad: Main runs 11 days under its floor and Pesos 12; Tax has no floor, so it has no sentence.
    const { snapshot, walk } = world(abroad)
    const abroadLines = lines(snapshot, walk)
    expect(abroadLines.map((a) => [a.account_id, a.days_under_floor, a.floor === null])).toEqual([
      ['main', 11, false],
      ['tax', 0, true],
      ['pesos', 12, false],
    ])
    expect(planHeadline(snapshot, walk).cash.map((g) => g.currency)).toEqual(['EUR', 'PHP'])
    expect(abroadLines.find((a) => a.account_id === 'pesos')?.floor).toEqual([{ money: { minor: 2000000, currency: 'PHP' } }, { text: ' from ' }, { month: '2026-10' }])
  })

  it('reads the debt-free month from the engine, the same one Debts leads with (rule 139)', () => {
    for (const build of [abroad, usCardsCar, mortgage, markSize]) {
      const { snapshot, walk } = world(build)
      const head = planHeadline(snapshot, walk)
      const debtFree = walkMetrics(snapshot, walk).debt_free
      expect(head.debt_free.value).toEqual(debtFree.month === null ? expect.any(Array) : [{ month: debtFree.month }])
      expect(head.debt_free).toEqual(debtsModel(snapshot, walk)?.headline)
    }
    expect(planHeadline(world(usCardsCar).snapshot, world(usCardsCar).walk).debt_free.value).toEqual([{ month: '2030-01' }])
    // A household with no cards or loans is debt-free now and says why.
    const cashOnly = world(usCardsCar, (doc) => {
      doc.accounts = doc.accounts.filter((a) => a.kind === 'cash')
      doc.plan_items = doc.plan_items.filter((p) => p.kind !== 'transfer')
      doc.statements = []
      doc.transactions = doc.transactions.filter((t) => doc.accounts.some((a) => a.id === t.account_id) && t.transfer_id === null)
    })
    expect(planHeadline(cashOnly.snapshot, cashOnly.walk).debt_free).toEqual({ label: 'Debt-free', value: [{ text: 'Now' }], note: [{ text: 'No cards or loans.' }] })
  })

  it('shows months the money lasts if income stops as core monthsMoneyLasts counts them', () => {
    const { snapshot } = world(abroad)
    // With no income from November 2026 and every floor spent, Main ends 11 May 2027 below zero: 6 months.
    expect(lastsView(monthsMoneyLasts(snapshot), AS_OF, '2031-10')).toEqual({ state: 'ready', months: 6, account_id: 'main', date: '2027-05-11', from_month: '2026-11' })
    expect(lastsView(null, AS_OF, '2031-10')).toEqual({ state: 'through', months: 60, from_month: '2026-11', horizon_month: '2031-10' })
    expect(lastsView(undefined, AS_OF, '2031-10')).toEqual({ state: 'calculating' })
  })
})

describe('Plan items', () => {
  // Each group and its rows' plan item ids, every step of a series included.
  const groupsOf = (snapshot: Snapshot, walk: Walk, pastOpen = false) =>
    planList(itemRows(snapshot, walk), 'en-IE', pastOpen).reduce<[ItemGroup, string[]][]>((out, entry) => {
      if (entry.type === 'group') out.push([entry.group, []])
      else if (entry.type === 'past') out.push(['past', []])
      else out.at(-1)?.[1].push(...entry.row.steps.map((s) => s.id))
      return out
    }, [])

  it('lists every item once, by kind in a fixed order with upsides and Past last, each group by its next date', () => {
    const { snapshot, walk } = world(abroad)
    // Income: the friend repays on 17 Oct, the loan lands on 18 Oct, salary on the 28th. Groceries credit moved on 1 Oct, so it leads its group.
    expect(groupsOf(snapshot, walk)).toEqual([
      ['income', ['receivable', 'cash-loan-draw', 'salary']],
      ['bills', ['mobile', 'insurance', 'rent', 'streaming']],
      ['budgets', ['groceries-credit', 'groceries']],
      ['transfers', ['tax-set-aside']],
      ['installments', ['laptop', 'conversion', 'cash-loan']],
      ['upsides', ['camera-sale']],
    ])
    const on = new Map(itemRows(snapshot, walk).map((r) => [r.item.id, r.on]))
    // An installment bills at its card's cut: the 20th on the rewards card, the 25th on the shopping card.
    expect(['receivable', 'cash-loan-draw', 'salary', 'mobile', 'rent', 'groceries-credit', 'laptop', 'conversion', 'cash-loan'].map((id) => on.get(id))).toEqual([
      '2026-10-17',
      '2026-10-18',
      '2026-10-28',
      '2026-10-10',
      '2026-11-01',
      '2026-10-01',
      '2026-10-20',
      '2026-10-25',
      '2026-11-25',
    ])
    const large = world(markSize)
    const listed = groupsOf(large.snapshot, large.walk, true)
    expect(listed.flatMap(([, ids]) => ids).sort()).toEqual(large.snapshot.doc.plan_items.map((p) => p.id).sort())
    expect(listed.map(([g]) => g)).toEqual(ITEM_GROUPS.filter((g) => listed.some(([found]) => found === g)))
    expect(listed.at(-1)?.[0]).toBe('past')
    for (const id of listed.find(([g]) => g === 'past')?.[1] ?? []) expect(ended(large.snapshot.doc.plan_items.find((p) => p.id === id) as PlanItem, AS_OF)).toBe(true)
  })

  it('heads every group with its count, and keeps Past closed behind one row until it is opened', () => {
    const { snapshot, walk } = world(abroad, (doc) => {
      doc.plan_items.push(
        { id: 'flight', kind: 'bill', name: 'Flight', from_account_id: 'main', amount_minor: 30000, every: 'once', starts_on: '2026-08-14' },
        { id: 'deposit', kind: 'bill', name: 'Deposit', from_account_id: 'main', amount_minor: 90000, every: 'once', starts_on: '2026-09-02' },
        { id: 'old-phone', kind: 'installment', name: 'Old phone', from_account_id: 'rewards-card', amount_minor: 100000, starts_on: '2026-04-01', ends_on: '2026-09-01' },
      )
    })
    const rows = itemRows(snapshot, walk)
    const closed = planList(rows, 'en-IE')
    expect(closed.filter((e) => e.type !== 'item').map((e) => (e.type === 'past' ? ['past', e.count, e.open] : e.type === 'group' ? [e.group, e.count] : []))).toEqual([
      ['income', 3],
      ['bills', 4],
      ['budgets', 2],
      ['transfers', 1],
      ['installments', 3],
      ['upsides', 1],
      ['past', 3, false],
    ])
    expect(closed.at(-1)).toEqual({ type: 'past', key: 'group:past', count: 3, open: false })
    expect(closed.filter((e) => e.type === 'item')).toHaveLength(14)
    // Open, Past lists what happened last first: the phone's last bill on 20 Sep, the deposit on 2 Sep, the flight in August.
    const open = planList(rows, 'en-IE', true)
    expect(open.slice(closed.length).map((e) => (e.type === 'item' ? [e.row.item.id, e.row.on, e.first, e.last] : e.type))).toEqual([
      ['old-phone', '2026-09-20', true, false],
      ['deposit', '2026-09-02', false, false],
      ['flight', '2026-08-14', false, true],
    ])
    expect([groupHeading('past', 3), groupHeading('income', 12), GROUP_NOTES.past]).toEqual(['Past · 3', 'Income · 12', 'Already happened. Kept so past months still add up.'])
  })

  it('gives each item its amount in the account it is counted on, its accounts in words, its chips and its editor', () => {
    const { snapshot, walk } = world(abroad)
    const rows = new Map(itemRows(snapshot, walk).map((r) => [r.item.id, r]))
    expect(rows.get('salary')?.amount).toEqual({ minor: 400000, currency: 'EUR' })
    expect(rows.get('salary')?.route).toEqual([{ text: 'into ' }, { account: 'main' }])
    expect(rows.get('streaming')?.route).toEqual([{ text: 'on ' }, { account: 'rewards-card' }])
    expect(rows.get('tax-set-aside')?.route).toEqual([{ account: 'main' }, { text: ' → ' }, { account: 'tax' }])
    expect([rows.get('insurance')?.chips, rows.get('camera-sale')?.chips, rows.get('rent')?.chips]).toEqual([['Estimated'], ['Upside'], []])
    expect(rows.get('rent')?.link).toEqual({ pathname: '/plan/item/[id]', params: { id: 'rent' } })
    expect(NEW_ITEM).toEqual({ pathname: '/plan/item/[id]', params: { id: 'new' } })
    // A transfer into a debt names the account that pays it; extra for debts goes to the debts in payoff order.
    const mortgageRows = itemRows(world(mortgage).snapshot, world(mortgage).walk)
    expect(mortgageRows.find((r) => r.item.kind === 'transfer')?.route).toEqual([{ account: 'current' }, { text: ' → ' }, { account: 'mortgage' }])
    const us = world(usCardsCar)
    expect(itemRows(us.snapshot, us.walk).find((r) => r.item.kind === 'transfer')?.route).toEqual([{ account: 'checking' }, { text: ' → debts, in payoff order' }])
  })

  it('counts an installment n of N as the card statements bill it', () => {
    const { snapshot, walk } = world(abroad)
    const rows = new Map(itemRows(snapshot, walk).map((r) => [r.item.id, r]))
    for (const card of ['rewards-card', 'shopping-card']) {
      for (const p of installmentProgress(snapshot, walk, card)) expect(rows.get(p.plan_item_id)?.progress).toEqual({ billed: p.billed, total: p.total })
    }
    // The laptop bills June to May: four statements so far, of 12.
    expect(rows.get('laptop')?.progress).toEqual({ billed: 4, total: 12 })
    expect(rows.get('salary')?.progress).toBeNull()
  })

  it('says each schedule in words, with the weekend rule, the start and the end', () => {
    const at = (fields: Partial<PlanItem>) => scheduleWords({ id: 'x', kind: 'bill', name: 'X', from_account_id: 'main', to_account_id: null, category_id: null, amount_minor: 100, every: 'month', starts_on: '2026-09-25', ends_on: null, roll: 'none', confidence: 'committed', stops_with_income: false, skip_periods: [], ...fields }, AS_OF, 'en-IE')
    expect(at({})).toBe('Monthly on the 25th')
    expect(at({ roll: 'preceding' })).toBe('Monthly on the 25th, or the Friday before a weekend')
    expect(at({ starts_on: '2026-08-31' })).toBe('Monthly on the 31st or the month’s last day')
    expect(at({ starts_on: '2026-11-03', ends_on: '2027-06-30' })).toBe('Monthly on the 3rd, from 3 Nov, until 30 Jun 2027')
    expect(at({ ends_on: '2026-09-30' })).toBe('Monthly on the 25th, ended 30 Sept')
    // A weekday never rolls; Friday 2 Oct 2026 every two weeks.
    expect(at({ every: '2weeks', starts_on: '2026-10-02', roll: 'following' })).toBe('Every 2 weeks on Friday')
    expect(at({ every: 'week', starts_on: '2026-10-03', roll: 'following' })).toBe('Weekly on Saturday, or the Monday after a weekend')
    expect(at({ every: 'year', starts_on: '2027-03-15' })).toBe('Yearly on 15 March, from 15 Mar 2027')
    // Every 3 months names its four months in calendar order, from whichever one it starts in.
    expect(at({ every: 'quarter', starts_on: '2026-10-15', roll: 'preceding' })).toBe('Every 3 months on the 15th of Jan, Apr, Jul and Oct, or the Friday before a weekend, from 15 Oct')
    expect(at({ kind: 'income', from_account_id: null, to_account_id: 'main', every: 'quarter', starts_on: '2026-08-31', ends_on: '2027-12-31' })).toBe('Every 3 months on the 31st of Feb, May, Aug and Nov, or the month’s last day, until 31 Dec 2027')
    expect(at({ every: 'once', starts_on: '2026-10-19' })).toBe('Once on 19 Oct')
    expect(at({ kind: 'allowance', category_id: 'c', starts_on: '2026-09-01' })).toBe('Monthly')
    expect(at({ kind: 'installment', starts_on: '2026-06-01', ends_on: '2027-05-01' })).toBe('Monthly, June 2026 to May 2027')
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st'])
  })
})

describe('Stepped items', () => {
  // The rows split_plan_item leaves, made by core's own copy of it (applyPatch).
  function split(base: { snapshot: Snapshot }, items: Record<string, { amount_minor: number; from_month: string }>): { snapshot: Snapshot; walk: Walk } {
    const patched = applyPatch(base.snapshot, { items })
    if (!patched.ok) throw new Error(patched.errors.join('; '))
    const run = runEngine(patched.value.snapshot)
    if (!run.ok) throw new Error('the engine did not run')
    return { snapshot: patched.value.snapshot, walk: run.walk }
  }
  const rowOf = (rows: readonly ItemRow[], id: string) => rows.find((r) => r.steps.some((s) => s.id === id))

  it('shows a series split from a later month as one row at today’s amount, with the change to come', () => {
    const once = split(world(abroad), { 'tax-set-aside': { amount_minor: 70000, from_month: '2027-01' } })
    const twice = split(once, { 'tax-set-aside@2027-01': { amount_minor: 75000, from_month: '2028-01' } })
    const rows = itemRows(twice.snapshot, twice.walk)
    expect(rows.filter((r) => r.item.name === 'Tax set-aside')).toHaveLength(1)
    const row = rowOf(rows, 'tax-set-aside') as ItemRow
    expect(row.steps.map((s) => [s.id, s.amount_minor, s.starts_on, s.ends_on])).toEqual([
      ['tax-set-aside', 60000, '2026-09-28', '2026-12-31'],
      ['tax-set-aside@2027-01', 70000, '2027-01-28', '2027-12-31'],
      ['tax-set-aside@2027-01@2028-01', 75000, '2028-01-28', null],
    ])
    // The row edits the step that covers October, and its schedule runs to the last step's end: none.
    expect([row.item.id, row.group, row.amount, row.ends_on, row.on, row.link]).toEqual(['tax-set-aside', 'transfers', { minor: 60000, currency: 'EUR' }, null, '2026-10-28', { pathname: '/plan/item/[id]', params: { id: 'tax-set-aside' } }])
    expect(scheduleWords({ ...row.item, ends_on: row.ends_on }, AS_OF, 'en-IE')).toBe('Monthly on the 28th')
    expect(row.change).toEqual([{ text: 'Changes to ' }, { money: { minor: 70000, currency: 'EUR' } }, { text: ' from ' }, { month: '2027-01' }])
    expect(row.earlier).toBeNull()
    // The editor lists every step, each opening its own row.
    expect(stepsOf(twice.snapshot.doc.plan_items, 'tax-set-aside@2027-01')?.map((s) => s.id)).toEqual(['tax-set-aside', 'tax-set-aside@2027-01', 'tax-set-aside@2027-01@2028-01'])
    expect(stepsOf(twice.snapshot.doc.plan_items, 'rent')).toBeNull()
    expect(row.steps.map((s) => stepMonths(s, 'en-IE'))).toEqual(['September 2026 to December 2026', 'January 2027 to December 2027', 'From January 2028'])
  })

  it('keeps the old step inside the row, not in Past, once the change has happened', () => {
    const { snapshot, walk } = split(world(abroad), { 'tax-set-aside': { amount_minor: 70000, from_month: '2026-10' } })
    const rows = itemRows(snapshot, walk)
    expect(ended(snapshot.doc.plan_items.find((p) => p.id === 'tax-set-aside') as PlanItem, AS_OF)).toBe(true)
    expect(rows.filter((r) => r.group === 'past')).toEqual([])
    const row = rowOf(rows, 'tax-set-aside') as ItemRow
    // September's €600 stays in the row; October on is €700, the row's amount and editor.
    expect([row.item.id, row.group, row.amount.minor]).toEqual(['tax-set-aside@2026-10', 'transfers', 70000])
    expect(row.change).toEqual([{ text: 'Changed from ' }, { money: { minor: 60000, currency: 'EUR' } }, { text: ' in ' }, { month: '2026-10' }])
    expect(row.earlier).toEqual([{ text: 'Earlier: ' }, { money: { minor: 60000, currency: 'EUR' } }, { text: ' in ' }, { month: '2026-09' }])
  })

  it('merges a series that has ended into one Past row, and names each earlier step’s months', () => {
    const { snapshot, walk } = world(abroad, (doc) => {
      doc.plan_items.push(
        { id: 'gym-1', kind: 'bill', name: 'Gym', from_account_id: 'main', amount_minor: 3000, starts_on: '2026-03-05', ends_on: '2026-05-31' },
        { id: 'gym-2', kind: 'bill', name: 'Gym', from_account_id: 'main', amount_minor: 3500, starts_on: '2026-06-05', ends_on: '2026-07-31' },
        { id: 'gym-3', kind: 'bill', name: 'Gym', from_account_id: 'main', amount_minor: 3500, starts_on: '2026-08-05', ends_on: '2026-09-30' },
      )
    })
    const past = itemRows(snapshot, walk).filter((r) => r.group === 'past')
    expect(past.map((r) => [r.item.id, r.steps.length, r.amount.minor, r.on])).toEqual([['gym-3', 3, 3500, '2026-09-05']])
    // gym-3 kept gym-2's amount, so the change named is the one into June.
    expect(past[0]?.change).toEqual([{ text: 'Changed from ' }, { money: { minor: 3000, currency: 'EUR' } }, { text: ' in ' }, { month: '2026-06' }])
    expect(past[0]?.earlier).toEqual([
      { text: 'Earlier: ' },
      { money: { minor: 3000, currency: 'EUR' } },
      { text: ' from ' },
      { month: '2026-03' },
      { text: ' to ' },
      { month: '2026-05' },
      { text: '; ' },
      { money: { minor: 3500, currency: 'EUR' } },
      { text: ' from ' },
      { month: '2026-06' },
      { text: ' to ' },
      { month: '2026-07' },
    ])
  })

  it('merges only rows with the same kind, name, accounts and category whose dates follow on', () => {
    const at = (fields: Partial<PlanItem>): PlanItem => ({ id: 'x', kind: 'bill', name: 'Gym', from_account_id: 'main', to_account_id: null, category_id: null, amount_minor: 3000, every: 'month', starts_on: '2026-01-05', ends_on: null, roll: 'none', confidence: 'committed', stops_with_income: false, skip_periods: [], ...fields })
    const ids = (items: PlanItem[]) => itemSeries(items).map((s) => s.map((p) => p.id))
    const first = at({ id: 'a', ends_on: '2026-05-31' })
    // A step starts at the old row's next occurrence, up to one period after its end: monthly, every 3 months, yearly, weekly, a billed month.
    expect(ids([at({ id: 'b', starts_on: '2026-06-05' }), first])).toEqual([['a', 'b']])
    expect(ids([at({ id: 'a', every: 'quarter', ends_on: '2026-04-30' }), at({ id: 'b', every: 'quarter', starts_on: '2026-07-05' })])).toEqual([['a', 'b']])
    expect(ids([at({ id: 'a', every: 'year', ends_on: '2026-01-31' }), at({ id: 'b', every: 'year', starts_on: '2027-01-05' })])).toEqual([['a', 'b']])
    expect(ids([at({ id: 'a', every: 'week', starts_on: '2026-01-05', ends_on: '2026-02-01' }), at({ id: 'b', every: 'week', starts_on: '2026-02-02' })])).toEqual([['a', 'b']])
    expect(ids([at({ id: 'a', kind: 'installment', from_account_id: 'rewards-card', starts_on: '2026-01-01', ends_on: '2026-05-01' }), at({ id: 'b', kind: 'installment', from_account_id: 'rewards-card', starts_on: '2026-06-01', ends_on: '2026-09-01' })])).toEqual([['a', 'b']])
    // An occurrence with nothing between, an overlap, another account, name or category, or a one-off before it: separate rows.
    expect(ids([first, at({ id: 'b', starts_on: '2026-07-05' })])).toEqual([['a'], ['b']])
    expect(ids([at({ id: 'a', every: 'quarter', ends_on: '2026-03-31' }), at({ id: 'b', every: 'quarter', starts_on: '2026-07-05' })])).toEqual([['a'], ['b']])
    expect(ids([first, at({ id: 'b', starts_on: '2026-05-05' })])).toEqual([['a'], ['b']])
    expect(ids([first, at({ id: 'b', starts_on: '2026-06-05', from_account_id: 'pesos' })])).toEqual([['a'], ['b']])
    expect(ids([first, at({ id: 'b', starts_on: '2026-06-05', name: 'Gym and pool' })])).toEqual([['a'], ['b']])
    expect(ids([at({ id: 'a', kind: 'allowance', category_id: 'cat-home', ends_on: '2026-05-31' }), at({ id: 'b', kind: 'allowance', category_id: 'cat-dining', starts_on: '2026-06-05' })])).toEqual([['a'], ['b']])
    expect(ids([at({ id: 'a', every: 'once', starts_on: '2026-12-28' }), at({ id: 'b', every: 'year', starts_on: '2027-12-28' })])).toEqual([['a'], ['b']])
  })
})
