import { buildSnapshot, debtFigures, runEngine, type Snapshot, type Walk } from '@waypoint/core'
import { decodeLevers } from '@waypoint/core/compare'
import { abroad, mortgage, revolvingDaily, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { openDraft, type AddParams } from '../add/add.model'
import { CHIPS, debtDetail, debtPanes, debtsModel, roundFigure, roundSpare, spareMonthly, tryExtraLink, type CardDetail, type DebtLink, type DebtRow, type LoanDetail } from './debts.model'

function world(build: (asOf: string) => Sample, asOf = '2026-10-07', edit?: (doc: SampleDoc) => void): { snapshot: Snapshot; walk: Walk } {
  const sample = build(asOf)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, asOf, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return { snapshot, walk: run.walk }
}

const rowOf = (snapshot: Snapshot, walk: Walk, id: string): DebtRow => {
  const found = debtsModel(snapshot, walk)?.debts.find((d) => d.account_id === id)
  if (!found) throw new Error(`no row for '${id}'`)
  return found
}

// What the Add sheet prefills when Pay opens it: the address the row links to, read by the sheet itself.
const prefill = (snapshot: Snapshot, walk: Walk, link: DebtLink | undefined) => {
  if (typeof link !== 'object' || link.pathname !== '/add') throw new Error(`Pay links to ${JSON.stringify(link)}`)
  return openDraft(snapshot, walk, link.params as AddParams, null, snapshot.doc.household.locale).draft
}

const leftToPay = (snapshot: Snapshot, walk: Walk, id: string) => debtFigures(snapshot, walk).cards.find((c) => c.account_id === id)?.payment?.left_to_pay_minor

describe('Pay on a card', () => {
  it('prefills left to pay, not the remaining due, and shows the remaining due beside it', () => {
    // The US travel card pays its minimum: 80.00 left to pay against 2,042.50 remaining due.
    const us = world(usCardsCar)
    const travel = rowOf(us.snapshot, us.walk, 'travel-card')
    expect(leftToPay(us.snapshot, us.walk, 'travel-card')).toBe(8000)
    expect(travel.next).toEqual({ label: 'Next payment', minor: 8000, currency: 'USD', on: '2026-10-16', overdue: false, remaining_minor: 204250, after_cut: null })
    expect(travel.action?.label).toBe('Record payment')
    expect(prefill(us.snapshot, us.walk, travel.action?.link)).toMatchObject({ mode: 'move', account: 'checking', to: 'travel-card', amount: '80.00' })
    // A transfer item into the rewards card in its cycle's month lifts left to pay 2,000.00 above the remaining due.
    const lifted = world(abroad, '2026-10-07', (doc) => {
      doc.plan_items.push({ id: 'rewards-extra', kind: 'transfer', name: 'Rewards card extra', to_account_id: 'rewards-card', amount_minor: 200000, every: 'once', starts_on: '2026-09-25' })
    })
    const rewards = rowOf(lifted.snapshot, lifted.walk, 'rewards-card')
    expect([rewards.next?.minor, rewards.next?.remaining_minor, leftToPay(lifted.snapshot, lifted.walk, 'rewards-card')]).toEqual([4700000, 4500000, 4700000])
    expect(prefill(lifted.snapshot, lifted.walk, rewards.action?.link).amount).toBe('47000.00')
  })

  it('on a card paid in full in two parts, prefills the second part before it is paid, then moves to the next statement', () => {
    // The 70,000.00 September statement, 25,000.00 paid after the cut: 45,000.00 is the second part.
    const before = world(abroad)
    const rewards = rowOf(before.snapshot, before.walk, 'rewards-card')
    expect([rewards.next?.minor, rewards.next?.remaining_minor, rewards.state, leftToPay(before.snapshot, before.walk, 'rewards-card')]).toEqual([4500000, null, null, 4500000])
    expect(prefill(before.snapshot, before.walk, rewards.action?.link).amount).toBe('45000.00')

    const after = world(abroad, '2026-10-07', (doc) => {
      doc.transactions.push(
        { id: 'part-2-out', account_id: 'pesos', posted_on: '2026-10-07', amount_minor: -4500000, kind: 'transfer', description: 'Rewards card payment, part 2', transfer_id: 'part-2' },
        { id: 'part-2-in', account_id: 'rewards-card', posted_on: '2026-10-07', amount_minor: 4500000, kind: 'transfer', description: 'Rewards card payment, part 2', transfer_id: 'part-2' },
      )
    })
    const paid = rowOf(after.snapshot, after.walk, 'rewards-card')
    expect([paid.state, paid.action, leftToPay(after.snapshot, after.walk, 'rewards-card')]).toEqual([{ text: 'Paid', tone: 'positive' }, null, 0])
    // The next payment is the first later statement with something to pay, as the plan sizes it.
    expect(paid.next).toMatchObject({ overdue: false, remaining_minor: null })
    expect(paid.next?.after_cut && paid.next.after_cut > '2026-09-20').toBe(true)
  })

  it('asks for the statement instead of Pay once a cut passes with none entered', () => {
    const { snapshot, walk } = world(abroad, '2026-10-23')
    const rewards = rowOf(snapshot, walk, 'rewards-card')
    expect([rewards.chips, rewards.next, rewards.action]).toEqual([[CHIPS.provisional], null, { label: 'Enter statement', link: { pathname: '/statement', params: { account: 'rewards-card' } } }])
  })

  it('marks a card whose statement is past due with the payment still to make as Overdue', () => {
    const { snapshot, walk } = world(usCardsCar, '2026-10-18', (doc) => {
      // Moved two days back, the store card's due date has passed.
      const last = doc.statements.find((s) => s.id === 'store-last')
      if (last) last.due_date = '2026-10-16'
    })
    const store = rowOf(snapshot, walk, 'store-card')
    expect([store.state, store.next?.overdue, store.next?.on]).toEqual([{ text: 'Overdue', tone: 'negative' }, true, '2026-10-16'])
  })
})

describe('the Debts tab', () => {
  it('leads with debt-free, then revolving cleared, then total debt with the statements it stands on', () => {
    const abroadWorld = world(abroad)
    const m = debtsModel(abroadWorld.snapshot, abroadWorld.walk)
    expect(m?.headline).toEqual({ label: 'Debt-free by', value: [{ month: '2027-11' }], note: [{ text: '13 months from now, costliest debt first' }] })
    // No card carries a balance from its current statement on, but the payment that clears it is still to make, so it is this month, not Now.
    expect(m?.revolving).toEqual({ value: [{ month: '2026-10' }], note: [{ text: 'Card balances paid in full after the ' }, { date: '2026-10-16' }, { text: ' payment' }] })
    const paid = world(abroad, '2026-10-17', (doc) => {
      doc.transactions.push(
        { id: 'paid-out', account_id: 'pesos', posted_on: '2026-10-16', amount_minor: -4500000, kind: 'transfer', transfer_id: 'paid' },
        { id: 'paid-in', account_id: 'rewards-card', posted_on: '2026-10-16', amount_minor: 4500000, kind: 'transfer', transfer_id: 'paid' },
      )
    })
    expect(debtsModel(paid.snapshot, paid.walk)?.revolving).toEqual({ value: [{ text: 'Now' }], note: [{ text: 'Card balances paid in full' }] })
    // 47,000.00 owed on one card and 7,500.00 in credit on the other, plus 157,600.00 of installments still to bill.
    expect([m?.total, m?.total_includes_installments, m?.statement_cuts]).toEqual([[{ currency: 'PHP', minor: 4700000 - 750000 + 15760000 }], true, ['2026-09-20', '2026-09-25']])

    const us = world(usCardsCar)
    const usModel = debtsModel(us.snapshot, us.walk)
    expect([usModel?.headline.value, usModel?.revolving?.value, usModel?.total, usModel?.total_includes_installments]).toEqual([[{ month: '2030-01' }], [{ month: '2028-05' }], [{ currency: 'USD', minor: 204250 + 459120 + 1774792 }], false])
  })

  it('says the mortgage is paid off after the projection, with no revolving line and no chip', () => {
    const { snapshot, walk } = world(mortgage)
    const m = debtsModel(snapshot, walk)
    expect(m?.headline).toEqual({ label: 'Debt-free by', value: [{ month: '2045-04' }], note: [{ text: 'After the projection, which ends in ' }, { month: '2031-10' }] })
    expect(m?.revolving).toBeNull()
    expect(m?.debts.map((d) => [d.account_id, d.owed_minor, d.chips, d.payoff, d.next?.minor, d.next?.on])).toEqual([
      ['mortgage', debtFigures(snapshot, walk).loans[0]?.owed_minor, [], [{ text: 'Paid off by ' }, { month: '2045-04' }, { text: ', after the projection' }], 100000, '2026-11-01'],
    ])
  })

  it('says a balance carried at the horizon end is not cleared by then', () => {
    const { snapshot, walk } = world(revolvingDaily)
    const m = debtsModel(snapshot, walk)
    expect([m?.headline.label, m?.headline.value, m?.revolving?.value, m?.debts[0]?.payoff]).toEqual(['Debt-free', [{ text: 'Not by ' }, { month: '2031-10' }], [{ text: 'Not by ' }, { month: '2031-10' }], [{ text: 'Not paid off by ' }, { month: '2031-10' }]])
  })

  it('shows each debt owed, its chip, next payment and payoff month, in sort order', () => {
    const { snapshot, walk } = world(usCardsCar)
    const rows = debtsModel(snapshot, walk)?.debts ?? []
    expect(rows.map((d) => [d.account_id, d.kind, d.owed_minor, d.chips.map((c) => c.text), d.next?.minor, d.next?.on, d.payoff])).toEqual([
      ['travel-card', 'credit_card', 204250, ['Checked'], 8000, '2026-10-16', [{ text: 'Paid off by ' }, { month: '2027-04' }]],
      ['store-card', 'credit_card', 459120, ['Checked'], 12211, '2026-10-18', [{ text: 'Paid off by ' }, { month: '2028-05' }]],
      ['car-loan', 'loan', 1774792, [], 35558, '2026-10-20', [{ text: 'Paid off by ' }, { month: '2030-01' }]],
    ])
  })

  it('adds Over limit when the latest statement prints negative available credit', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07', (doc) => {
      const last = doc.statements.find((s) => s.id === 'rewards-last')
      if (last) last.available_credit_minor = -125000
    })
    expect(rowOf(snapshot, walk, 'rewards-card').chips).toEqual([CHIPS.checked, CHIPS.over_limit])
    expect((debtDetail(snapshot, walk, 'rewards-card') as CardDetail).over_limit_minor).toBe(125000)
  })

  it('shows a card in credit with nothing due as such, and the payment of the first statement that needs one', () => {
    const { snapshot, walk } = world(abroad)
    const shopping = rowOf(snapshot, walk, 'shopping-card')
    expect([shopping.owed_minor, shopping.state, shopping.action, shopping.next]).toEqual([-750000, { text: 'Nothing due', tone: null }, null, { label: 'Next payment', minor: 50000, currency: 'PHP', on: '2026-11-13', overdue: false, remaining_minor: null, after_cut: '2026-10-25' }])
  })

  it('calls a card’s payment an estimate until a statement is entered, the minimum when the plan pays only that', () => {
    const fresh = (inFull: boolean) =>
      world(abroad, '2026-10-09', (doc) => {
        const card = doc.accounts.find((a) => a.id === 'rewards-card')
        if (!card || card.kind !== 'credit_card') throw new Error('no rewards card')
        card.opening_date = '2026-10-09'
        card.opening_balance_minor = -8500000
        card.terms = { ...card.terms, cut_day: 25, due: { day_of_month: 15 }, pay: { ...card.terms.pay, mode: inFull ? 'in_full' : 'minimum' } }
        doc.statements = doc.statements.filter((t) => t.account_id !== 'rewards-card')
        const legs = new Set(doc.transactions.filter((t) => t.account_id === 'rewards-card').map((t) => t.transfer_id))
        doc.transactions = doc.transactions.filter((t) => t.account_id !== 'rewards-card' && !(t.transfer_id !== null && legs.has(t.transfer_id)))
        doc.plan_items = doc.plan_items.filter((i) => i.from_account_id !== 'rewards-card' && i.to_account_id !== 'rewards-card')
      })
    const minimum = fresh(false)
    expect(rowOf(minimum.snapshot, minimum.walk, 'rewards-card').next).toMatchObject({ label: 'Estimated minimum', on: '2026-10-15' })
    const full = fresh(true)
    expect(rowOf(full.snapshot, full.walk, 'rewards-card').next).toMatchObject({ label: 'Estimated payment', minor: 8500000 })
  })

  it('has no model without an open card or loan, so the tab shows its empty state', () => {
    const { snapshot, walk } = world(mortgage, '2026-10-07', (doc) => {
      const loan = doc.accounts.find((a) => a.id === 'mortgage')
      if (loan) loan.archived_at = '2026-10-01T00:00:00+00:00'
    })
    expect(debtsModel(snapshot, walk)).toBeNull()
    expect(debtDetail(snapshot, walk, 'mortgage')).toBeNull()
  })

  it('tries extra payments in Compare: what the paying account has spare in its leanest month, from next month, as a round figure', () => {
    const decoded = (link: DebtLink | null) => {
      if (typeof link !== 'string' || !link.startsWith('/plan/compare#')) throw new Error('not a Compare link')
      const fragment = new URLSearchParams(link.slice(link.indexOf('#') + 1)).get('l') ?? ''
      const levers = decodeLevers(fragment)
      if (!levers.ok) throw new Error(levers.errors.join('; '))
      return levers.value.map((l) => l.patch.add?.map((p) => [p.from_account_id, p.to_account_id, p.amount_minor, p.every, p.starts_on]))
    }
    // Checking gains at least 1,1xx.xx in each of the next 12 months after every bill and payment, so it tries 1,100.00.
    const us = world(usCardsCar)
    expect(spareMonthly(us.walk, 'checking')).toBeGreaterThanOrEqual(110000)
    expect(spareMonthly(us.walk, 'checking')).toBeLessThan(120000)
    expect(decoded(tryExtraLink(us.snapshot, us.walk))).toEqual([[['checking', null, 110000, 'month', '2026-11-01']]])
    const home = world(mortgage)
    expect(decoded(tryExtraLink(home.snapshot, home.walk))).toEqual([[['current', null, roundSpare(spareMonthly(home.walk, 'current')), 'month', '2026-11-01']]])
    // With no month to spare, a tenth of the minimums: US 80.00 + 122.11 + 355.58 = 557.69, a tenth 55.77, so 50.00.
    const lean = world(usCardsCar, '2026-10-09', (doc) => {
      const pay = doc.plan_items.find((i) => i.kind === 'income' && i.to_account_id === 'checking')
      if (pay) pay.amount_minor = 10000
    })
    expect(spareMonthly(lean.walk, 'checking')).toBe(0)
    expect(decoded(tryExtraLink(lean.snapshot, lean.walk))).toEqual([[['checking', null, 5000, 'month', '2026-11-01']]])
    expect([roundFigure(5577), roundFigure(10000), roundFigure(1999), roundFigure(49000), roundFigure(0)]).toEqual([5000, 10000, 1000, 20000, 0])
    expect([roundSpare(175800), roundSpare(9999), roundSpare(99), roundSpare(0)]).toEqual([170000, 9900, 99, 0])
  })
})

describe('Debt detail', () => {
  it('shows the latest statement, installments as n of N and the next 6 cycles, all read from the walk', () => {
    const { snapshot, walk } = world(abroad)
    const detail = debtDetail(snapshot, walk, 'rewards-card') as CardDetail
    expect(detail.statement).toEqual({
      id: 'rewards-last',
      chip: CHIPS.checked,
      provisional: false,
      cut_date: '2026-09-20',
      due_date: '2026-10-16',
      total_minor: 7000000,
      minimum_minor: 210000,
      paid_minor: 2500000,
      remaining_minor: 4500000,
      left_minor: 4500000,
    })
    expect(detail.installments).toEqual([{ plan_item_id: 'laptop', amount_minor: 500000, billed: 4, total: 12, last_month: '2027-05' }])
    expect(detail.cycles.map((c) => c.cut_date)).toEqual(['2026-10-20', '2026-11-20', '2026-12-20', '2027-01-20', '2027-02-20', '2027-03-20'])
    expect(detail.cycles[3]).toEqual({ cut_date: '2027-01-20', due_date: '2027-02-16', total_minor: 350000, minimum_minor: 10500, payment_minor: 350000, interest_minor: 0 })
    expect([detail.interest, detail.warnings, detail.links]).toEqual([
      null,
      [],
      { edit: { pathname: '/settings/account/[id]', params: { id: 'rewards-card' } }, transactions: { pathname: '/money/[accountId]', params: { accountId: 'rewards-card' } } },
    ])
    // The US store card's next cycles carry interest from its unpaid statement.
    const us = world(usCardsCar)
    const store = debtDetail(us.snapshot, us.walk, 'store-card') as CardDetail
    expect(store.cycles[0]).toEqual({ cut_date: '2026-10-24', due_date: '2026-11-18', total_minor: 454406, minimum_minor: 12041, payment_minor: 12041, interest_minor: 7497 })
  })

  it('shows modelled against printed interest, and the statement warnings from the checks', () => {
    const { snapshot, walk } = world(revolvingDaily)
    const detail = debtDetail(snapshot, walk, 'card') as CardDetail
    expect(detail.interest).toEqual({ cut_date: '2026-09-20', printed_minor: 50000, modelled_minor: 53400, variance_minor: 3400 })
    const off = world(abroad, '2026-10-07', (doc) => {
      const last = doc.statements.find((s) => s.id === 'rewards-last')
      // A printed installment line 100.00 above the plan, the charges 100.00 lower so it still balances.
      if (last && last.installments_minor != null && last.charges_minor != null) Object.assign(last, { installments_minor: last.installments_minor + 10000, charges_minor: last.charges_minor - 10000 })
    })
    const warned = debtDetail(off.snapshot, off.walk, 'rewards-card') as CardDetail
    expect(warned.warnings.map((w) => [w.word, w.printed_minor, w.expected_minor, w.difference_minor])).toEqual([['Installments differ from your plan', 510000, 500000, 10000]])
    expect(rowOf(off.snapshot, off.walk, 'rewards-card').warnings).toEqual(['Installments differ from your plan'])
  })

  it('shows a loan balance, payment, rate and payoff month', () => {
    const { snapshot, walk } = world(mortgage)
    const detail = debtDetail(snapshot, walk, 'mortgage') as LoanDetail
    expect([detail.kind, detail.row.owed_minor, detail.payment_minor, detail.payment_day, detail.row.annual_rate, detail.row.payoff]).toEqual([
      'loan',
      debtFigures(snapshot, walk).loans[0]?.owed_minor,
      100000,
      1,
      0.0425,
      [{ text: 'Paid off by ' }, { month: '2045-04' }, { text: ', after the projection' }],
    ])
    expect(debtDetail(snapshot, walk, 'current')).toBeNull()
    expect(debtDetail(snapshot, walk, 'nope')).toBeNull()
  })

  it('marks a loan payment day passed with nothing paid as Overdue, Pay prefilling it', () => {
    const { snapshot, walk } = world(usCardsCar, '2026-10-25')
    const car = rowOf(snapshot, walk, 'car-loan')
    expect([car.state, car.next?.on, car.next?.minor, car.next?.overdue]).toEqual([{ text: 'Overdue', tone: 'negative' }, '2026-10-20', 35558, true])
    expect(prefill(snapshot, walk, car.action?.link).amount).toBe('355.58')
  })
})

describe('the debt chart', () => {
  it('stacks each debt’s total debt now and at each month end to the debt-free month, the last paid off at the bottom', () => {
    const us = world(usCardsCar, '2026-10-10')
    const [pane, ...rest] = debtPanes(us.snapshot, us.walk)
    const m = debtsModel(us.snapshot, us.walk)
    expect([rest.length, pane?.currency, pane?.days.length, pane?.days[0], pane?.days.at(-1), pane?.free_month, m?.headline.value]).toEqual([0, 'USD', 41, '2026-10-10', '2030-01-31', '2030-01', [{ month: '2030-01' }]])
    // Now is today's total debt, as each card says; each clears at its own payoff month, as its card's 'Paid off by' does.
    expect(pane?.series.map((s) => [s.account_id, s.colour, s.owed[0], s.owed.at(-1), s.clears_at, pane.days[s.clears_at ?? 0]?.slice(0, 7)])).toEqual([
      ['car-loan', 4, 1774792, 0, 40, '2030-01'],
      ['store-card', 3, 459120, 0, 20, '2028-05'],
      ['travel-card', 2, 204250, 0, 7, '2027-04'],
    ])
    // Revolving balances clear in May 2028, the month the hero names.
    expect([pane?.revolving_at, pane?.days[pane.revolving_at ?? 0], m?.revolving?.value]).toEqual([20, '2028-05-31', [{ month: '2028-05' }]])
  })

  it('runs to the projection’s end when a debt outlasts it, with no debt-free month', () => {
    const uk = world(mortgage, '2026-10-10')
    const [pane] = debtPanes(uk.snapshot, uk.walk)
    expect([pane?.days.length, pane?.free_month, pane?.series.map((s) => [s.account_id, s.owed[0], s.clears_at])]).toEqual([62, null, [['mortgage', 18390849, null]]])
  })
})
