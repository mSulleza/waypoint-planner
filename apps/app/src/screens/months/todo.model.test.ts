import { alerts, budgetRows, buildSnapshot, debtFigures, expandPlan, fxBreakeven, monthKey, plainNames, renderCopy, reviewList, runEngine, type Copy, type FxBreakeven, type Snapshot, type Walk } from '@waypoint/core'
import { abroad, mortgage, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deleteFilter } from '../../data/edits'
import { todayModel } from '../today/today.model'
import { strip } from './months.model'
import { DONE_FOR_MONTH, linkChoices, todoModel, WONT_COME, type CardRow, type ItemRow, type TodoModel, type TopUpRow } from './todo.model'

const AS_OF = '2026-10-09'

interface World {
  snapshot: Snapshot
  walk: Walk
  breakeven: FxBreakeven | null
  todo: (month: string) => TodoModel
  say: (copy: Copy) => string
}

async function world(build: (asOf: string) => Sample, asOf = AS_OF, edit?: (doc: SampleDoc) => void): Promise<World> {
  const sample = build(asOf)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, asOf, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  const breakeven = await fxBreakeven(snapshot)
  if (breakeven !== null && !breakeven.ok) throw new Error('the breakeven did not run')
  const names = plainNames(snapshot)
  return { snapshot, walk: run.walk, breakeven, todo: (month) => todoModel({ snapshot, walk: run.walk, breakeven, month }), say: (copy) => renderCopy(copy, names) }
}

const rowsOf = (m: TodoModel) => m.groups.flatMap((g) => g.rows)
const items = (m: TodoModel) => rowsOf(m).filter((r): r is ItemRow => r.type === 'item')
const cards = (m: TodoModel) => rowsOf(m).filter((r): r is CardRow => r.type === 'card')
const topUps = (m: TodoModel) => rowsOf(m).filter((r): r is TopUpRow => r.type === 'top_up')
const item = (m: TodoModel, id: string) => {
  const found = items(m).find((r) => r.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

describe('the rows', () => {
  it('has no installment rows and one row per card on abroad, in every month of the strip', async () => {
    const w = await world(abroad)
    const october = w.todo('2026-10')
    expect(cards(october).map((c) => c.account_id)).toEqual(['rewards-card', 'shopping-card'])
    expect(items(october).map((r) => r.id)).toEqual([
      'rent:2026-10-01',
      'streaming:2026-10-01',
      'mobile:2026-10-01',
      'insurance:2026-10-01',
      'cash-loan-draw:2026-10-01',
      'receivable:2026-10-01',
      'salary:2026-10-01',
      'tax-set-aside:2026-10-01',
      'groceries:2026-10-01',
    ])
    const plan = expandPlan(w.snapshot)
    const folded = new Set(plan.occurrences.filter((o) => o.flow === 'installment' || o.flow === 'debt_transfer' || o.flow === 'extra').map((o) => o.id))
    expect(folded.size).toBeGreaterThan(20)
    for (const chip of strip(w.snapshot, w.walk)) {
      const m = w.todo(chip.month)
      expect(items(m).filter((r) => folded.has(r.id))).toEqual([])
      const ids = cards(m).map((c) => c.account_id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('folds a card into one Pay row sized as left to pay, its installments named, and Enter the statement when its cycle is provisional', async () => {
    const w = await world(abroad)
    const [rewards, shopping] = cards(w.todo('2026-10'))
    const left = debtFigures(w.snapshot, w.walk).cards.find((c) => c.account_id === 'rewards-card')?.payment?.left_to_pay_minor
    expect(left).toBe(4500000)
    expect([rewards?.task, rewards?.left_minor, rewards?.done, w.say(rewards!.detail), rewards!.notes.map(w.say), rewards?.primary]).toEqual([
      'pay',
      left,
      false,
      'Pay by 2026-10-16 · statement of 2026-09-20',
      ['Includes ₱5,000.00 of installments'],
      { label: 'Record payment', link: { pathname: '/add', params: { mode: 'move', to: 'rewards-card' } } },
    ])
    expect([shopping?.done, shopping?.words, shopping?.primary]).toEqual([true, [{ text: 'Nothing due', tone: null }], null])

    // On 23 Oct the rewards card has cut with no statement entered; its payment leaves cash in November.
    const later = await world(abroad, '2026-10-23')
    const [enter, planned] = cards(later.todo('2026-11'))
    expect([enter?.account_id, enter?.task, enter?.left_minor, later.say(enter!.detail), enter?.primary]).toEqual([
      'rewards-card',
      'enter_statement',
      null,
      'Enter the statement cut on 2026-10-20',
      { label: 'Enter statement', link: { pathname: '/statement', params: { account: 'rewards-card' } } },
    ])
    // A cycle that has not cut yet shows what it will ask for, with no button until it has a statement.
    expect([planned?.account_id, planned?.left_minor, later.say(planned!.detail), planned?.primary]).toEqual(['shopping-card', 50000, 'Pay by 2026-11-13 · statement on 2026-10-25', null])
  })

  it('names a statement that differs in the Statement sheet’s words, and never says EMI', async () => {
    const w = await world(abroad, AS_OF, (doc) => {
      const s = doc.statements.find((x) => x.id === 'rewards-last')
      if (!s) throw new Error('no rewards statement')
      Object.assign(s, { installments_minor: 400000, charges_minor: 6600000 })
    })
    const rewards = cards(w.todo('2026-10'))[0]
    expect(rewards?.warnings).toEqual(['Installments differ from your plan'])
    const text = JSON.stringify(w.todo('2026-10'))
    expect(text).not.toMatch(/\bEMI\b/)
  })

  it('opens Record, Link or Done for this month as the row’s one button, from the occurrence alone', async () => {
    const w = await world(abroad, AS_OF, (doc) => {
      // Within 5% of the mobile bill and two days before it: a suggestion.
      doc.transactions.push({ id: 'mobile-paid', account_id: 'pesos', posted_on: '2026-10-08', amount_minor: -118000, kind: 'expense', description: 'Mobile' })
    })
    const m = w.todo('2026-10')
    expect([item(m, 'salary:2026-10-01').primary, item(m, 'salary:2026-10-01').record]).toEqual(['record', { pathname: '/add', params: { plan_item_id: 'salary', period: '2026-10-01' } }])
    expect([item(m, 'tax-set-aside:2026-10-01').primary, item(m, 'tax-set-aside:2026-10-01').to_account_id]).toEqual(['record', 'tax'])
    expect([item(m, 'mobile:2026-10-01').primary, item(m, 'mobile:2026-10-01').suggested, item(m, 'mobile:2026-10-01').words]).toEqual(['link', 1, [{ text: 'Possible match', tone: null }]])
    const groceries = item(m, 'groceries:2026-10-01')
    expect([groceries.primary, groceries.skip?.label, groceries.record, groceries.can_link, groceries.budget]).toEqual(['skip', DONE_FOR_MONTH, null, false, { currency: 'EUR', budget_minor: 35000, spent_minor: 15000 }])
    expect(groceries.skip?.edit).toEqual({ kind: 'skips', plan_item_id: 'groceries', before: [], after: ['2026-10-01'] })
    // Part of the receivable came in: 'The rest won’t come' skips the rest, Record prefills it.
    const receivable = item(m, 'receivable:2026-10-01')
    expect([receivable.words[0], receivable.linked_minor, receivable.open_minor, receivable.skip?.label, receivable.links.map((l) => l.row_id)]).toEqual([
      { text: 'Partly settled', tone: null },
      400000,
      200000,
      'The rest won’t come',
      ['receivable-slice-1', 'receivable-slice-2'],
    ])
  })
})

describe('top-ups', () => {
  it('lists this month’s top-ups under Transfers with what leaves and what lands, and Record transfer opens the Add sheet as Today’s send does', async () => {
    const w = await world(abroad)
    const m = w.todo('2026-10')
    expect(m.groups.find((g) => g.section === 'transfers')?.rows.map((r) => r.id)).toEqual(['top-up:main>pesos:2026-10-16#out', 'tax-set-aside:2026-10-01', 'top-up:main>pesos:2026-10-28#out'])
    expect(topUps(m).map((r) => [r.date, w.say(r.title), w.say(r.detail), r.sent_minor, r.currency, r.landed, r.words, r.done, r.primary])).toEqual([
      [
        '2026-10-16',
        'Top up Pesos from Main',
        '2026-10-16 · Pesos stays under its floor: this is all Main can spare',
        38043,
        'EUR',
        { currency: 'PHP', minor: 2644369 },
        [{ text: 'To send', tone: null }],
        false,
        { label: 'Record transfer', link: { pathname: '/add', params: { mode: 'move', from: 'main', to: 'pesos', amount: '38043' } } },
      ],
      [
        '2026-10-28',
        'Top up Pesos from Main',
        '2026-10-28 · Brings Pesos up to its floor',
        16194,
        'EUR',
        { currency: 'PHP', minor: 1125645 },
        [{ text: 'To send', tone: null }],
        false,
        { label: 'Record transfer', link: { pathname: '/add', params: { mode: 'move', from: 'main', to: 'pesos', amount: '16194' } } },
      ],
    ])
    // On the day it is due, Today's next action is that top-up and its button opens the same sheet.
    const due = await world(abroad, '2026-10-16')
    const today = todayModel({ snapshot: due.snapshot, walk: due.walk, breakeven: due.breakeven })
    const [first] = topUps(due.todo('2026-10'))
    expect([first?.date, today.next.action.kind, today.next.button]).toEqual(['2026-10-16', 'send', first?.primary])
  })

  it('has none in a past month and lists a projected month’s own, one row per pair, each month of the strip', async () => {
    const w = await world(abroad)
    expect(topUps(w.todo('2026-09'))).toEqual([])
    const november = topUps(w.todo('2026-11'))
    expect(november.map((r) => [r.id, r.sent_minor, r.landed, r.words])).toEqual([['top-up:main>pesos:2026-11-10#out', 7481, { currency: 'PHP', minor: 520004 }, []]])
    for (const chip of strip(w.snapshot, w.walk)) {
      const sent = w.walk.lines.filter((l) => l.source === 'top_up' && l.amount_minor < 0 && monthKey(l.date) === chip.month)
      expect([chip.month, topUps(w.todo(chip.month)).map((r) => [r.id, r.sent_minor])]).toEqual([chip.month, sent.map((l) => [l.id, -l.amount_minor])])
    }
  })

  it('lists a top-up as a transfer to record, never a plan item or income (invariant 108)', async () => {
    const w = await world(abroad)
    const m = w.todo('2026-10')
    expect(m.groups.filter((g) => g.rows.some((r) => r.type === 'top_up')).map((g) => g.section)).toEqual(['transfers'])
    // No link, skip or edit: its one action records the transfer.
    expect(topUps(m).map((r) => Object.keys(r).filter((k) => ['plan_item_id', 'links', 'can_link', 'skip', 'unskip', 'record'].includes(k)))).toEqual([[], []])
    // No review item or alert is about it, so Today's next action and To-do's alerts stay as they were.
    const ids = topUps(m).map((r) => r.id)
    expect(reviewList(w.snapshot, w.walk).filter((r) => ids.some((id) => r.id.includes(id) || r.occurrence_id === id))).toEqual([])
    expect(m.alerts.filter((a) => a.open.kind === 'row' && ids.includes(a.open.row_id))).toEqual([])
    // Still to send, so the Transfers heading counts it beside the tax set-aside.
    expect(m.groups.find((g) => g.section === 'transfers')?.open).toBe(3)
  })
})

describe('late income', () => {
  const lateDeposit = (doc: SampleDoc) => {
    doc.plan_items.push({ id: 'deposit-back', kind: 'income', name: 'Deposit back', to_account_id: 'main', amount_minor: 80000, every: 'once', starts_on: '2026-09-21' })
    doc.transactions.push({ id: 'refund-in', account_id: 'main', posted_on: '2026-10-05', amount_minor: 30000, kind: 'income', description: 'Refund' })
  }

  it('reads Late, expected 1 Nov in its own month, with Record, Link reaching this month and Won’t come', async () => {
    const w = await world(abroad, '2026-10-10', lateDeposit)
    const row = item(w.todo('2026-09'), 'deposit-back:2026-09-01')
    expect([row.done, row.words, row.carried_to, row.open_minor, row.primary, row.record, row.can_link, row.skip]).toEqual([
      false,
      [{ text: 'Late, expected', tone: 'caution', on: '2026-11-01' }],
      '2026-11-01',
      80000,
      'record',
      { pathname: '/add', params: { plan_item_id: 'deposit-back', period: '2026-09-01' } },
      true,
      { label: WONT_COME, edit: { kind: 'skips', plan_item_id: 'deposit-back', before: [], after: ['2026-09-01'] } },
    ])
    // The money may have come in October, so Link lists October's unlinked income too; a September occurrence that is not late keeps to September.
    expect(linkChoices(w.snapshot, 'deposit-back:2026-09-01').map((c) => c.row_id)).toContain('refund-in')
    expect(linkChoices(w.snapshot, 'salary:2026-09-01').map((c) => c.row_id)).not.toContain('refund-in')
    // This month's To-do lists its review item, which opens September's To-do.
    const asked = w.todo('2026-10').alerts.find((a) => a.alert.id === 'unconfirmed_inflow:deposit-back:2026-09-01')
    expect([asked?.alert.title, w.say(asked?.alert.body ?? []), asked?.open]).toEqual([
      'Check whether expected money arrived',
      'Deposit back: €800.00 into Main was expected on 2026-09-21 and has no linked transaction, so it now counts on 2026-11-01.',
      { kind: 'link', link: { pathname: '/months', params: { month: '2026-09', view: 'todo' } } },
    ])
  })

  it('says Won’t come once skipped, with Undo, and only Late beside a possible match', async () => {
    const skipped = await world(abroad, '2026-10-10', (doc) => {
      lateDeposit(doc)
      const deposit = doc.plan_items.find((p) => p.id === 'deposit-back')
      if (deposit) deposit.skip_periods = ['2026-09-01']
    })
    const row = item(skipped.todo('2026-09'), 'deposit-back:2026-09-01')
    expect([row.done, row.words, row.carried_to, row.skip, row.unskip?.label]).toEqual([true, [{ text: WONT_COME, tone: null }], null, null, 'Undo'])

    const matched = await world(abroad, '2026-10-10', (doc) => {
      lateDeposit(doc)
      doc.transactions.push({ id: 'deposit-in', account_id: 'main', posted_on: '2026-09-23', amount_minor: 80000, kind: 'income', description: 'Landlord' })
    })
    const held = item(matched.todo('2026-09'), 'deposit-back:2026-09-01')
    expect([held.words, held.primary]).toEqual([[{ text: 'Late', tone: 'caution' }, { text: 'Possible match', tone: null }], 'link'])
  })
})

describe('marks stay undoable', () => {
  it('keeps settled, skipped and finished budget rows listed, each with the edit that undoes it (invariant 174)', async () => {
    const w = await world(abroad, AS_OF, (doc) => {
      const mobile = doc.plan_items.find((p) => p.id === 'mobile')
      const groceries = doc.plan_items.find((p) => p.id === 'groceries')
      if (!mobile || !groceries) throw new Error('no items')
      mobile.skip_periods = ['2026-10-01']
      groceries.skip_periods = ['2026-10-01']
    })
    const m = w.todo('2026-10')
    const rent = item(m, 'rent:2026-10-01')
    expect([rent.done, rent.words[0], rent.primary, rent.links.map((l) => [l.row_id, l.unlink, l.remove])]).toEqual([
      true,
      { text: 'Settled', tone: 'positive' },
      null,
      [['rent-now', { kind: 'unlink', row_id: 'rent-now', plan_item_id: 'rent', period: '2026-10-01' }, { kind: 'delete', row_id: 'rent-now', transfer_id: null }]],
    ])
    const mobile = item(m, 'mobile:2026-10-01')
    expect([mobile.done, mobile.words[0], mobile.skip, mobile.unskip]).toEqual([true, { text: 'Skipped', tone: null }, null, { label: 'Undo skip', edit: { kind: 'skips', plan_item_id: 'mobile', before: ['2026-10-01'], after: [] } }])
    const groceries = item(m, 'groceries:2026-10-01')
    expect([groceries.done, groceries.words[0], groceries.unskip?.label]).toEqual([true, { text: DONE_FOR_MONTH, tone: 'positive' }, 'Undo'])
    expect(m.groups.find((g) => g.section === 'bills')?.open).toBe(1)
  })

  it('deletes a transfer with both its legs, so nothing it created is left (invariant 18)', async () => {
    const w = await world(abroad)
    const tax = item(w.todo('2026-09'), 'tax-set-aside:2026-09-01')
    const [leg] = tax.links
    expect([leg?.row_id, leg?.transfer_id, leg?.partner_account_id, leg?.remove]).toEqual(['tax-last-out', 'tax-last', 'tax', { kind: 'delete', row_id: 'tax-last-out', transfer_id: 'tax-last' }])
    expect(deleteFilter('tax-last-out', 'tax-last')).toBe('id.in.(tax-last-out),transfer_id.in.(tax-last)')
    expect(deleteFilter('rent-now', null)).toBe('id.in.(rent-now)')
    const legs = w.snapshot.doc.transactions.filter((t) => t.id === 'tax-last-out' || t.transfer_id === 'tax-last').map((t) => t.id)
    expect(legs.sort()).toEqual(['tax-last-in', 'tax-last-out'])
  })
})

describe('alerts', () => {
  it('lists every core alert first on this month, in core order, where Today’s N more lands', async () => {
    const w = await world(abroad)
    const review = reviewList(w.snapshot, w.walk)
    const core = alerts({ snapshot: w.snapshot, walk: w.walk, review, breakeven: w.breakeven, budgets: budgetRows(w.snapshot) })
    const m = w.todo('2026-10')
    expect(m.alerts.map((a) => a.alert.id)).toEqual(core.map((a) => a.id))
    expect(m.alerts.map((a) => a.alert.id)).toEqual(['below_floor:pesos:2026-10', 'unfixable_gap:main:2026-10', 'spending_fast:cat-groceries:2026-10'])
    expect(m.alerts.map((a) => a.open)).toEqual([
      { kind: 'link', link: { pathname: '/months', params: { month: '2026-10', view: 'chart' } } },
      { kind: 'link', link: { pathname: '/months', params: { month: '2026-10', view: 'chart' } } },
      { kind: 'link', link: { pathname: '/months', params: { month: '2026-10', view: 'breakdown' } } },
    ])
    const today = todayModel({ snapshot: w.snapshot, walk: w.walk, breakeven: w.breakeven })
    // Pesos' own alert is the next action's, the top-up on 16 Oct, so Today leaves it out and counts one more.
    expect([today.alert?.alert.id, today.alert?.more, today.alert?.link]).toEqual(['unfixable_gap:main:2026-10', 1, { pathname: '/months', params: { month: '2026-10', view: 'todo' } }])
    expect(today.alert && m.alerts.some((a) => a.alert.id === today.alert?.alert.id)).toBe(true)
  })

  it('lists a later month’s alert on this month too, and on that month, but on no other', async () => {
    // Tax gets a floor from January that nothing tops it up to.
    const w = await world(abroad, AS_OF, (doc) => {
      const tax = doc.accounts.find((a) => a.id === 'tax')
      if (!tax) throw new Error('no tax account')
      tax.floor_windows = [{ from_month: '2027-01', to_month: null, amount_minor: 500000 }]
    })
    const later = w.todo('2026-10').alerts.map((a) => a.alert.id).filter((id) => id.includes(':tax:'))
    expect(later).toEqual(['unfixable_gap:tax:2027-01'])
    expect(w.todo('2027-01').alerts.map((a) => a.alert.id)).toEqual(later)
    expect(w.todo('2026-11').alerts).toEqual([])
  })

  it('opens a review item’s own row, a loan payment’s Pay sheet, and gives other months only their own alerts', async () => {
    const w = await world(abroad, '2026-10-23')
    const m = w.todo('2026-10')
    expect(m.alerts.find((a) => a.alert.id === 'overdue_outflow:mobile:2026-10-01')?.open).toEqual({ kind: 'row', row_id: 'mobile:2026-10-01' })
    expect(m.alerts.find((a) => a.alert.id === 'statement_to_enter:rewards-card:2026-10-20')?.open).toEqual({ kind: 'link', link: { pathname: '/statement', params: { account: 'rewards-card' } } })
    expect(w.todo('2026-11').alerts).toEqual([])
    expect(w.todo('2026-09').alerts).toEqual([])

    // October's mortgage payment never left: it is overdue, and its alert opens the Pay sheet for the loan.
    const loan = await world(mortgage, '2026-10-23', (doc) => {
      doc.transactions = doc.transactions.filter((t) => t.transfer_id !== 'mortgage-now')
    })
    const overdue = loan.todo('2026-10').alerts.find((a) => a.alert.id.startsWith('overdue_outflow:payment:'))
    expect([overdue?.alert.id, overdue?.open]).toEqual(['overdue_outflow:payment:mortgage:2026-10-01', { kind: 'link', link: { pathname: '/add', params: { mode: 'move', to: 'mortgage' } } }])
  })
})

describe('empty months', () => {
  it('says why a month before the plan is checked has nothing to settle', async () => {
    const w = await world(abroad)
    expect([w.todo('2026-08').empty, w.todo('2026-08').groups]).toEqual([{ tracked_from: '2026-09' }, []])
    expect(w.todo('2026-10').empty).toBeNull()
  })

  it('builds a To-do for every month of every fixture without throwing', async () => {
    for (const build of [abroad, usCardsCar, mortgage]) {
      const w = await world(build)
      for (const chip of strip(w.snapshot, w.walk)) expect(() => w.todo(chip.month)).not.toThrow()
    }
  })
})

describe('Link', () => {
  it('offers the account’s unlinked rows in the month at any amount, suggestions first, and only rows that may settle it', async () => {
    const w = await world(abroad, AS_OF, (doc) => {
      doc.transactions.push(
        // 20% under the 3,500.00 bill: no suggestion, still offered.
        { id: 'insurance-low', account_id: 'pesos', posted_on: '2026-10-02', amount_minor: -280000, kind: 'expense', description: 'Insurance premium' },
        // Within 5% and 7 days of the bill: the suggestion.
        { id: 'insurance-near', account_id: 'pesos', posted_on: '2026-10-20', amount_minor: -340000, kind: 'expense', description: 'Insurance' },
        // Last month, and money in: neither can settle October's bill.
        { id: 'insurance-september', account_id: 'pesos', posted_on: '2026-09-30', amount_minor: -350000, kind: 'expense', description: 'Insurance' },
        { id: 'refund', account_id: 'pesos', posted_on: '2026-10-03', amount_minor: 10000, kind: 'refund', description: 'Refund' },
      )
    })
    const choices = linkChoices(w.snapshot, 'insurance:2026-10-01')
    expect(choices.map((c) => [c.row_id, c.amount_minor, c.suggested])).toEqual([
      ['insurance-near', 340000, true],
      ['insurance-low', 280000, false],
    ])
    expect(choices[1]?.edit).toEqual({ kind: 'link', row_id: 'insurance-low', plan_item_id: 'insurance', period: '2026-10-01' })
    // A transfer item links by an outgoing leg landing in its own account; a budget takes no links.
    expect(linkChoices(w.snapshot, 'tax-set-aside:2026-10-01')).toEqual([])
    expect(linkChoices(w.snapshot, 'groceries:2026-10-01')).toEqual([])
  })
})

describe('labels', () => {
  it('wraps every label in To-do and Breakdown and never cuts one short (invariant 186)', () => {
    const files = ['Todo.tsx', 'Breakdown.tsx', '../../ui/Text.tsx', '../../ui/Money.tsx', '../../ui/Row.tsx', '../../ui/AlertLine.tsx', '../../ui/Button.tsx', '../../ui/CopyText.tsx']
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect([file, source.match(/numberOfLines|ellipsizeMode|textOverflow|adjustsFontSizeToFit|whiteSpace/g)]).toEqual([file, null])
    }
  })
})
