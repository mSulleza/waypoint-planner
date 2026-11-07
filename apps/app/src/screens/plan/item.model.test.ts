import { buildSnapshot, planItemRow, type PlanItem, type Snapshot } from '@waypoint/core'
import { abroad, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { DataError } from '../../data/errors'
import {
  accountGroups,
  draftOf,
  endPlan,
  fromMonths,
  itemProblem,
  linksOf,
  moveFirstMonth,
  newDraft,
  openItem,
  paidFrom,
  pickAccount,
  pickCategory,
  readItem,
  routeErrors,
  savePlan,
  splitPlan,
  EVERY_WORDS,
  everyChoices,
  withKind,
  withRoute,
  type ItemDraft,
} from './item.model'

const AS_OF = '2026-10-07'
const LOCALE = 'en-PH'

function snapshotOf(build: (asOf: string) => Sample = abroad, edit?: (doc: SampleDoc) => void): Snapshot {
  const sample = build(AS_OF)
  edit?.(sample.doc)
  return buildSnapshot(sample.doc, AS_OF, sample.rates)
}

const item = (snapshot: Snapshot, id: string): PlanItem => {
  const found = snapshot.doc.plan_items.find((p) => p.id === id)
  if (!found) throw new Error(`no plan item ${id}`)
  return found
}

// The draft read and checked by the schema the database mirrors, as the editor's form does.
function rowOf(snapshot: Snapshot, draft: ItemDraft, id: string, loaded: PlanItem | null = null): PlanItem {
  const { input, errors } = readItem(snapshot, draft, { id, locale: LOCALE, loaded })
  expect(errors).toEqual({})
  const parsed = planItemRow.safeParse(input)
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
  return parsed.data
}

const ids = (snapshot: Snapshot, draft: ItemDraft, side: 'from' | 'to') => accountGroups(snapshot, draft, side).map((g) => [g.title, g.accounts.map((a) => a.id)])

describe('fields by kind', () => {
  const snapshot = snapshotOf()

  it('offers a budget only Monthly and Once, keeps a repeat it was saved with, and moves a weekly or quarterly draft to Monthly', () => {
    const all = ['once', 'week', '2weeks', 'month', 'quarter', 'year'] as const
    expect([everyChoices('allowance', all, 'month'), everyChoices('allowance', all, 'week'), everyChoices('bill', all, 'month')]).toEqual([['once', 'month'], ['once', 'week', 'month'], [...all]])
    expect(['income', 'bill', 'transfer'].map((k) => everyChoices(k as 'bill', all, 'month').map((e) => EVERY_WORDS[e]))).toEqual(
      Array(3).fill(['Once', 'Weekly', 'Every 2 weeks', 'Monthly', 'Every 3 months', 'Yearly']),
    )
    const weekly = { ...newDraft(snapshot, {}), every: 'week' as const }
    expect([withKind(snapshot, weekly, 'allowance').every, withKind(snapshot, weekly, 'bill').every, withKind(snapshot, { ...weekly, every: 'once' }, 'allowance').every]).toEqual(['month', 'week', 'once'])
    const quarterly = { ...newDraft(snapshot, {}), every: 'quarter' as const }
    expect([withKind(snapshot, quarterly, 'allowance').every, withKind(snapshot, quarterly, 'bill').every, withKind(snapshot, quarterly, 'transfer').every]).toEqual(['month', 'quarter', 'quarter'])
  })

  it('offers each kind only the accounts its route allows', () => {
    const draft = newDraft(snapshot, {})
    expect(draft.kind).toBe('income')
    // Income lands in cash or on a debt (a planned draw); it has no from field.
    expect(ids(snapshot, draft, 'to')).toEqual([
      ['Cash accounts', ['main', 'tax', 'pesos']],
      ['Cards', ['rewards-card', 'shopping-card']],
    ])
    expect(ids(snapshot, draft, 'from')).toEqual([])
    const bill = withKind(snapshot, draft, 'bill')
    expect(ids(snapshot, bill, 'from')).toEqual([
      ['Cash accounts', ['main', 'tax', 'pesos']],
      ['Cards', ['rewards-card', 'shopping-card']],
    ])
    expect(ids(snapshot, withKind(snapshot, draft, 'installment'), 'from')).toEqual([['Cards', ['rewards-card', 'shopping-card']]])
    const transfer = withKind(snapshot, draft, 'transfer')
    // Cash to cash never offers the account on the other side.
    expect([transfer.route, transfer.from, transfer.to]).toEqual(['between', 'main', 'tax'])
    expect(ids(snapshot, transfer, 'to')).toEqual([['Cash accounts', ['tax', 'pesos']]])
    const debt = withRoute(snapshot, transfer, 'debt')
    expect([debt.from, debt.to]).toEqual([null, 'rewards-card'])
    expect(ids(snapshot, debt, 'from')).toEqual([])
    const extra = withRoute(snapshot, transfer, 'extra')
    expect([extra.from, extra.to]).toEqual(['main', null])
  })

  it('reads a bill with no category and a budget with one, the amount parsed once in the paying account’s currency', () => {
    const bill = { ...withKind(snapshot, newDraft(snapshot, {}), 'bill'), name: 'Gym', amount: '1,234.50', from: 'pesos' }
    expect(rowOf(snapshot, bill, 'gym')).toMatchObject({ kind: 'bill', from_account_id: 'pesos', to_account_id: null, category_id: null, amount_minor: 123450, every: 'month', starts_on: AS_OF, ends_on: null })
    const budget = { ...withKind(snapshot, newDraft(snapshot, {}), 'allowance'), amount: '-50' }
    // The name follows the category until one is typed.
    expect([budget.category, budget.name]).toEqual(['cat-dining', 'Dining'])
    expect(pickCategory(snapshot, budget, 'cat-home').name).toBe('Home')
    expect(pickCategory(snapshot, { ...budget, name: 'Takeaway', named: true }, 'cat-home').name).toBe('Takeaway')
    expect(rowOf(snapshot, budget, 'dining')).toMatchObject({ kind: 'allowance', from_account_id: 'main', category_id: 'cat-dining', amount_minor: -5000 })
  })

  it('names the field a value cannot be read in, before the schema sees it', () => {
    const draft = { ...newDraft(snapshot, {}), name: 'Pay', amount: '12,34', starts_on: '2026-02-30', ends_on: 'soon' }
    expect(readItem(snapshot, draft, { id: 'x', locale: LOCALE, loaded: null }).errors).toEqual({
      amount_minor: 'Type an amount such as 12.50.',
      starts_on: 'Pick a date.',
      ends_on: 'Pick a date, or leave it empty for no end.',
    })
    const planEmpty = { ...withKind(snapshot, newDraft(snapshot, {}), 'transfer'), from: null, amount: '' }
    expect(readItem(snapshot, planEmpty, { id: 'x', locale: LOCALE, loaded: null }).errors).toEqual({ name: 'Type a name.', amount_minor: 'Type an amount.', from_account_id: 'Pick an account.' })
  })

  it('saves a 12-month installment as its first and last billed months, first-of-month dates', () => {
    const draft = { ...withKind(snapshot, newDraft(snapshot, {}), 'installment'), name: 'Phone', amount: '1500' }
    expect([draft.first_month, draft.last_month]).toEqual(['2026-11', '2027-10'])
    expect(rowOf(snapshot, draft, 'phone')).toMatchObject({ kind: 'installment', from_account_id: 'rewards-card', amount_minor: 150000, every: 'month', starts_on: '2026-11-01', ends_on: '2027-10-01' })
    // Moving the first month keeps the term.
    expect(moveFirstMonth(draft, '2027-01')).toMatchObject({ first_month: '2027-01', last_month: '2027-12' })
  })

  it('frees the other side of a cash-to-cash transfer when the same account is picked', () => {
    const transfer = withKind(snapshot, newDraft(snapshot, {}), 'transfer')
    expect(pickAccount(snapshot, transfer, 'from', 'tax')).toMatchObject({ from: 'tax', to: 'main' })
  })

  it('says which account pays a transfer into a debt, following the debt’s funded-from account', () => {
    const moved = snapshotOf(abroad, (doc) => {
      const card = doc.accounts.find((a) => a.id === 'shopping-card') as { funded_from_account_id: string }
      card.funded_from_account_id = 'main'
    })
    expect(paidFrom(snapshot, 'shopping-card')?.id).toBe('pesos')
    expect(paidFrom(moved, 'shopping-card')?.id).toBe('main')
    expect(paidFrom(snapshot, 'main')).toBeNull()
  })

  it('opens a saved item, a new one from its link, and nothing for an id the household lacks', () => {
    expect(openItem(snapshot, 'rent', 'new', {}, LOCALE)).toMatchObject({ kind: 'edit', draft: { kind: 'bill', from: 'main', amount: '900.00', starts_on: '2026-09-01', roll: 'following' } })
    expect(openItem(snapshot, 'new', 'new', { kind: 'allowance', category: 'cat-home' }, LOCALE)).toMatchObject({ kind: 'new', draft: { kind: 'allowance', category: 'cat-home', name: 'Home' } })
    expect(openItem(snapshot, 'gone', 'new', {}, LOCALE)).toEqual({ kind: 'missing' })
  })

  it('puts a routing problem beside the account field it is about', () => {
    const rent = item(snapshot, 'rent')
    expect(routeErrors(snapshot, rent)).toEqual({})
    expect(routeErrors(snapshot, { ...rent, kind: 'installment', from_account_id: 'main' })).toEqual({ from_account_id: 'An installment sits on a card, to no account.' })
  })
})

describe('Save, Change from, End and Delete', () => {
  const snapshot = snapshotOf()
  const rent = item(snapshot, 'rent')
  const groceries = item(snapshot, 'groceries')
  const rentLinks = linksOf(snapshot, 'rent')
  const edited = (loaded: PlanItem, change: (d: ItemDraft) => ItemDraft) => rowOf(snapshot, change(draftOf(snapshot, loaded, LOCALE)), loaded.id, loaded)

  it('saves only the changed columns, guarded on the row as loaded, and nothing when nothing changed', () => {
    expect(rentLinks.map((t) => t.period)).toEqual(['2026-09-01', '2026-10-01'])
    expect(savePlan(snapshot, rent, edited(rent, (d) => d), rentLinks, LOCALE)).toEqual({ ok: true, value: null })
    const save = savePlan(snapshot, rent, edited(rent, (d) => ({ ...d, amount: '950' })), rentLinks, LOCALE)
    expect(save).toEqual({ ok: true, value: { kind: 'edit_item', id: 'rent', before: expect.objectContaining({ amount_minor: 90000, from_account_id: 'main', ends_on: null }), after: { amount_minor: 95000 } } })
  })

  it('keeps a linked bill’s account on Save, and moves it only through Change from', () => {
    const moved = edited(rent, (d) => ({ ...d, from: 'tax' }))
    expect(savePlan(snapshot, rent, moved, rentLinks, LOCALE)).toEqual({ ok: false, reason: 'Payments are linked to it, so Save keeps Main. Change from a month below to use the new account from then on.' })
    expect(splitPlan(snapshot, rent, moved, rentLinks, '2026-11', LOCALE)).toEqual({ ok: true, value: { from: '2026-11-01', patch: { from_account_id: 'tax' } } })
    // October's payment is linked on Main, so the new account cannot start in October.
    expect(splitPlan(snapshot, rent, moved, rentLinks, '2026-10', LOCALE)).toEqual({ ok: false, reason: 'October 2026 has a payment linked on Main. Change from a later month, or unlink it first.' })
    // Unlinked, the same item saves the account in place.
    const insurance = item(snapshot, 'insurance')
    expect(savePlan(snapshot, insurance, edited(insurance, (d) => ({ ...d, from: 'main' })), [], LOCALE)).toMatchObject({ ok: true, value: { after: { from_account_id: 'main' } } })
  })

  it('refuses a Save that would leave a linked month with no date', () => {
    const later = edited(rent, (d) => ({ ...d, starts_on: '2026-10-05' }))
    expect(savePlan(snapshot, rent, later, rentLinks, LOCALE)).toEqual({ ok: false, reason: 'September 2026 is linked or skipped, and this change leaves it no date. Change from a month below instead, or unlink it first.' })
    const weekly = edited(rent, (d) => ({ ...d, every: 'week' }))
    expect(savePlan(snapshot, rent, weekly, rentLinks, LOCALE)).toMatchObject({ ok: false })
  })

  it('changes a budget from next month with only what changed, and a monthly day as day', () => {
    expect(fromMonths(groceries, AS_OF)).toEqual({ min: '2026-10', max: '2031-10' })
    const more = edited(groceries, (d) => ({ ...d, amount: '450' }))
    expect(splitPlan(snapshot, groceries, more, [], '2026-11', LOCALE)).toEqual({ ok: true, value: { from: '2026-11-01', patch: { amount_minor: 45000 } } })
    expect(splitPlan(snapshot, rent, edited(rent, (d) => ({ ...d, starts_on: '2026-09-03' })), rentLinks, '2026-11', LOCALE)).toEqual({ ok: true, value: { from: '2026-11-01', patch: { day: 3 } } })
    expect(splitPlan(snapshot, rent, edited(rent, (d) => ({ ...d, starts_on: '2026-08-01' })), rentLinks, '2026-11', LOCALE)).toEqual({ ok: false, reason: 'Change from keeps the first date; Save changes it.' })
    expect(splitPlan(snapshot, groceries, edited(groceries, (d) => d), [], '2026-11', LOCALE)).toEqual({ ok: false, reason: 'Change a field above first; the change starts in November 2026.' })
    expect(splitPlan(snapshot, groceries, edited(groceries, (d) => ({ ...d, amount: '450', ends_on: '2026-10-20' })), [], '2026-11', LOCALE)).toEqual({ ok: false, reason: 'The last date is before Nov 1, 2026, when the change would start.' })
  })

  it('changes a quarterly bill from a month inside its quarter, and keeps a linked quarter its date on Save', () => {
    const quarterly = snapshotOf(abroad, (doc) => {
      doc.plan_items.push({ id: 'fee', kind: 'bill', name: 'Accountant', from_account_id: 'pesos', amount_minor: 450000, every: 'quarter', starts_on: '2026-07-15' })
      doc.transactions.push({ id: 'fee-oct', account_id: 'pesos', posted_on: '2026-10-05', amount_minor: -450000, kind: 'expense', plan_item_id: 'fee', period: '2026-10-01' })
    })
    const fee = item(quarterly, 'fee')
    const links = linksOf(quarterly, 'fee')
    const feeEdited = (change: (d: ItemDraft) => ItemDraft) => rowOf(quarterly, change(draftOf(quarterly, fee, LOCALE)), fee.id, fee)
    expect(draftOf(quarterly, fee, LOCALE)).toMatchObject({ every: 'quarter', starts_on: '2026-07-15', amount: '4500.00' })
    expect(fromMonths(fee, AS_OF)).toEqual({ min: '2026-10', max: '2031-10' })
    expect(splitPlan(quarterly, fee, feeEdited((d) => ({ ...d, starts_on: '2026-07-20', amount: '5000' })), links, '2026-11', LOCALE)).toEqual({ ok: true, value: { from: '2026-11-01', patch: { amount_minor: 500000, day: 20 } } })
    // Moving the first date to August moves every quarter off October, where a payment is linked.
    expect(savePlan(quarterly, fee, feeEdited((d) => ({ ...d, starts_on: '2026-08-15' })), links, LOCALE)).toEqual({ ok: false, reason: 'October 2026 is linked or skipped, and this change leaves it no date. Change from a month below instead, or unlink it first.' })
    expect(savePlan(quarterly, fee, feeEdited((d) => ({ ...d, every: 'month' })), links, LOCALE)).toMatchObject({ ok: true, value: { after: { every: 'month' } } })
  })

  it('offers months from this month on, after the first, through the last occurrence', () => {
    // Rent started in September, so October is the first month a change can start.
    expect(fromMonths(rent, AS_OF)).toEqual({ min: '2026-10', max: '2031-10' })
    expect(fromMonths(item(snapshot, 'laptop'), AS_OF)).toEqual({ min: '2026-10', max: '2027-05' })
    expect(fromMonths(item(snapshot, 'cash-loan'), AS_OF)).toEqual({ min: '2026-12', max: '2027-10' })
    expect(fromMonths(item(snapshot, 'receivable'), AS_OF)).toBeNull()
    const card = item(snapshotOf(usCardsCar), 'paycheck')
    expect(fromMonths(card, AS_OF)?.min).toBe('2026-10')
  })

  it('ends an item before a month, never before a linked one', () => {
    expect(endPlan(rent, rentLinks, '2026-11', '2031-10', LOCALE)).toEqual({ ok: true, value: { kind: 'edit_item', id: 'rent', before: expect.objectContaining({ ends_on: null }), after: { ends_on: '2026-10-31' } } })
    expect(endPlan(rent, rentLinks, '2026-10', '2031-10', LOCALE)).toEqual({ ok: false, reason: 'October 2026 has a linked payment. Pick a later month, or unlink it first.' })
    // With no later month to pick, the linked month is simply the item's last.
    expect(endPlan({ ...rent, ends_on: '2026-10-31' }, rentLinks, '2026-10', '2026-10', LOCALE)).toEqual({ ok: false, reason: 'October 2026 has a linked payment, so it stays in the plan.' })
    // An installment's end is its last billed month.
    expect(endPlan(item(snapshot, 'laptop'), [], '2026-12', '2027-05', LOCALE)).toMatchObject({ ok: true, value: { after: { ends_on: '2026-11-01' } } })
    expect(endPlan({ ...groceries, ends_on: '2026-10-31' }, [], '2026-12', '2026-10', LOCALE)).toEqual({ ok: false, reason: 'It already ends on Oct 31, 2026.' })
  })

  it('words the server’s refusals for the field or button they are about', () => {
    const refused = (code: string, detail: string) => new DataError('rejected', 'The server did not accept this change.', { code, detail })
    expect(itemProblem(refused('check_plan_item', 'its linked transactions fix its kind and accounts; split_plan_item changes the accounts from a later period'), rent, LOCALE)).toEqual({
      field: 'from_account_id',
      text: 'Payments are linked to it, so its accounts stay. Change from a month below to use another account from then on.',
    })
    expect(itemProblem(refused('check_plan_item', 'a transfer with no from account goes into a debt'), { kind: 'transfer', every: 'month', from_account_id: null }, LOCALE)).toEqual({ field: 'to_account_id', text: 'A transfer with no from account goes into a debt.' })
    expect(itemProblem(refused('bad_split', 'the occurrence 2026-12-01 is linked or skipped, and the new row has no occurrence to take it; unlink or unskip it first'), rent, LOCALE)).toEqual({
      field: null,
      text: 'December 2026 is linked or skipped, and the changed item has no date there. Unlink or unskip it first.',
    })
    const linked = new DataError('rejected', 'Payments are linked to this item, so it cannot be deleted. End it instead.', { code: 'linked' })
    expect(itemProblem(linked, rent, LOCALE)).toEqual({ field: null, text: 'Payments are linked to this item, so it cannot be deleted. End it instead.' })
  })
})
