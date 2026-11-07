import { buildSnapshot, firstOfMonth, ledgerTotals, monthFigures, monthKey, plainNames, renderCopy, runEngine, type Snapshot, type Walk } from '@waypoint/core'
import { abroad, markSize, mortgage, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { breakdownOf, LINE_KINDS, ROW_KINDS } from './breakdown.model'
import { cashAccounts, monthKind, strip } from './months.model'

const AS_OF = '2026-10-09'

function world(build: (asOf: string) => Sample, asOf = AS_OF, edit?: (doc: SampleDoc) => void): { snapshot: Snapshot; walk: Walk } {
  const sample = build(asOf)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, asOf, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return { snapshot, walk: run.walk }
}

type Totals = Record<string, { in: number; out: number }>

// The engine's own month per currency: money in and out with top-ups, summed over the cash accounts Months shows.
function engineMonth(snapshot: Snapshot, walk: Walk, month: string): Totals {
  const out: Totals = {}
  for (const a of cashAccounts(snapshot)) {
    const f = monthFigures(walk, a.id, month)
    if (!f) throw new Error(`no ${month} for ${a.id}`)
    const t = (out[a.currency] ??= { in: 0, out: 0 })
    t.in += f.in_minor + f.top_up_in_minor
    t.out += f.out_minor + f.top_up_out_minor
  }
  return out
}

// A past month's rows per currency, from the ledger.
function ledgerMonthTotals(snapshot: Snapshot, month: string): Totals {
  const out: Totals = {}
  for (const a of cashAccounts(snapshot)) {
    const t = ledgerTotals(snapshot, a.id, month)
    const sum = (out[a.currency] ??= { in: 0, out: 0 })
    sum.in += t.in_minor
    sum.out += t.out_minor
  }
  return out
}

// This month's rows from its first day to today, which the walk holds in its opening balance rather than its lines.
function rowsSoFar(snapshot: Snapshot): Totals {
  const out: Totals = {}
  const first = firstOfMonth(snapshot.as_of)
  for (const a of cashAccounts(snapshot)) {
    const t = (out[a.currency] ??= { in: 0, out: 0 })
    for (const r of snapshot.doc.transactions) {
      if (r.account_id !== a.id || r.posted_on < first || r.posted_on > snapshot.as_of) continue
      if (r.amount_minor > 0) t.in += r.amount_minor
      else t.out -= r.amount_minor
    }
  }
  return out
}

// Moves in the month between two shown cash accounts in one currency, read from the walk's paired lines and the entered transfers' legs, never from Breakdown.
function moves(snapshot: Snapshot, walk: Walk, month: string): Record<string, number> {
  const currency = new Map(cashAccounts(snapshot).map((a) => [a.id, a.currency]))
  const out: Record<string, number> = {}
  const add = (from: string, to: string, sent: number, landed: number) => {
    const c = currency.get(from)
    if (c !== undefined && c === currency.get(to) && sent === landed) out[c] = (out[c] ?? 0) + sent
  }
  const lines = new Map(walk.lines.map((l) => [l.id, l]))
  for (const l of walk.lines) {
    const pair = l.pair_id === null ? undefined : lines.get(l.pair_id)
    if (pair && l.amount_minor < 0 && monthKey(l.date) === month && monthKey(pair.date) === month) add(l.account_id, pair.account_id, -l.amount_minor, pair.amount_minor)
  }
  const rows = snapshot.doc.transactions
  for (const t of rows) {
    const into = t.transfer_id && t.amount_minor < 0 ? rows.find((r) => r.transfer_id === t.transfer_id && r.id !== t.id) : undefined
    if (into && monthKey(t.posted_on) === month && monthKey(into.posted_on) === month) add(t.account_id, into.account_id, -t.amount_minor, into.amount_minor)
  }
  return out
}

// What Breakdown totals: a past month's rows, else the engine month with this month's rows so far, each less the moves inside one currency.
function expected(snapshot: Snapshot, walk: Walk, month: string): Totals {
  const kind = monthKind(month, snapshot.as_of)
  const base = kind === 'past' ? ledgerMonthTotals(snapshot, month) : engineMonth(snapshot, walk, month)
  const before = kind === 'current' ? rowsSoFar(snapshot) : {}
  const less = moves(snapshot, walk, month)
  return Object.fromEntries(Object.entries(base).map(([c, t]) => [c, { in: t.in + (before[c]?.in ?? 0) - (less[c] ?? 0), out: t.out + (before[c]?.out ?? 0) - (less[c] ?? 0) }]))
}

const totals = (b: ReturnType<typeof breakdownOf>): Totals => Object.fromEntries(b.currencies.map((c) => [c.currency, { in: c.in_minor, out: c.out_minor }]))
// A currency with nothing coming in or going out reads as zero whether or not it has a section.
const moving = (t: Totals): Totals => Object.fromEntries(Object.entries(t).filter(([, x]) => x.in !== 0 || x.out !== 0))

describe('Breakdown totals', () => {
  it('equal the engine month less moves inside one currency, this month with its rows so far, in both currencies on abroad', () => {
    const { snapshot, walk } = world(abroad)
    const october = breakdownOf(snapshot, walk, '2026-10')
    // The tax set-aside moves €600.00 between two euro accounts; the top-ups cross into pesos and count.
    expect(moves(snapshot, walk, '2026-10')).toEqual({ EUR: 60000 })
    expect(rowsSoFar(snapshot)).toEqual({ EUR: { in: 0, out: 155000 }, PHP: { in: 3775000, out: 0 } })
    expect(totals(october)).toEqual({ EUR: { in: 400000, out: 229237 }, PHP: { in: 7745014, out: 4970000 } })
    expect(totals(october)).toEqual(expected(snapshot, walk, '2026-10'))
    for (const month of walk.months) expect([month, moving(totals(breakdownOf(snapshot, walk, month)))]).toEqual([month, moving(expected(snapshot, walk, month))])
  })

  it('equal the engine month less moves on every fixture, and the rows of a past month', () => {
    for (const build of [usCardsCar, mortgage, markSize]) {
      const { snapshot, walk } = world(build)
      for (const month of walk.months.slice(0, 13)) expect([month, moving(totals(breakdownOf(snapshot, walk, month)))]).toEqual([month, moving(expected(snapshot, walk, month))])
    }
    const { snapshot, walk } = world(abroad)
    const september = breakdownOf(snapshot, walk, '2026-09')
    expect(moves(snapshot, walk, '2026-09')).toEqual({ EUR: 60000 })
    expect([september.kind, totals(september)]).toEqual(['past', expected(snapshot, walk, '2026-09')])
  })

  it('adds up its kinds to the currency total, in a fixed order, moves in neither', () => {
    const { snapshot, walk } = world(abroad)
    for (const chip of strip(snapshot, walk)) {
      const b = breakdownOf(snapshot, walk, chip.month)
      const order: readonly string[] = b.kind === 'past' ? ROW_KINDS : LINE_KINDS
      for (const c of b.currencies) {
        expect(c.groups.reduce((t, g) => t + g.in_minor, 0)).toBe(c.in_minor)
        expect(c.groups.reduce((t, g) => t + g.out_minor, 0)).toBe(c.out_minor)
        const kinds = c.groups.map((g) => order.indexOf(g.kind))
        expect(kinds).toEqual([...kinds].sort((x, y) => x - y))
        for (const g of c.groups) expect(g.lines.reduce((t, l) => t + (l.move ? 0 : l.amount_minor), 0)).toBe(g.in_minor - g.out_minor)
      }
    }
  })
})

describe('Breakdown lines', () => {
  it('lists the month by kind with flags as words and each budget’s figures', () => {
    const { snapshot, walk } = world(abroad)
    const names = plainNames(snapshot)
    const b = breakdownOf(snapshot, walk, '2026-10')
    const read = b.currencies.map((c) => [c.currency, c.groups.map((g) => [g.title, g.lines.map((l) => [renderCopy(l.title, names), l.amount_minor, l.words.join(', ')])])])
    expect(read).toEqual([
      [
        'EUR',
        [
          ['Recorded so far', [['Rent', -90000, ''], ['Top-up', -50000, ''], ['Supermarket', -9000, ''], ['Bakery', -6000, '']]],
          ['Income', [['Salary', 400000, '']]],
          ['Budgets', [['Groceries', -20000, 'Spending fast']]],
          ['Transfers', [['Tax set-aside', 60000, '']]],
          ['Top-ups', [['Top-up to Pesos', -38043, 'To send'], ['Top-up to Pesos', -16194, 'To send']]],
        ],
      ],
      [
        'PHP',
        [
          ['Recorded so far', [['Top-up', 3475000, ''], ['Repayment from a friend', 300000, '']]],
          ['Income', [['Loan to a friend, repaid in slices', 200000, 'Partly settled']]],
          ['Bills', [['Mobile plan', -120000, ''], ['Insurance', -350000, 'Estimated']]],
          ['Card and loan payments', [['Rewards card payment', -4500000, '']]],
          ['Top-ups', [['Top-up from Main', 2644369, 'To send'], ['Top-up from Main', 1125645, 'To send']]],
        ],
      ],
    ])
    const budget = b.currencies[0]?.groups.find((g) => g.kind === 'budgets')?.lines[0]?.budget
    expect(budget).toEqual({ currency: 'EUR', budget_minor: 35000, spent_minor: 15000 })
  })

  it('lists a move inside one currency once, unsigned and in neither total, and a move across currencies as two counted legs', () => {
    const { snapshot, walk } = world(abroad)
    const [eur, php] = breakdownOf(snapshot, walk, '2026-10').currencies
    const transfers = eur?.groups.find((g) => g.kind === 'transfers')
    expect([transfers?.in_minor, transfers?.out_minor, transfers?.lines.map((l) => [l.id, l.account_id, l.other_account_id, l.amount_minor, l.move])]).toEqual([0, 0, [['tax-set-aside:2026-10-01#out', 'main', 'tax', 60000, true]]])
    // Main's euros leave and Pesos' pesos land: real money out of one currency and into the other.
    const [out, into] = [eur?.groups.find((g) => g.kind === 'top_ups'), php?.groups.find((g) => g.kind === 'top_ups')]
    expect([out?.out_minor, out?.lines.map((l) => l.move), into?.in_minor, into?.lines.map((l) => l.move)]).toEqual([54237, [false, false], 3770014, [false, false]])

    // A past month's entered transfer between the two euro accounts lists once; the one to Pesos keeps both legs, and card payments leave cash.
    const september = breakdownOf(snapshot, walk, '2026-09').currencies
    const legs = (c: string) => september.find((x) => x.currency === c)?.groups.find((g) => g.kind === 'transfers')?.lines.map((l) => [l.id, l.amount_minor, l.move])
    expect([legs('EUR'), legs('PHP')]).toEqual([
      [
        ['row:topup-last-out', -60000, false],
        ['row:tax-last-out', 60000, true],
      ],
      [
        ['row:rewards-paid-before-out', -3800000, false],
        ['row:topup-last-in', 4170000, false],
        ['row:shopping-paid-before-out', -1500000, false],
        ['row:rewards-part-1-out', -2500000, false],
      ],
    ])

    // Tax funded from Main with a floor from January: a top-up inside euros lists once, from Main.
    const funded = world(abroad, AS_OF, (doc) => {
      const tax = doc.accounts.find((a) => a.id === 'tax')
      if (!tax) throw new Error('no tax account')
      Object.assign(tax, { funded_from_account_id: 'main', floor_windows: [{ from_month: '2027-01', to_month: null, amount_minor: 500000 }] })
    })
    const sent = funded.walk.lines.find((l) => l.id.startsWith('top-up:main>tax:') && l.amount_minor < 0)
    if (!sent) throw new Error('no top-up into Tax')
    const ups = breakdownOf(funded.snapshot, funded.walk, monthKey(sent.date)).currencies.find((c) => c.currency === 'EUR')?.groups.find((g) => g.kind === 'top_ups')
    const mine = ups?.lines.filter((l) => l.id.startsWith('top-up:main>tax:'))
    expect(mine?.map((l) => [l.id, l.account_id, l.other_account_id, l.amount_minor, l.move])).toEqual([[sent.id, 'main', 'tax', -sent.amount_minor, true]])
    // The group's euros out are the top-ups to Pesos alone.
    const pesos = funded.walk.lines.filter((l) => l.id.startsWith('top-up:main>pesos:') && l.amount_minor < 0 && monthKey(l.date) === monthKey(sent.date))
    expect([ups?.in_minor, ups?.out_minor]).toEqual([0, pesos.reduce((t, l) => t - l.amount_minor, 0)])
  })

  it('starts this month on its first day with what is recorded so far, first in each currency, and lists each row once', () => {
    const { snapshot, walk } = world(abroad, AS_OF, (doc) => {
      doc.transactions.push(
        { id: 'tax-extra-out', account_id: 'main', posted_on: '2026-10-05', amount_minor: -10000, kind: 'transfer', description: 'Extra for tax', transfer_id: 'tax-extra' },
        { id: 'tax-extra-in', account_id: 'tax', posted_on: '2026-10-05', amount_minor: 10000, kind: 'transfer', description: 'Extra for tax', transfer_id: 'tax-extra' },
        // Dated today: in the walk's opening balance, so recorded so far.
        { id: 'coffee', account_id: 'main', posted_on: AS_OF, amount_minor: -2500, kind: 'expense', description: 'Coffee' },
        { id: 'concert', account_id: 'main', posted_on: '2026-10-20', amount_minor: -4000, kind: 'expense', description: 'Concert tickets' },
        { id: 'tax-later-out', account_id: 'main', posted_on: '2026-10-21', amount_minor: -5000, kind: 'transfer', description: '', transfer_id: 'tax-later' },
        { id: 'tax-later-in', account_id: 'tax', posted_on: '2026-10-21', amount_minor: 5000, kind: 'transfer', description: '', transfer_id: 'tax-later' },
        { id: 'pesos-later-out', account_id: 'main', posted_on: '2026-10-22', amount_minor: -10000, kind: 'transfer', description: '', transfer_id: 'pesos-later' },
        { id: 'pesos-later-in', account_id: 'pesos', posted_on: '2026-10-22', amount_minor: 700000, kind: 'transfer', description: '', transfer_id: 'pesos-later' },
      )
    })
    const names = plainNames(snapshot)
    const b = breakdownOf(snapshot, walk, '2026-10')
    expect([b.from, b.to, b.currencies.map((c) => c.groups[0]?.title)]).toEqual(['2026-10-01', '2026-10-31', ['Recorded so far', 'Recorded so far']])
    const [eur] = b.currencies
    const read = (kind: string) => eur?.groups.find((g) => g.kind === kind)?.lines.map((l) => [l.id, renderCopy(l.title, names), l.amount_minor, l.move])
    expect(read('recorded')).toEqual([
      ['row:rent-now', 'Rent', -90000, false],
      ['row:topup-now-out', 'Top-up', -50000, false],
      ['row:groceries-4', 'Supermarket', -9000, false],
      ['row:tax-extra-out', 'Extra for tax', 10000, true],
      ['row:groceries-5', 'Bakery', -6000, false],
      ['row:coffee', 'Coffee', -2500, false],
    ])
    // A transfer with no description reads the same before and after today, and one across currencies names where it went.
    expect(read('entered')).toEqual([
      ['row:concert', 'Concert tickets', -4000, false],
      ['row:tax-later-out', 'Transfer to Tax', 5000, true],
      ['row:pesos-later-out', 'Transfer to Pesos', -10000, false],
    ])
    const landed = b.currencies[1]?.groups.find((g) => g.kind === 'entered')?.lines.find((l) => l.id === 'row:pesos-later-in')
    expect([landed && renderCopy(landed.title, names), landed?.other_account_id, eur?.groups.find((g) => g.kind === 'entered')?.lines.find((l) => l.id === 'row:pesos-later-out')?.other_account_id]).toEqual(['Transfer from Main', 'main', 'pesos'])

    // Every October row on a shown account lists once, but a move's landing leg; none dated up to today is also a walk line.
    const shown = new Set(cashAccounts(snapshot).map((a) => a.id))
    const october = snapshot.doc.transactions.filter((t) => shown.has(t.account_id) && monthKey(t.posted_on) === '2026-10')
    const landings = new Set(['tax-extra-in', 'tax-later-in'])
    const listed = b.currencies.flatMap((c) => c.groups.flatMap((g) => g.lines.map((l) => l.id))).filter((id) => id.startsWith('row:'))
    expect([...listed].sort()).toEqual(october.filter((t) => !landings.has(t.id)).map((t) => `row:${t.id}`).sort())
    const recorded = new Set(october.filter((t) => t.posted_on <= AS_OF).map((t) => t.id))
    expect(walk.lines.filter((l) => l.row_id !== null && recorded.has(l.row_id))).toEqual([])

    expect(moves(snapshot, walk, '2026-10')).toEqual({ EUR: 75000 })
    expect(totals(b)).toEqual(expected(snapshot, walk, '2026-10'))
  })

  it('counts both legs of a transfer inside one currency when its legs fall in two months', () => {
    const before = world(abroad)
    const { snapshot, walk } = world(abroad, AS_OF, (doc) => {
      doc.transactions.push(
        // Out on 30 Sep and in on 1 Oct, as the database allows: each month holds one leg, which is money out of or into it.
        { id: 'tax-turn-out', account_id: 'main', posted_on: '2026-09-30', amount_minor: -60000, kind: 'transfer', description: '', transfer_id: 'tax-turn' },
        { id: 'tax-turn-in', account_id: 'tax', posted_on: '2026-10-01', amount_minor: 60000, kind: 'transfer', description: '', transfer_id: 'tax-turn' },
      )
    })
    const names = plainNames(snapshot)
    const eur = (w: { snapshot: Snapshot; walk: Walk }, month: string) => breakdownOf(w.snapshot, w.walk, month).currencies.find((c) => c.currency === 'EUR')
    const legs = (month: string) => eur({ snapshot, walk }, month)?.groups.flatMap((g) => g.lines.filter((l) => l.id.startsWith('row:tax-turn-')).map((l) => [g.kind, l.id, renderCopy(l.title, names), l.amount_minor, l.move]))
    expect(legs('2026-09')).toEqual([['transfers', 'row:tax-turn-out', 'Transfer to Tax', -60000, false]])
    expect(legs('2026-10')).toEqual([['recorded', 'row:tax-turn-in', 'Transfer from Main', 60000, false]])

    // September is rows alone and October's recorded group the rows so far, so each moves by exactly the legs it holds.
    const [september, was] = [eur({ snapshot, walk }, '2026-09'), eur(before, '2026-09')]
    expect([(september?.in_minor ?? 0) - (was?.in_minor ?? 0), (september?.out_minor ?? 0) - (was?.out_minor ?? 0)]).toEqual([0, 60000])
    const recorded = (w: { snapshot: Snapshot; walk: Walk }) => eur(w, '2026-10')?.groups.find((g) => g.kind === 'recorded')
    expect([(recorded({ snapshot, walk })?.in_minor ?? 0) - (recorded(before)?.in_minor ?? 0), (recorded({ snapshot, walk })?.out_minor ?? 0) - (recorded(before)?.out_minor ?? 0)]).toEqual([60000, 0])
    // The guard's own moves leave it out too: only the plan's set-aside folds in each month.
    expect([moves(snapshot, walk, '2026-09'), moves(snapshot, walk, '2026-10')]).toEqual([{ EUR: 60000 }, { EUR: 60000 }])
    for (const month of ['2026-09', '2026-10']) expect([month, totals(breakdownOf(snapshot, walk, month))]).toEqual([month, expected(snapshot, walk, month)])
  })

  it('says Late on income carried to the first of next month', () => {
    const sample = abroad('2026-10-10')
    sample.doc.plan_items.push({ id: 'deposit-back', kind: 'income', name: 'Deposit back', to_account_id: 'main', amount_minor: 80000, every: 'once', starts_on: '2026-09-21' })
    const snapshot = buildSnapshot(sample.doc, '2026-10-10', sample.rates)
    const run = runEngine(snapshot)
    if (!run.ok) throw new Error('the engine did not run')
    const income = breakdownOf(snapshot, run.walk, '2026-11').currencies.find((c) => c.currency === 'EUR')?.groups.find((g) => g.kind === 'income')
    expect(income?.lines.filter((l) => l.words.includes('Late')).map((l) => [l.id, l.date, l.amount_minor])).toEqual([['deposit-back:2026-09-01', '2026-11-01', 80000]])
  })

  it('says Overdue on a bill whose day has passed', () => {
    const { snapshot, walk } = world(abroad, '2026-10-23')
    const bills = breakdownOf(snapshot, walk, '2026-10').currencies.find((c) => c.currency === 'PHP')?.groups.find((g) => g.kind === 'bills')
    expect(bills?.lines.map((l) => l.words)).toEqual([['Overdue', 'Estimated'], ['Overdue']])
  })
})
