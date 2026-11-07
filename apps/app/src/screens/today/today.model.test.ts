import { alerts, budgetRows, buildSnapshot, dropSameSubject, fxBreakeven, nextAction, plainNames, renderCopy, reviewList, runEngine, sameSubject, type FxBreakeven, type Snapshot, type Walk } from '@waypoint/core'
import { abroad, mortgage, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { dayTitle, nextLines, nextWhen, paceBar, RECORD_TRANSFER, routeLink, SECTIONS, todayModel, type TodayModel } from './today.model'

interface World {
  snapshot: Snapshot
  walk: Walk
  breakeven: FxBreakeven | null
  model: TodayModel
  say: (copy: Parameters<typeof renderCopy>[0]) => string
}

async function world(build: (asOf: string) => Sample, asOf: string, edit?: (doc: SampleDoc) => void): Promise<World> {
  const sample = build(asOf)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, asOf, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  const found = await fxBreakeven(snapshot)
  if (found !== null && !found.ok) throw new Error('the breakeven did not run')
  const names = plainNames(snapshot)
  return { snapshot, walk: run.walk, breakeven: found, model: todayModel({ snapshot, walk: run.walk, breakeven: found }), say: (copy) => renderCopy(copy, names) }
}

const DATES = ['2026-10-07', '2026-10-09', '2026-10-16', '2026-10-23'] as const
const FIXTURES = [abroad, usCardsCar, mortgage] as const

describe('the next action', () => {
  it('is core nextAction on abroad at every date, with one button opening the Add or Statement sheet prefilled', async () => {
    const seen: string[] = []
    for (const asOf of DATES) {
      const w = await world(abroad, asOf)
      expect(w.model.next.action).toEqual(nextAction({ snapshot: w.snapshot, walk: w.walk, review: reviewList(w.snapshot, w.walk) }))
      seen.push(w.model.next.action.kind)
    }
    expect(seen).toEqual(['send', 'send', 'send', 'enter_statement'])

    const send = await world(abroad, '2026-10-16')
    expect([send.say(send.model.next.action.title), send.model.next.button]).toEqual([
      'Send €437.50 → Pesos',
      { label: 'Record transfer', link: { pathname: '/add', params: { mode: 'move', from: 'main', to: 'pesos', amount: '43750' } } },
    ])
    // The hero says where the transfer is made and what it covers, and gives the later top-up a sentence of its own.
    expect([send.say(send.model.next.action.context), send.say(send.model.next.detail), send.say(send.model.next.later ?? [])]).toEqual([
      'and €104.87 more on 2026-10-28',
      'Make this transfer at your bank, then record it here. It arrives as ₱30,410.62 and covers the Rewards card payment today.',
      'Then €104.87 more on 2026-10-28.',
    ])
    const statement = await world(abroad, '2026-10-23')
    expect(statement.model.next.button).toEqual({ label: 'Enter statement', link: { pathname: '/statement', params: { account: 'rewards-card' } } })
    const quiet = await world(mortgage, '2026-10-09')
    expect([quiet.say(quiet.model.next.action.title), quiet.model.next.button]).toEqual(['Nothing to do now', null])
  })

  it('shows the month’s next top-up before its day, dated, with what it covers', async () => {
    const early = await world(abroad, '2026-10-10')
    expect([early.model.next.action.kind, early.model.next.when, early.say(early.model.next.action.title), early.say(early.model.next.detail), early.say(early.model.next.later ?? [])]).toEqual([
      'send',
      { late: false, by: '2026-10-16' },
      'Send €386.36 → Pesos',
      'Make this transfer at your bank, then record it here. It arrives as ₱26,855.88 and covers the Rewards card payment on 2026-10-16.',
      'Then €156.01 more on 2026-10-28.',
    ])
    expect(early.model.next.button).toEqual({ label: 'Record transfer', link: { pathname: '/add', params: { mode: 'move', from: 'main', to: 'pesos', amount: '38636' } } })
    // The hero states both top-ups, so the next 30 days leave them out and say which rows took them in.
    const lines = early.model.agenda.flatMap((d) => d.items)
    expect([lines.some((i) => i.title.some((p) => 'text' in p && p.text === 'Top-up')), lines.filter((i) => i.landed.length > 0).map((i) => i.date)]).toEqual([false, ['2026-10-16']])
  })

  it('marks a payment late once its due day has passed, and says which amount is which', async () => {
    const late = await world(usCardsCar, '2026-10-21')
    expect([late.model.next.when, late.say(late.model.next.action.title), late.say(late.model.next.detail)]).toEqual([{ late: true }, 'Pay $122.11 → Store card', 'The plan pays $122.11 of the $4,591.20 due. It was due 2026-10-18.'])
    const early = await world(usCardsCar, '2026-10-10')
    expect([early.model.next.when, early.say(early.model.next.detail)]).toEqual([{ late: false, by: '2026-10-16' }, 'The plan pays $80.00 of the $2,042.50 due. It is due 2026-10-16.'])
    expect(nextWhen({ ...early.model.next.action, act_by: null }, '2026-10-10')).toEqual({ late: false, by: null })
  })

  it('says Record transfer on a top-up, never Send, since the app moves no money', async () => {
    const labels = new Set<string>()
    for (const build of FIXTURES) for (const asOf of DATES) labels.add((await world(build, asOf)).model.next.button?.label ?? 'none')
    expect(RECORD_TRANSFER).toBe('Record transfer')
    expect([...labels].sort()).toEqual(['Enter statement', 'Record', 'Record payment', 'Record transfer', 'none'])
  })

  it('keeps any other action’s context as the line under its title, with no later line', async () => {
    const statement = await world(abroad, '2026-10-23')
    expect([statement.say(statement.model.next.detail), statement.model.next.later]).toEqual(['Rewards card cut on 2026-10-20; enter its statement before paying the bill due 2026-11-16.', null])
    const one = nextLines({ ...statement.model.next.action, kind: 'send', context: [{ text: '€1.00 more on ' }, { date: '2026-10-28' }] })
    expect([statement.say(one.later ?? []), statement.say(one.detail)]).toEqual(['€1.00 more on 2026-10-28', 'Make this transfer at your bank, then record it here.'])
  })

  it('pays a card with no amount in the address, so the sheet prefills left to pay itself', async () => {
    const w = await world(usCardsCar, '2026-10-18')
    expect([w.model.next.action.kind, w.say(w.model.next.action.title), w.model.next.button]).toEqual([
      'pay',
      'Pay $80.00 → Travel card',
      { label: 'Record payment', link: { pathname: '/add', params: { mode: 'move', from: 'checking', to: 'travel-card' } } },
    ])
  })

  it('records an overdue bill that comes first in review, linked to its occurrence', async () => {
    // Two days after the mobile bill's day, before any top-up, card pay day or cut.
    const w = await world(abroad, '2026-10-12')
    expect([w.model.next.action.kind, w.model.next.action.review_id, w.model.next.button]).toEqual([
      'review',
      'overdue_outflow:mobile:2026-10-01',
      { label: 'Record', link: { pathname: '/add', params: { plan_item_id: 'mobile', period: '2026-10-01' } } },
    ])
  })
})

describe('the sections', () => {
  it('keeps the sections in one fixed order, the alert line above every figure, on every sample and date', async () => {
    for (const build of FIXTURES) {
      for (const asOf of DATES) {
        const { model } = await world(build, asOf)
        const at = model.sections.map((s) => SECTIONS.indexOf(s))
        expect(at.every((i, k) => i >= 0 && (k === 0 || i > (at[k - 1] ?? -1)))).toBe(true)
        // The alert comes before every figure; only the next action, first in spec §7, may sit above it.
        const alertAt = model.sections.indexOf('alert')
        if (alertAt >= 0) expect((['cash', 'budgets', 'agenda'] as const).every((s) => !model.sections.includes(s) || model.sections.indexOf(s) > alertAt)).toBe(true)
        expect(alertAt >= 0).toBe(model.alert !== null)
        // 'Nothing to do now' never sits above an alert or an account that is not OK.
        if (model.sections.includes('next') && model.next.action.kind === 'none') expect([model.alert, model.cash.every((c) => c.word === 'OK')]).toEqual([null, true])
      }
    }
    const short = await world(abroad, '2026-10-09')
    expect([short.model.next.action.kind, short.model.sections[0], short.model.alert?.alert.title]).toEqual(['send', 'next', 'Cover a shortfall no top-up can fix'])
    const { model } = await world(abroad, '2026-10-16')
    expect(model.sections).toEqual(['next', 'alert', 'cash', 'budgets', 'agenda'])
  })

  it('shows what is due now and the live balances above "Add your income and bills" when the household has no plan items', async () => {
    const bare = (doc: SampleDoc) => {
      doc.plan_items = []
      doc.transactions = doc.transactions.map((t) => ({ ...t, plan_item_id: null, period: null }))
    }
    // The rewards statement still bills installments the plan no longer has, so checking it is due now.
    const due = await world(abroad, '2026-10-09', bare)
    expect([due.model.empty, due.model.sections, due.model.next.button]).toEqual([true, ['next', 'alert', 'cash'], { label: 'Check statement', link: { pathname: '/statement', params: { account: 'rewards-card' } } }])
    // With no salary planned, the mortgage payments run the current account dry by January.
    const quiet = await world(mortgage, '2026-10-09', bare)
    expect([quiet.model.empty, quiet.model.next.action.kind, quiet.model.sections, quiet.model.alert?.alert.id]).toEqual([true, 'none', ['alert', 'cash'], 'unfixable_gap:current:2027-01'])
  })
})

describe('the next 30 days', () => {
  it('says which row’s balance takes in a top-up listed only on the account it left, so each account’s balances add up row to row', async () => {
    const { model, walk } = await world(abroad, '2026-10-09')
    const items = model.agenda.flatMap((d) => d.items)
    const pesos = items.filter((i) => i.account_id === 'pesos')
    const payment = pesos.find((i) => i.date === '2026-10-16')
    if (!payment) throw new Error('expected the card payment on Oct 16')
    // The top-up itself is the hero's, so it is not listed again.
    expect(items.find((i) => i.date === '2026-10-16' && i.account_id === 'main' && i.to_account_id === 'pesos')).toBeUndefined()
    expect(payment.landed).toEqual([{ from_account_id: 'main', kind: 'top_up' }])
    // The row before it, less the payment, plus what landed, is the balance after it.
    const before = pesos[pesos.indexOf(payment) - 1]
    const landing = walk.lines.find((l) => l.source === 'top_up' && l.account_id === 'pesos' && l.date === '2026-10-16' && l.amount_minor > 0)
    expect(payment.after_minor - ((before?.after_minor ?? 0) + payment.amount_minor)).toBe(landing?.amount_minor)
    expect(items.filter((i) => i !== payment).every((i) => i.landed.length === 0)).toBe(true)
  })
})

describe('the alert line', () => {
  it('is never about the next action’s account and month when abroad needs a top-up, and counts the rest', async () => {
    // With September's mobile bill paid on time, the top-up's own account leads the alerts before the drop.
    const linked = await world(abroad, '2026-10-16', (doc) => {
      doc.transactions.push({ id: 'mobile-now', account_id: 'pesos', posted_on: '2026-10-10', amount_minor: -120000, kind: 'expense', plan_item_id: 'mobile', period: '2026-10-01' })
    })
    const plain = await world(abroad, '2026-10-16')
    for (const w of [linked, plain]) {
      const { snapshot, walk, breakeven, model } = w
      const review = reviewList(snapshot, walk)
      const all = alerts({ snapshot, walk, review, breakeven, budgets: budgetRows(snapshot) })
      const subject = model.next.action.subject
      if (!subject || !model.alert) throw new Error('expected a top-up and an alert')
      expect([model.next.action.kind, subject]).toEqual(['send', { account_id: 'pesos', month: '2026-10' }])
      expect(sameSubject(model.alert.alert.subject, subject)).toBe(false)
      const left = dropSameSubject(all, model.next.action)
      expect([model.alert.alert.id, model.alert.more]).toEqual([left[0]?.id, left.length - 1])
    }
    expect(linked.model.alert?.alert.id).toBe('unfixable_gap:main:2026-10')
    expect([linked.say(linked.model.alert?.about ?? []), linked.model.alert?.tone, linked.model.alert?.link]).toEqual(['Main', 'negative', { pathname: '/months', params: { month: '2026-10', view: 'todo' } }])
    expect([plain.model.alert?.alert.title, plain.say(plain.model.alert?.about ?? []), plain.model.alert?.more]).toEqual(['Pay or skip an overdue bill', 'Mobile plan', 1])
  })
})

describe('cash accounts and budgets', () => {
  it('show each cash account live and at month end with its word, and link an account with no floor to its editor', async () => {
    const { model } = await world(abroad, '2026-10-09')
    expect(model.cash.map((c) => [c.account_id, c.live_minor, c.end_minor, c.word, c.floor_minor, c.floor_link])).toEqual([
      ['main', 645000, 910763, 'Short', 600000, null],
      ['tax', 180000, 240000, 'OK', null, { pathname: '/settings/account/[id]', params: { id: 'tax' } }],
      ['pesos', 3000000, 2000014, 'Short', 2000000, null],
    ])
  })

  it('show core todayBudgets with what is left, a day’s allowance and the rate so far against plan, and open Budgets', async () => {
    const { model } = await world(abroad, '2026-10-09')
    expect(model.budgets.map((b) => [b.category_id, b.left_minor, b.per_day_minor, b.rate_so_far_minor, b.planned_rate_minor, b.word])).toEqual([['cat-groceries', 20000, 869, 1667, 1129, 'Spending fast']])
    expect(model.all_budgets).toEqual({ pathname: '/budgets' })
  })

  it('draws a budget’s pace bar as spent over the budget, with the plan’s mark at the share of the month gone', async () => {
    const { model } = await world(abroad, '2026-10-09')
    const groceries = model.budgets[0]!
    // €350.00 budgeted (€400.00 less a €50.00 credit), €150.00 spent by 9 Oct, so the plan by today is 350 × 9 ÷ 31.
    expect([groceries.budget_minor, groceries.spent_minor, groceries.days_elapsed, groceries.days_in_month]).toEqual([35000, 15000, 9, 31])
    expect(paceBar(groceries)).toEqual({ spent: 15000 / 35000, mark: 9 / 31, plan_minor: 10161, fill: 'caution' })
    // Spent past the budget fills the bar and no further; refunds that leave spending below zero leave it empty; on pace it fills in Cobalt text.
    expect([paceBar({ ...groceries, spent_minor: 42000 }).spent, paceBar({ ...groceries, spent_minor: -2000 }).spent, paceBar({ ...groceries, word: 'On pace' }).fill]).toEqual([1, 0, 'brandText'])
  })
})

describe('the next 30 days', () => {
  it('lists cash items by day with the balance after each, the day’s last item ending at the walk’s balance', async () => {
    for (const build of FIXTURES) {
      for (const asOf of DATES) {
        const { model, walk } = await world(build, asOf)
        for (const day of model.agenda) {
          expect(day.date >= asOf && day.date <= model.until).toBe(true)
          const lastOf = new Map(day.items.map((i) => [i.account_id, i]))
          for (const [account, item] of lastOf) expect(item.after_minor).toBe(walk.balances.get(account)?.[walk.days.indexOf(day.date)])
          for (let k = 1; k < day.items.length; k++) {
            const [a, b] = [day.items[k - 1], day.items[k]]
            if (a && b && a.account_id === b.account_id) expect(b.after_minor - a.after_minor).toBe(b.amount_minor)
          }
        }
      }
    }
    const { model, say } = await world(abroad, '2026-10-09')
    expect(model.until).toBe('2026-11-07')
    expect(model.agenda.slice(0, 2).map((d) => [d.date, d.items.map((i) => [say(i.title), i.account_id, i.to_account_id, i.amount_minor, i.after_minor, i.words])])).toEqual([
      ['2026-10-10', [['Mobile plan', 'pesos', null, -120000, 2880000, []]]],
      // The day's top-up is the hero's, so only the payment it covers is listed.
      ['2026-10-16', [['Rewards card payment', 'pesos', null, -4500000, 1024369, []]]],
    ])
  })

  it('offers Record only on this month’s open plan entries, opening the Add sheet linked to the occurrence', async () => {
    const { model } = await world(abroad, '2026-10-09')
    const items = model.agenda.flatMap((d) => d.items)
    expect(items.filter((i) => i.record).map((i) => [i.date, i.record])).toEqual([
      ['2026-10-10', { pathname: '/add', params: { plan_item_id: 'mobile', period: '2026-10-01' } }],
      ['2026-10-19', { pathname: '/add', params: { plan_item_id: 'receivable', period: '2026-10-01' } }],
      ['2026-10-22', { pathname: '/add', params: { plan_item_id: 'insurance', period: '2026-10-01' } }],
      ['2026-10-28', { pathname: '/add', params: { plan_item_id: 'salary', period: '2026-10-01' } }],
      ['2026-10-28', { pathname: '/add', params: { plan_item_id: 'tax-set-aside', period: '2026-10-01' } }],
    ])
    // November's rent is in the window but not in this month, so it shows without Record.
    expect(items.find((i) => i.date === '2026-11-02')?.record).toBeNull()
  })

  it('shows a transfer once, on the account it leaves, and leaves out what the next action already says', async () => {
    const { model } = await world(abroad, '2026-10-16')
    const ids = model.agenda.flatMap((d) => d.items.map((i) => i.id))
    expect(ids.filter((id) => id.endsWith('#in'))).toEqual([])
    expect(ids).toContain('tax-set-aside:2026-10-01#out')
    // 'Send €437.50 → Pesos, and €104.87 more on 28 Oct' is the next action; neither top-up shows again below it.
    expect(ids.filter((id) => id.startsWith('top-up:main>pesos:2026-10'))).toEqual([])
    expect(ids).toContain('top-up:main>pesos:2026-11-10#out')
  })
})

describe('the next 30 days, after a top-up', () => {
  it('names a top-up once on the row that takes it in, even when two from the same account land before it', async () => {
    const { model, walk } = await world(abroad, '2026-10-16')
    const pesos = model.agenda.flatMap((d) => d.items).filter((i) => i.account_id === 'pesos')
    const mobile = pesos.find((i) => i.date === '2026-11-10')
    const before = mobile ? pesos[pesos.indexOf(mobile) - 1] : undefined
    if (!mobile || !before) throw new Error('expected the November mobile bill after another Pesos row')
    const landings = walk.lines.filter((l) => l.source === 'top_up' && l.account_id === 'pesos' && l.amount_minor > 0 && l.date > before.date && l.date <= mobile.date)
    expect([landings.length, mobile.landed]).toEqual([2, [{ from_account_id: 'main', kind: 'top_up' }]])
  })
})

describe('cash accounts', () => {
  it('give a Short or Tight account the low point that makes it so, even when the month ends above its floor, and an OK one none', async () => {
    const { model } = await world(abroad, '2026-10-16')
    expect(model.cash.map((c) => [c.account_id, c.word, c.end_minor >= (c.floor_minor ?? 0), c.lowest])).toEqual([
      ['main', 'Short', true, { minor: 586250, on: '2026-10-27' }],
      ['tax', 'OK', true, null],
      ['pesos', 'Short', true, { minor: 1071062, on: '2026-10-22' }],
    ])
  })
})

describe('late income', () => {
  it('asks first about the earliest late income with Record, and lists the next one on the first of next month as Late', async () => {
    const w = await world(abroad, '2026-10-10', (doc) => {
      doc.plan_items.push(
        { id: 'deposit-back', kind: 'income', name: 'Deposit back', to_account_id: 'main', amount_minor: 80000, every: 'once', starts_on: '2026-09-21' },
        { id: 'bonus', kind: 'income', name: 'Bonus', to_account_id: 'main', amount_minor: 50000, every: 'once', starts_on: '2026-10-02' },
      )
    })
    expect([w.model.next.action.kind, w.say(w.model.next.action.title), w.say(w.model.next.action.context), w.model.next.button]).toEqual([
      'review',
      'Check whether expected money arrived',
      'Deposit back: €800.00 into Main was expected on 2026-09-21 and has no linked transaction, so it now counts on 2026-11-01.',
      { label: 'Record', link: { pathname: '/add', params: { plan_item_id: 'deposit-back', period: '2026-09-01' } } },
    ])
    // The deposit's own line is the next action, so only the bonus shows on 1 Nov, and it can be recorded now.
    const first = w.model.agenda.find((d) => d.date === '2026-11-01')
    expect(first?.items.filter((i) => i.account_id === 'main').map((i) => [w.say(i.title), i.amount_minor, i.words, i.record])).toEqual([
      ['Bonus', 50000, ['Late'], { pathname: '/add', params: { plan_item_id: 'bonus', period: '2026-10-01' } }],
    ])
  })
})

describe('addresses and words', () => {
  it('turn core routes into app addresses', () => {
    expect(routeLink({ tab: 'months', account_id: 'main', segment: 'chart', month: '2026-11' }, '2026-10')).toEqual({ pathname: '/months', params: { month: '2026-11', view: 'chart' } })
    expect(routeLink({ tab: 'debts', account_id: 'card' }, '2026-10')).toEqual({ pathname: '/debts/[accountId]', params: { accountId: 'card' } })
    expect(routeLink({ tab: 'plan', account_id: 'pesos' }, '2026-10')).toEqual({ pathname: '/plan' })
    expect(routeLink({ tab: 'today', sheet: 'statement', account_id: 'card' }, '2026-10')).toEqual({ pathname: '/statement', params: { account: 'card' } })
  })

  it('name the agenda’s days', () => {
    expect([dayTitle('2026-10-09', '2026-10-09', 'en-GB'), dayTitle('2026-10-10', '2026-10-09', 'en-GB'), dayTitle('2026-10-16', '2026-10-09', 'en-GB')]).toEqual(['Today', 'Tomorrow', 'Fri 16 Oct'])
  })
})
