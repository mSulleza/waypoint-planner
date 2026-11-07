import { addOnInstallment, buildSnapshot, type CompareResult, type CompareRow, type Lever, type Snapshot } from '@waypoint/core'
import {
  amountLever,
  compare,
  dayLever,
  decodeLevers,
  endLever,
  extraPaymentLever,
  floorWindowLever,
  fxShiftLever,
  incomeGapLever,
  loanOfferLever,
  registry,
  removeLever,
  sortRows,
  upsideLever,
} from '@waypoint/core/compare'
import { abroad, usCardsCar, type Sample } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import {
  cardCells,
  columnsOf,
  compareLink,
  compareView,
  draftOf,
  floorWindowsFor,
  fragmentOf,
  leverCopy,
  leverKinds,
  leversOf,
  newDraft,
  offerCost,
  pickCard,
  pickItem,
  readLever,
  readRate,
  slotsOf,
  verdictOf,
  withEmi,
  type LeverDraft,
  type LeverKind,
} from './compare.model'

const AS_OF = '2026-10-07'
const LOCALE = 'en-IE'

function build(sample: (asOf: string) => Sample): Snapshot {
  const { doc, rates } = sample(AS_OF)
  return buildSnapshot(doc, AS_OF, rates)
}

async function measured(snapshot: Snapshot, levers: readonly Lever[]): Promise<CompareResult[]> {
  const rows: CompareResult[] = []
  for await (const row of compare(snapshot, levers, { pause: () => Promise.resolve() })) rows.push(row)
  return rows
}

const ok = (row: CompareResult | undefined): CompareRow => {
  if (!row?.ok) throw new Error(`row failed: ${row ? row.errors.join('; ') : 'missing'}`)
  return row
}

function lever(snapshot: Snapshot, kind: LeverKind, edit: (d: LeverDraft) => LeverDraft = (d) => d): Lever {
  const reg = registry(snapshot)
  const read = readLever(snapshot, reg, edit(newDraft(snapshot, reg, kind, LOCALE)), LOCALE)
  if (!read.ok) throw new Error(`draft did not read: ${JSON.stringify(read.errors)}`)
  return read.lever
}

const rentPlus50 = (snapshot: Snapshot) => lever(snapshot, 'amount', (d) => ({ ...pickItem(snapshot, registry(snapshot), d, 'rent', LOCALE), amount: '950.00' }))

describe('Compare view', () => {
  it('gives rent +50 on abroad the same deltas as core compare(), and its card lists only the figures that moved', async () => {
    const snapshot = build(abroad)
    const rent = rentPlus50(snapshot)
    expect(rent).toEqual(amountLever(snapshot, 'rent', 95000, '2026-11'))
    const rows = await measured(snapshot, [rent])
    const core = ok(rows[1])
    const view = compareView(snapshot, [rent], rows, 'net_worth', LOCALE)
    expect(view.columns.map((c) => c.id)).toEqual(['net_worth', 'lowest:main', 'lowest:tax', 'lowest:pesos', 'days_under_floor', 'fx_margin', 'debt_free_month', 'interest'])
    expect(view.rows.map((r) => [r.key, r.state])).toEqual([
      ['baseline', 'ready'],
      ['lever:0', 'ready'],
    ])
    const row = view.rows[1]
    if (!row) throw new Error('no lever row')
    const change = (id: string) => row.cells.find((c) => c.column === id)?.change ?? null
    expect(change('net_worth')).toEqual({ kind: 'money', minor: core.delta_net_worth?.minor, currency: 'EUR' })
    for (const l of core.lowest_by_account) expect(change(`lowest:${l.account_id}`)).toEqual(l.delta_minor === 0 ? null : { kind: 'money', minor: l.delta_minor, currency: l.currency })
    expect(change('days_under_floor')).toEqual(core.delta_days_under_floor === 0 ? null : { kind: 'days', n: core.delta_days_under_floor })
    expect(change('fx_margin')).toEqual(core.moved.fx_margin ? { kind: 'points', fraction: core.delta_fx_margin } : null)
    expect(change('interest')).toEqual(core.moved.interest ? { kind: 'money', minor: core.delta_interest_total?.minor, currency: 'EUR' } : null)
    // €50 more from Nov 2026 to the end of the projection in Oct 2031: 60 rents.
    // Main's lowest day comes before November, so only net worth moves.
    expect([core.delta_net_worth?.minor, core.lowest_by_account.map((l) => [l.account_id, l.delta_minor]), core.delta_days_under_floor, core.delta_fx_margin]).toEqual([-300000, [['main', 0], ['tax', 0], ['pesos', 0]], 0, 0])
    expect(cardCells(row).map((c) => [c.column, c.change, c.verdict])).toEqual([['net_worth', { kind: 'money', minor: -300000, currency: 'EUR' }, 'Worse']])
    // The baseline card lists every figure, with no change beside any.
    const base = view.rows[0]
    expect(base && cardCells(base).map((c) => [c.column, c.value.kind, c.change])).toEqual(view.columns.map((c) => [c.id, c.id === 'debt_free_month' ? 'copy' : c.id === 'days_under_floor' ? 'days' : c.id === 'fx_margin' ? 'percent' : 'money', null]))
  })

  it('re-sorts the options by the picked figure as core sortRows does, with options still measuring last in link order', async () => {
    const snapshot = build(abroad)
    const levers = [rentPlus50(snapshot), fxShiftLever(snapshot, -0.1), dayLever(snapshot, 'salary', 20, '2026-10')]
    const rows = await measured(snapshot, levers)
    const keys = (sortId: string) => compareView(snapshot, levers, rows, sortId, LOCALE).rows.map((r) => r.key)
    const coreOrder = (metric: Parameters<typeof sortRows>[1], account?: string) => sortRows(rows, metric, account).map((r) => (r.role === 'lever' ? `lever:${levers.findIndex((l) => l.label === r.label)}` : r.role))
    expect(keys('net_worth')).toEqual(coreOrder('net_worth'))
    expect(keys('days_under_floor')).toEqual(coreOrder('days_under_floor'))
    expect(keys('lowest:pesos')).toEqual(coreOrder('lowest', 'pesos'))
    // Moving the salary to the 20th leaves net worth as it is but takes 16 days off under the floors, so it leads on both; all together carries rent's loss and the weaker euro.
    expect(keys('net_worth')).toEqual(['baseline', 'lever:2', 'lever:1', 'lever:0', 'together'])
    expect(keys('days_under_floor')).toEqual(['baseline', 'lever:2', 'together', 'lever:0', 'lever:1'])
    // Remove names each change by its place as listed, so a screen reader hears change 1, 2 and 3 down the screen.
    expect(compareView(snapshot, levers, rows, 'days_under_floor', LOCALE).rows.map((r) => r.place)).toEqual([null, 1, null, 2, 3])
    // An unknown sort reads as net worth.
    expect(keys('nonsense')).toEqual(keys('net_worth'))
    const partial = compareView(snapshot, levers, [rows[0] ?? null, null, rows[2] ?? null, null, null], 'net_worth', LOCALE)
    expect(partial.rows.map((r) => [r.key, r.state])).toEqual([
      ['baseline', 'ready'],
      ['lever:1', 'ready'],
      ['lever:0', 'measuring'],
      ['lever:2', 'measuring'],
      ['together', 'measuring'],
    ])
    expect(partial.done).toBe(false)
    expect(slotsOf(1).map((s) => s.role)).toEqual(['baseline', 'lever'])
  })

  it('keeps each of two identical changes in its own row, though they share one measured result', async () => {
    const snapshot = build(abroad)
    const rent = rentPlus50(snapshot)
    const levers = [rent, rent]
    const [baseline, first, , together] = await measured(snapshot, levers)
    // A memo keyed by the lever hands both slots the same object.
    const rows = [baseline ?? null, first ?? null, first ?? null, together ?? null]
    expect(compareView(snapshot, levers, rows, 'net_worth', LOCALE).rows.map((r) => r.key).sort()).toEqual(['baseline', 'lever:0', 'lever:1', 'together'])
  })

  it('shows a loan offer that lands before the store card cut with its interest change', async () => {
    const snapshot = build(usCardsCar)
    const reg = registry(snapshot)
    const offer = lever(snapshot, 'offer', (d) => {
      const card = pickCard(snapshot, reg, d, 'travel-card', LOCALE)
      return withEmi(snapshot, { ...card, to: 'store-card', amount: '4000.00', term: '12', rate: '1', month: '2026-11' }, LOCALE)
    })
    expect(offer.patch).toEqual(loanOfferLever(snapshot, { amount_minor: 400000, term_months: 12, monthly_rate: 0.01, draw_month: '2026-11', to_account_id: 'store-card', card_id: 'travel-card' }).patch)
    const rows = await measured(snapshot, [offer])
    const core = ok(rows[1])
    const view = compareView(snapshot, [offer], rows, 'interest', LOCALE)
    const card = view.rows.find((r) => r.key === 'lever:0')
    const interest = card && cardCells(card).find((c) => c.column === 'interest')
    expect(core.moved.interest).toBe(true)
    expect(interest?.change).toEqual({ kind: 'money', minor: core.delta_interest_total?.minor, currency: 'USD' })
    expect(core.delta_interest_total?.minor).toBeLessThan(0)
    // Less interest is better, so the minus reads as good.
    expect(interest?.verdict).toBe('Better')
    expect(view.columns.map((c) => c.id)).toEqual(['net_worth', 'lowest:checking', 'lowest:savings', 'days_under_floor', 'debt_free_month', 'interest'])
  })

  it('says a margin at the end of the breakeven search is that much or more', async () => {
    const snapshot = build(abroad)
    const offer = loanOfferLever(snapshot, { amount_minor: 15000000, term_months: 12, monthly_rate: 0.0097, draw_month: '2026-10', to_account_id: 'pesos', card_id: 'rewards-card' })
    const levers = [offer, fxShiftLever(snapshot, -0.1)]
    const rows = await measured(snapshot, levers)
    const fx = (key: string) => compareView(snapshot, levers, rows, 'net_worth', LOCALE).rows.find((r) => r.key === key)?.cells.find((c) => c.column === 'fx_margin')?.value
    // ₱150,000 in Pesos today keeps every day above zero even at half the euro's rate; 10% weaker alone does not reach the end of the search.
    expect([fx('baseline'), fx('lever:0'), fx('lever:1')]).toEqual([
      { kind: 'percent', fraction: 0.311, or_more: false },
      { kind: 'percent', fraction: 0.5, or_more: true },
      { kind: 'percent', fraction: 0.234, or_more: false },
    ])
  })

  it('names a failed lever and keeps it after the measured options', async () => {
    const snapshot = build(abroad)
    const gone: Lever = { label: 'Rent: €950.00 from Nov 2026', patch: { items: { 'no-such': { amount_minor: 95000, from_month: '2026-11' } } } }
    const rows = await measured(snapshot, [gone, fxShiftLever(snapshot, -0.1)])
    const view = compareView(snapshot, [gone, fxShiftLever(snapshot, -0.1)], rows, 'net_worth', LOCALE)
    expect(view.rows.map((r) => [r.key, r.state, r.opaque, r.errors])).toEqual([
      ['baseline', 'ready', false, []],
      ['lever:1', 'ready', false, []],
      ['lever:0', 'failed', true, ["items.no-such: no plan item 'no-such'"]],
      ['together', 'failed', false, ["items.no-such: no plan item 'no-such'"]],
    ])
  })
})

describe('Lever words', () => {
  it('reads every kind back from its patch with each amount as a money part', () => {
    const abroadSnap = build(abroad)
    const us = build(usCardsCar)
    const words = (snapshot: Snapshot, l: Lever) => leverCopy(snapshot, l, LOCALE)
    expect(words(abroadSnap, amountLever(abroadSnap, 'rent', 95000, '2026-11'))).toEqual({ copy: [{ item: 'rent' }, { text: ': ' }, { money: { minor: 95000, currency: 'EUR' } }, { text: ' from ' }, { month: '2026-11' }], name: 'Rent' })
    expect(words(abroadSnap, dayLever(abroadSnap, 'salary', 20, '2026-10'))?.copy).toEqual([{ item: 'salary' }, { text: ': day 20 from ' }, { month: '2026-10' }])
    expect(words(abroadSnap, endLever(abroadSnap, 'rent', '2027-03-31'))?.copy).toEqual([{ item: 'rent' }, { text: ': ends 31 Mar 2027' }])
    expect(words(abroadSnap, endLever(abroadSnap, 'rent', null))?.copy).toEqual([{ item: 'rent' }, { text: ': no end date' }])
    expect(words(abroadSnap, removeLever(abroadSnap, 'mobile'))?.copy).toEqual([{ text: 'Remove ' }, { item: 'mobile' }])
    expect(words(abroadSnap, upsideLever(abroadSnap, 'camera-sale'))?.copy).toEqual([{ text: 'Include ' }, { item: 'camera-sale' }])
    expect(words(abroadSnap, fxShiftLever(abroadSnap, -0.1))).toEqual({ copy: [{ text: 'EUR weaker by 10%' }], name: 'EUR rate' })
    expect(words(abroadSnap, incomeGapLever(abroadSnap, { from_month: '2026-11', months: 3, item_ids: ['salary'] }))?.copy).toEqual([{ text: 'Salary stops for 3 months from ' }, { month: '2026-11' }])
    expect(words(abroadSnap, floorWindowLever(abroadSnap, 'main', [{ from_month: '2026-11', to_month: null, amount_minor: 300000 }]))?.copy).toEqual([
      { account: 'main' },
      { text: ' floor: ' },
      { money: { minor: 300000, currency: 'EUR' } },
      { text: ' from ' },
      { month: '2026-11' },
    ])
    expect(words(abroadSnap, extraPaymentLever(abroadSnap, { amount_minor: 1000000, every: 'month', starts_on: '2026-11-01', from_account_id: 'pesos' }))?.copy).toEqual([
      { text: 'Extra for debts from ' },
      { account: 'pesos' },
      { text: ': ' },
      { money: { minor: 1000000, currency: 'PHP' } },
      { text: ' a month from ' },
      { month: '2026-11' },
    ])
    expect(words(us, loanOfferLever(us, { amount_minor: 400000, term_months: 12, monthly_rate: 0.01, draw_month: '2026-11', draw_day: 10, to_account_id: 'store-card', card_id: 'travel-card' }))).toEqual({
      copy: [
        { text: 'Loan offer ' },
        { money: { minor: 400000, currency: 'USD' } },
        { text: ' into ' },
        { account: 'store-card' },
        { text: ' on 10 Nov 2026, then ' },
        { money: { minor: 37333, currency: 'USD' } },
        { text: ' a month for 12 months on ' },
        { account: 'travel-card' },
      ],
      name: 'Loan offer',
    })
    // A hand-made patch in another shape keeps its label, marked so the eye hides its digits.
    expect(words(abroadSnap, { label: 'Two at once', patch: { fx_shift_pct: -0.1, items: { mobile: { removed: true } } } })).toBeNull()
  })
})

describe('Compare picker', () => {
  it('offers the kinds the household can try', () => {
    expect(leverKinds(registry(build(abroad)))).toEqual(['amount', 'day', 'end', 'remove', 'upside', 'extra', 'offer', 'fx', 'gap', 'floor'])
    // One currency and no upside: no FX shift and nothing to count.
    expect(leverKinds(registry(build(usCardsCar)))).toEqual(['amount', 'day', 'end', 'remove', 'extra', 'offer', 'gap', 'floor'])
  })

  it('builds the same lever as core for every kind', () => {
    const snapshot = build(abroad)
    const reg = registry(snapshot)
    expect(lever(snapshot, 'day', (d) => ({ ...pickItem(snapshot, reg, d, 'salary', LOCALE), day: '20' }))).toEqual(dayLever(snapshot, 'salary', 20, '2026-11'))
    expect(lever(snapshot, 'end', (d) => ({ ...pickItem(snapshot, reg, d, 'rent', LOCALE), month: '2027-03' }))).toEqual(endLever(snapshot, 'rent', '2027-03-31'))
    // An installment's last billed month ends on its first day.
    expect(lever(snapshot, 'end', (d) => ({ ...pickItem(snapshot, reg, d, 'laptop', LOCALE), month: '2027-01' }))).toEqual(endLever(snapshot, 'laptop', '2027-01-01'))
    expect(lever(snapshot, 'remove', (d) => pickItem(snapshot, reg, d, 'mobile', LOCALE))).toEqual(removeLever(snapshot, 'mobile'))
    // The only upside is picked already.
    expect(lever(snapshot, 'upside')).toEqual(upsideLever(snapshot, 'camera-sale'))
    expect(newDraft(snapshot, reg, 'amount', LOCALE).item).toBeNull()
    expect(readLever(snapshot, reg, newDraft(snapshot, reg, 'remove', LOCALE), LOCALE)).toEqual({ ok: false, errors: { item: 'Pick an item.' } })
    expect(lever(snapshot, 'extra', (d) => ({ ...d, amount: '10000' }))).toEqual(extraPaymentLever(snapshot, { amount_minor: 1000000, every: 'month', starts_on: '2026-11-01', from_account_id: 'pesos' }))
    // A one-off this month lands today.
    expect(lever(snapshot, 'extra', (d) => ({ ...d, target: 'to:shopping-card', every: 'once', month: '2026-10', amount: '5000' }))).toEqual(
      extraPaymentLever(snapshot, { amount_minor: 500000, every: 'once', starts_on: AS_OF, to_debt_id: 'shopping-card' }),
    )
    expect(lever(snapshot, 'fx', (d) => ({ ...d, direction: 'stronger', percent: '5' }))).toEqual(fxShiftLever(snapshot, 0.05))
    expect(lever(snapshot, 'gap')).toEqual(incomeGapLever(snapshot, { from_month: '2026-11', months: 3 }))
    expect(lever(snapshot, 'gap', (d) => ({ ...d, income: 'salary', months: '6' }))).toEqual(incomeGapLever(snapshot, { from_month: '2026-11', months: 6, item_ids: ['salary'] }))
    expect(lever(snapshot, 'floor', (d) => ({ ...d, amount: '4000' }))).toEqual(
      floorWindowLever(snapshot, 'main', [
        { from_month: '2026-10', to_month: '2026-10', amount_minor: 600000 },
        { from_month: '2026-11', to_month: null, amount_minor: 400000 },
      ]),
    )
  })

  it('opens a change on the list as its own form again, which rebuilds the same lever', () => {
    const snapshot = build(abroad)
    const reg = registry(snapshot)
    const levers = [
      amountLever(snapshot, 'rent', 95000, '2026-12'),
      dayLever(snapshot, 'salary', 20, '2026-11'),
      endLever(snapshot, 'rent', '2027-03-31'),
      removeLever(snapshot, 'mobile'),
      upsideLever(snapshot, 'camera-sale'),
      extraPaymentLever(snapshot, { amount_minor: 1000000, every: 'month', starts_on: '2026-11-01', from_account_id: 'pesos' }),
      extraPaymentLever(snapshot, { amount_minor: 500000, every: 'once', starts_on: '2026-12-01', to_debt_id: 'shopping-card' }),
      fxShiftLever(snapshot, -0.125),
      incomeGapLever(snapshot, { from_month: '2027-01', months: 4, item_ids: ['salary'] }),
    ]
    for (const l of levers) {
      const draft = draftOf(snapshot, reg, l, LOCALE)
      expect(draft, l.label).not.toBeNull()
      const read = readLever(snapshot, reg, draft as LeverDraft, LOCALE)
      expect(read.ok && read.lever, l.label).toEqual(l)
    }
    // The Try extra payments lever opens on its amount, ready to change.
    expect(draftOf(snapshot, reg, levers[5] as Lever, LOCALE)).toMatchObject({ kind: 'extra', target: 'from:pesos', every: 'month', amount: '10000.00', month: '2026-11' })
    // A loan offer adds two rows, which the picker builds only from its own fields.
    const offer = loanOfferLever(snapshot, { amount_minor: 5000000, term_months: 12, monthly_rate: 0.01, draw_month: '2026-10', to_account_id: 'pesos', card_id: 'rewards-card' })
    expect(draftOf(snapshot, reg, offer, LOCALE)).toBeNull()
  })

  it('prefills a loan offer’s EMI by the add-on formula until the bank’s figure is typed, and says what it repays', () => {
    const snapshot = build(abroad)
    const reg = registry(snapshot)
    const draft = withEmi(snapshot, { ...newDraft(snapshot, reg, 'offer', LOCALE), amount: '50000', rate: '0.97', term: '36' }, LOCALE)
    expect([draft.card, draft.to, draft.month, draft.emi]).toEqual(['rewards-card', 'pesos', '2026-10', '1873.89'])
    expect(addOnInstallment(5000000, 0.0097, 36)).toBe(187389)
    expect(offerCost(snapshot, draft, LOCALE)).toEqual({ total_minor: 6746004, extra_minor: 1746004, currency: 'PHP' })
    const formula = readLever(snapshot, reg, draft, LOCALE)
    expect(formula.ok && formula.lever).toEqual(loanOfferLever(snapshot, { amount_minor: 5000000, term_months: 36, monthly_rate: 0.0097, draw_month: '2026-10', to_account_id: 'pesos', card_id: 'rewards-card' }))
    const typed = { ...draft, emi: '1900', emi_typed: true }
    expect(withEmi(snapshot, { ...typed, amount: '60000' }, LOCALE).emi).toBe('1900')
    const bank = readLever(snapshot, reg, typed, LOCALE)
    expect(bank.ok && bank.lever).toEqual(loanOfferLever(snapshot, { amount_minor: 5000000, term_months: 36, monthly_rate: 0.0097, draw_month: '2026-10', to_account_id: 'pesos', card_id: 'rewards-card', emi_minor: 190000 }))
    // The draw lands in the lending card's currency only.
    expect(pickCard(snapshot, reg, draft, 'shopping-card', LOCALE).to).toBe('pesos')
    expect([readRate('1'), readRate('0,97 %'), readRate('100'), readRate('abc')]).toEqual([0.01, 0.0097, null, null])
  })

  it('says what to fix, field by field', () => {
    const snapshot = build(abroad)
    const reg = registry(snapshot)
    const rent = pickItem(snapshot, reg, newDraft(snapshot, reg, 'amount', LOCALE), 'rent', LOCALE)
    expect(rent.amount).toBe('900.00')
    expect(readLever(snapshot, reg, rent, LOCALE)).toEqual({ ok: false, errors: { amount: 'That is the amount the plan already holds.' } })
    expect(readLever(snapshot, reg, { ...rent, amount: '0' }, LOCALE)).toEqual({ ok: false, errors: { amount: 'Type an amount other than 0. To stop the item, end or remove it instead.' } })
    expect(readLever(snapshot, reg, { ...rent, amount: 'lots' }, LOCALE)).toEqual({ ok: false, errors: { amount: 'Type an amount such as 1250.00.' } })
    expect(readLever(snapshot, reg, { ...rent, amount: '950', month: '2040-01' }, LOCALE)).toEqual({ ok: false, errors: { month: 'Pick a month inside the projection.' } })
    const offer = readLever(snapshot, reg, { ...newDraft(snapshot, reg, 'offer', LOCALE), term: '0', rate: 'x' }, LOCALE)
    expect(offer).toEqual({ ok: false, errors: { amount: 'Type an amount.', term: 'Type a number of months, such as 12.', rate: 'Type the rate a month, such as 1 for 1%.', emi: 'Type an amount.' } })
  })

  it('sets a floor for a span of months and keeps the windows around it', () => {
    const windows = [
      { from_month: '2026-10', to_month: null, amount_minor: 600000 },
      { from_month: '2026-11', to_month: '2028-11', amount_minor: 300000 },
    ]
    expect(floorWindowsFor(windows, { from: '2027-01', to: '2027-03', amount_minor: 100000 })).toEqual([
      { from_month: '2026-10', to_month: '2026-12', amount_minor: 600000 },
      { from_month: '2026-11', to_month: '2026-12', amount_minor: 300000 },
      { from_month: '2027-01', to_month: '2027-03', amount_minor: 100000 },
      { from_month: '2027-04', to_month: null, amount_minor: 600000 },
      { from_month: '2027-04', to_month: '2028-11', amount_minor: 300000 },
    ])
    // A zero floor leaves the span with none.
    expect(floorWindowsFor(windows, { from: '2026-10', to: null, amount_minor: 0 })).toEqual([])
  })
})

describe('Compare link', () => {
  it('keeps the levers after # and out of the query, with the sample when one is open', () => {
    const snapshot = build(abroad)
    const levers = [rentPlus50(snapshot), fxShiftLever(snapshot, -0.1)]
    const link = compareLink('https://waypoint.example/plan/compare', 'abroad', levers)
    const url = new URL(link)
    expect([url.pathname, url.search]).toEqual(['/plan/compare', '?sample=abroad'])
    expect(url.hash).toBe(`#${fragmentOf(levers)}`)
    const back = leversOf(new URLSearchParams(url.hash.slice(1)).get('l'))
    expect(back.ok && back.levers).toEqual(levers)
    // Nothing before the # holds an amount.
    expect(link.split('#')[0]).not.toMatch(/950|9500/)
    expect(compareLink('waypoint://plan/compare', null, [])).toBe('waypoint://plan/compare')
    expect(fragmentOf([])).toBeUndefined()
    expect(leversOf(null)).toEqual({ ok: true, levers: [] })
    expect(leversOf('not*base64')).toEqual({ ok: false, errors: decodeLevers('not*base64').ok ? [] : ['bad_link: the link is not base64url text'] })
    expect(columnsOf(snapshot).length).toBe(8)
  })
})

describe('a change’s verdict', () => {
  it('says Better or Worse by which way each figure should move, and nothing where it moved neither way', () => {
    const money = (minor: number) => ({ kind: 'money' as const, minor, currency: 'EUR' })
    expect([verdictOf('net_worth', money(100)), verdictOf('lowest', money(-100)), verdictOf('interest', money(-100)), verdictOf('interest', money(100))]).toEqual(['Better', 'Worse', 'Better', 'Worse'])
    expect([verdictOf('days_under_floor', { kind: 'days', n: -3 }), verdictOf('fx_margin', { kind: 'points', fraction: -0.02 }), verdictOf('debt_free_month', { kind: 'months', n: -2 }), verdictOf('debt_free_month', { kind: 'months', n: 0 })]).toEqual(['Better', 'Worse', 'Better', null])
    expect([verdictOf('debt_free_month', { kind: 'text', text: 'Debt-free now' }), verdictOf('debt_free_month', { kind: 'text', text: 'Now after the projection' }), verdictOf('debt_free_month', { kind: 'text', text: 'Changed' }), verdictOf('net_worth', null)]).toEqual(['Better', 'Worse', null, null])
  })
})
