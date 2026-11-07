import { budgetRows, buildSnapshot, expandPlan, importDoc, monthWord, parseRates, plainNames, renderCopy, runEngine, type ImportDocInput, type Walk } from '@waypoint/core'
import { decodeLevers } from '@waypoint/core/compare'
import { debtsModel } from '../debts/debts.model'
import { planHeadline } from '../plan/plan.model'
import { describe, expect, it } from 'vitest'
import ecb from '../../../../../packages/core/test/fixtures/frankfurter-2026-10-07.json'
import { currencyOfRegion, initialDraft, monthlyPayday, paydayChoices, presetGroups, readCurrency, readDraft, readPercent, regionOf, stepErrors, firstStepWithError, type Draft } from './onboarding.model'

const RATES = parseRates(ecb)
// 8 Oct 2026, noon in Madrid: day 8 of a 31-day month.
const NOW = new Date('2026-10-08T10:00:00Z')
const TODAY = '2026-10-08'

const answers = (edit: Partial<Draft> = {}): Draft => ({
  ...initialDraft('en-IE', 'Europe/Madrid'),
  balance: '1800',
  income: '3000',
  payday_day: '28',
  living: '1800',
  ...edit,
})

function docOf(draft: Draft, locale = 'en-IE'): ImportDocInput {
  const reading = readDraft(draft, locale, NOW)
  expect(reading.errors).toEqual({})
  if (!reading.doc) throw new Error('no document')
  return reading.doc
}

function walked(doc: ImportDocInput): Walk {
  const run = runEngine(buildSnapshot(doc, TODAY, RATES))
  if (!run.ok) throw new Error(`walk failed: ${JSON.stringify(run.errors)}`)
  return run.walk
}

describe('the household onboarding writes', () => {
  it('is one import document core accepts: the main account with its floor from this month, pay, and only the Living category with its allowance, tracked from today', () => {
    const doc = docOf(answers({ floor: '500' }))
    const parsed = importDoc.parse(doc)
    expect(parsed.household).toEqual({ base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-IE', payoff_order: 'avalanche', track_from: TODAY })
    expect(parsed.accounts.map((a) => [a.id, a.kind, a.currency, a.opening_balance_minor, a.opening_date, a.floor_windows])).toEqual([
      ['main', 'cash', 'EUR', 180000, TODAY, [{ from_month: '2026-10', to_month: null, amount_minor: 50000 }]],
    ])
    expect(parsed.categories.map((c) => c.name)).toEqual(['Living'])
    expect(parsed.plan_items.map((p) => [p.id, p.kind, p.amount_minor, p.every, p.starts_on, p.category_id])).toEqual([
      ['pay', 'income', 300000, 'month', '2026-10-28', null],
      ['living-costs', 'allowance', 180000, 'month', '2026-10-01', 'living'],
    ])
    expect([parsed.statements, parsed.transactions]).toEqual([[], []])
  })

  it('counts one Living expense as the budget spent', () => {
    const doc = docOf(answers())
    const lunch = { id: 'lunch', account_id: 'main', posted_on: TODAY, amount_minor: -1250, kind: 'expense' as const, category_id: 'living' }
    const rows = budgetRows(buildSnapshot({ ...doc, transactions: [lunch] }, TODAY, RATES))
    expect(rows.map((r) => [r.category_id, r.month, r.budget_minor, r.spent_minor, r.left_minor])).toEqual([['living', '2026-10', 180000, 1250, 178750]])
  })

  it('makes a month that dips below a lowest balance to keep of 500 Short, and the same month OK with none', () => {
    // 1,800 spread over the 24 days left leaves 300 on the 27th, the day before payday.
    const kept = walked(docOf(answers({ floor: '500' })))
    expect([monthWord(kept, 'main', '2026-10'), monthWord(kept, 'main', '2026-11')]).toEqual(['Short', 'OK'])
    const figures = kept.figures.get('main')?.[0]
    expect([figures?.lowest_minor, figures?.lowest_on, figures?.days_under_floor]).toEqual([30000, '2026-10-27', 3])
    const none = walked(docOf(answers({ floor: '' })))
    expect(monthWord(none, 'main', '2026-10')).toBe('OK')
  })

  it('pays a card added on day 8 with due day 25 from the main account on the 25th of this month, as its opening balance is a statement', () => {
    const doc = docOf(answers({ debt: 'card', owed: '400', cut_day: '3', due_day: '25', pays: 'full' }))
    expect(doc.accounts?.[1]).toMatchObject({ id: 'card', kind: 'credit_card', currency: 'EUR', opening_balance_minor: -40000, opening_date: TODAY, funded_from_account_id: 'main' })
    const payments = walked(doc).lines.filter((l) => l.source === 'card' && l.kind === 'payment' && l.account_id === 'main')
    expect(payments[0]).toMatchObject({ id: `payment:card:${TODAY}#out`, date: '2026-10-25', amount_minor: -40000 })
  })

  it('takes a bank variant’s currency for the card and pays it across currencies from the main account', () => {
    const doc = docOf(answers({ debt: 'card', preset: 'PH-daily-unpaid', owed: '30000', cut_day: '3', due_day: '25', pays: 'minimum' }))
    expect(doc.accounts?.[1]).toMatchObject({ currency: 'PHP', opening_balance_minor: -3000000, terms: { preset: 'PH-daily-unpaid', cut_day: 3, due: { day_of_month: 25 }, due_roll: 'none' } })
    const payment = walked(doc).lines.find((l) => l.id === `payment:card:${TODAY}#out`)
    // installments_plus pays the 3% minimum, 900 PHP, sent from EUR at the ECB rate.
    expect([payment?.account_id, payment?.date]).toEqual(['main', '2026-10-25'])
    expect(payment?.amount_minor).toBe(-Math.ceil(90000 / 70.203))
  })

  it('lands every-2-weeks pay two or three times in each month after the first payday', () => {
    const doc = docOf(answers({ every: '2weeks', payday_day: '', payday_date: '2026-10-16' }))
    const perMonth = new Map<string, number>()
    for (const o of expandPlan(buildSnapshot(doc, TODAY, RATES)).occurrences) if (o.plan_item_id === 'pay') perMonth.set(o.period.slice(0, 7), (perMonth.get(o.period.slice(0, 7)) ?? 0) + 1)
    const counts = [...perMonth.values()]
    expect(perMonth.size).toBe(61)
    expect(counts.every((n) => n === 2 || n === 3)).toBe(true)
    expect(counts.filter((n) => n === 3).length).toBeGreaterThan(0)
    expect(perMonth.get('2026-10')).toBe(2)
  })

  it('makes a loan with an annuity payment and the yearly rate as a fraction', () => {
    const doc = docOf(answers({ debt: 'loan', loan_balance: '12,000', payment: '355.58', rate: '6.9', payment_day: '20' }))
    expect(doc.accounts?.[1]).toMatchObject({ id: 'loan', kind: 'loan', currency: 'EUR', opening_balance_minor: -1200000, terms: { annual_rate: 0.069, payment_minor: 35558, payment_day: 20 }, funded_from_account_id: 'main' })
    expect(walked(doc).lines.find((l) => l.source === 'loan' && l.kind === 'payment' && l.account_id === 'main')).toMatchObject({ date: '2026-10-20', amount_minor: -35558 })
  })
})

describe('reading the answers', () => {
  it('reads amounts once with core parseAmount, in the household locale and the account currency', () => {
    const doc = docOf(answers({ balance: '1.250,50', floor: '0', income: '2.000', living: '900,5' }), 'es-ES')
    expect(doc.accounts?.[0]?.opening_balance_minor).toBe(125050)
    expect(doc.plan_items?.map((p) => p.amount_minor)).toEqual([200000, 90050])
    const yen = docOf(answers({ currency: 'JPY', account_currency: 'JPY', balance: '250000', income: '300000', living: '180000' }))
    expect(yen.accounts?.[0]?.opening_balance_minor).toBe(250000)
  })

  it('names what is wrong with each answer, on the step that asked it, and writes nothing while any is wrong', () => {
    const reading = readDraft(answers({ currency: 'EURO', timezone: 'Mars/Base', balance: '', floor: '-5', income: '0', payday_day: '32', living: 'lots' }), 'en-IE', NOW)
    expect(reading.doc).toBeNull()
    expect(stepErrors(reading.errors, 0)).toEqual({ currency: 'Enter a three-letter currency code, such as EUR or USD.', timezone: 'Enter a time zone such as Europe/Madrid.' })
    expect(stepErrors(reading.errors, 1)).toEqual({ balance: 'Enter an amount.', floor: 'Enter 0 or more.' })
    expect(firstStepWithError(reading.errors)).toBe(0)

    const later = readDraft(answers({ balance: '12.345', income: '0', payday_day: '32', living: 'lots', debt: 'loan', rate: '120', payment_day: '0' }), 'en-IE', NOW)
    expect(later.errors).toEqual({
      balance: 'Enter an amount in figures, such as 1250.50.',
      income: 'Enter more than 0.',
      payday: 'Enter the day of the month you are paid, 1 to 31.',
      living: 'Enter an amount in figures, such as 1250.50.',
      loan_balance: 'Enter an amount.',
      payment: 'Enter an amount.',
      rate: 'Enter the yearly rate in percent, such as 6.9.',
      payment_day: 'Enter a day, 1 to 31.',
    })
    expect(firstStepWithError(later.errors)).toBe(1)
    expect(readDraft(answers({ currency: 'XQZ' }), 'en-IE', NOW).errors.currency).toBe('Waypoint does not know the currency XQZ. Check the code.')
  })

  it('saves the time zone under its IANA name and dates today in it', () => {
    const reading = readDraft(answers({ timezone: 'asia/manila' }), 'en-PH', new Date('2026-10-08T17:00:00Z'))
    expect([reading.doc?.household.timezone, reading.today]).toEqual(['Asia/Manila', '2026-10-09'])
  })

  it('takes a weekly or fortnightly payday only from the days after today up to one period ahead', () => {
    expect(paydayChoices(TODAY, 'week')).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'])
    expect(paydayChoices(TODAY, '2weeks')).toHaveLength(14)
    expect(readDraft(answers({ every: 'week', payday_date: TODAY }), 'en-IE', NOW).errors.payday).toBe('Pick the day of your next payday.')
    expect(readDraft(answers({ every: 'week', payday_date: '2026-10-15' }), 'en-IE', NOW).doc?.plan_items?.[0]).toMatchObject({ every: 'week', starts_on: '2026-10-15' })
  })

  it('puts a monthly payday after today and keeps a 31st on each month’s last day', () => {
    expect(monthlyPayday(TODAY, 8)).toEqual({ next: '2026-11-08', starts_on: '2026-11-08' })
    expect(monthlyPayday(TODAY, 9)).toEqual({ next: '2026-10-09', starts_on: '2026-10-09' })
    expect(monthlyPayday('2026-11-08', 31)).toEqual({ next: '2026-11-30', starts_on: '2026-10-31' })
    expect(monthlyPayday('2027-02-10', 30)).toEqual({ next: '2027-02-28', starts_on: '2027-01-30' })
    const doc = docOf(answers({ payday_day: '31' }))
    const dates = expandPlan(buildSnapshot(doc, TODAY, RATES)).occurrences.filter((o) => o.plan_item_id === 'pay').map((o) => o.date)
    expect(dates.slice(0, 4)).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31'])
  })

  it('reads a yearly rate in percent as the exact decimal fraction', () => {
    expect(['6.9', '6,9', '24.99', '0', '4.25 %', '99.9999'].map(readPercent)).toEqual([0.069, 0.069, 0.2499, 0, 0.0425, 0.999999])
    expect(['', '100', '6.12345', 'six', '-3'].map(readPercent)).toEqual([null, null, null, null, null])
  })
})

describe('first answers from the device', () => {
  it('prefills the currency from the locale’s region and the time zone from Intl', () => {
    expect(['en-US', 'es-ES', 'fil-PH', 'de-CH', 'en-GB', 'fr-SN', 'es-SV', 'hr-HR', 'bg-BG', 'en-AU'].map((l) => currencyOfRegion(regionOf(l)))).toEqual(['USD', 'EUR', 'PHP', 'CHF', 'GBP', 'XOF', 'USD', 'EUR', 'EUR', 'AUD'])
    expect(currencyOfRegion('')).toBe('')
    expect(initialDraft('en-PH', 'Asia/Manila')).toMatchObject({ currency: 'PHP', account_currency: 'PHP', timezone: 'Asia/Manila', floor: '', every: 'month', debt: 'none', preset: 'generic-in-full', pays: '' })
  })

  it('lists card presets by what their interest does, each bank variant by a plain title under it and the generic ones first, never by id', () => {
    expect(presetGroups('en-IE').map((g) => [g.heading, g.options.map((o) => `${o.title}: ${o.detail}`)])).toEqual([
      ['Interest only if you do not pay in full', ['Any bank: Any currency · 24% a year', 'Philippine card, minimum with a floor: PHP · 3% a month']],
      ['Interest on the average balance you carry', ['Any US bank: USD · 24% a year', 'Philippine card, minimum rounded up: PHP · 3% a month', 'Philippine card, minimum rounded off: PHP · 3% a month']],
      ['Interest every day on what you leave unpaid', ['Philippine card, interest on what is unpaid: PHP · 3% a month']],
    ])
    expect(presetGroups('en-IE').flatMap((g) => g.options.map((o) => o.title)).some((t) => /^(PH|US)-|generic/.test(t))).toBe(false)
  })

  it('asks what the person pays on the card each month and writes it into the plan', () => {
    const card = { debt: 'card' as const, preset: 'PH-round-up', owed: '85000', cut_day: '25', due_day: '15' }
    expect(readDraft(answers(card), 'en-IE', NOW).errors).toEqual({ pays: 'Pick what you pay each month.' })
    // The minimum keeps the preset's own pay mode; nothing more is planned into the card.
    const minimum = docOf(answers({ ...card, pays: 'minimum' }))
    expect(minimum.accounts?.[1]?.terms).toMatchObject({ pay: { mode: 'installments_plus' } })
    expect(minimum.plan_items?.map((p) => p.id)).toEqual(['pay', 'living-costs'])
    // A generic in-full card paid at its minimum pays the minimum.
    expect(docOf(answers({ ...card, preset: 'generic-in-full', pays: 'minimum' })).accounts?.[1]?.terms).toMatchObject({ pay: { mode: 'minimum' } })
    expect(docOf(answers({ ...card, pays: 'full' })).accounts?.[1]?.terms).toMatchObject({ pay: { mode: 'in_full' } })
    // A set extra is a monthly transfer item into the card, in the card's currency, from today.
    expect(readDraft(answers({ ...card, pays: 'extra', extra: '' }), 'en-IE', NOW).errors).toEqual({ extra: 'Enter an amount.' })
    const extra = docOf(answers({ ...card, pays: 'extra', extra: '5000' }))
    expect(extra.plan_items?.find((p) => p.id === 'card-extra')).toEqual({ id: 'card-extra', kind: 'transfer', name: 'Extra card payment', to_account_id: 'card', amount_minor: 500000, every: 'month', starts_on: TODAY })
    // The October statement's payment is the minimum plus the extra.
    const payment = walked(extra).lines.find((l) => l.id === 'payment:card:2026-10-25#in')
    expect(payment?.amount_minor).toBeGreaterThan(500000)
  })
})

describe('what the plan says about a card set up to pay only its minimum', () => {
  // The design review's household: €3,200 today, €4,100 a month in, €2,300 living, a Philippine card with its minimum rounded up, owing ₱85,000.
  const reviewer = (pays: Draft['pays'], extra = '') => answers({ balance: '3200', income: '4100', living: '2300', debt: 'card', preset: 'PH-round-up', owed: '85000', cut_day: '25', due_day: '15', pays, extra })

  function told(pays: Draft['pays'], extra = '') {
    const doc = docOf(reviewer(pays, extra))
    const snapshot = buildSnapshot(doc, TODAY, RATES)
    const run = runEngine(snapshot)
    if (!run.ok) throw new Error(`walk failed: ${JSON.stringify(run.errors)}`)
    const debts = debtsModel(snapshot, run.walk)
    const plan = planHeadline(snapshot, run.walk)
    const names = plainNames(snapshot)
    const note = (copy: Parameters<typeof renderCopy>[0] | null | undefined) => (copy ? renderCopy(copy, names) : null)
    const link = typeof debts?.try_extra === 'string' ? debts.try_extra : ''
    const lever = link.includes('#l=') ? decodeLevers(link.slice(link.indexOf('#l=') + 3)) : null
    return { debts: note(debts?.headline.note), plan: note(plan.debt_free?.note), plan_extra: plan.try_extra !== null, lever: lever?.ok ? lever.value : null }
  }

  it('says so on Debts and Plan and offers extra payments from the spare month, rounded', () => {
    const minimum = told('minimum')
    expect([minimum.debts, minimum.plan, minimum.plan_extra]).toEqual(['Your plan pays only the minimum on Credit card.', 'Your plan pays only the minimum on Credit card.', true])
    expect(minimum.lever?.map((l) => l.patch.add?.map((p) => [p.kind, p.from_account_id, p.amount_minor, p.every]))).toEqual([[['transfer', 'main', 170000, 'month']]])
  })

  it('says nothing of the kind when the card is paid in full or with a set extra', () => {
    for (const [pays, extra] of [['full', ''], ['extra', '500']] as const) {
      const said = told(pays, extra)
      const minimumSaid = (note: string | null) => note?.includes('only the minimum') ?? false
      expect([pays, minimumSaid(said.debts), minimumSaid(said.plan), said.plan_extra]).toEqual([pays, false, false, false])
    }
  })
})

describe('currency codes as a phone keyboard types them', () => {
  // The field keeps what is typed (no rewrite per keystroke), so the reader does the upper-casing.
  it('reads lower and mixed case and spaces as the code', () => {
    expect(readCurrency('eur')).toEqual({ code: 'EUR' })
    expect(readCurrency(' Php ')).toEqual({ code: 'PHP' })
  })
  it('still refuses a wrong length now that the field has no typing cap', () => {
    expect(readCurrency('euro')).toEqual({ error: 'Enter a three-letter currency code, such as EUR or USD.' })
    expect(readCurrency('eu')).toEqual({ error: 'Enter a three-letter currency code, such as EUR or USD.' })
  })
})
