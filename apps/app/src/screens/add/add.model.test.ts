import { buildSnapshot, checkInput, postBatchInput, runEngine, type Snapshot, type Walk } from '@waypoint/core'
import { abroad, missedCut, mortgage, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import type { ReceiptRead } from '../../ai/pdf-read'
import {
  accountChoices,
  amountText,
  arrivalDays,
  cardPay,
  categoryNote,
  categoryOffer,
  dayChoices,
  linkFits,
  loanPay,
  defaultCategory,
  newCategory,
  openDraft,
  overState,
  problemOf,
  readDraft,
  realRate,
  receiptDraft,
  receiptFilledNote,
  settles,
  switchMode,
  type BatchIds,
  type CardPay,
  type Draft,
} from './add.model'

const IDS: BatchIds = {
  batch_id: '00000000-0000-4000-8000-000000000001',
  rows: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'],
  transfer_id: '00000000-0000-4000-8000-000000000005',
}

function world(build: (asOf: string) => Sample, asOf: string, edit?: (doc: SampleDoc) => void): { snapshot: Snapshot; walk: Walk } {
  const sample = build(asOf)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, asOf, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return { snapshot, walk: run.walk }
}

// A transfer item into the rewards card in its cycle's month, so left to pay covers the 2,000.00 charged since the September cut.
const rewardsItem = (doc: SampleDoc) => {
  doc.plan_items.push({ id: 'rewards-extra', kind: 'transfer', name: 'Rewards card extra', to_account_id: 'rewards-card', amount_minor: 200000, every: 'once', starts_on: '2026-09-25' })
}

// Database ids are uuids; the fixtures' readable ids map to fixed ones so a batch passes post_batch's schema.
const UUIDS = new Map<string, string>()
const uuidOf = (id: string) => {
  let found = UUIDS.get(id)
  if (!found) UUIDS.set(id, (found = `00000000-0000-4000-9000-${String(UUIDS.size + 1).padStart(12, '0')}`))
  return found
}
const ID_FIELDS = ['id', 'account_id', 'funded_from_account_id', 'from_account_id', 'to_account_id', 'category_id', 'plan_item_id', 'transfer_id'] as const

function withUuids(doc: SampleDoc): void {
  for (const table of [doc.accounts, doc.categories, doc.plan_items, doc.statements, doc.transactions] as Record<string, unknown>[][]) {
    for (const row of table) for (const field of ID_FIELDS) if (typeof row[field] === 'string') row[field] = uuidOf(row[field])
  }
}

const read = (snapshot: Snapshot, draft: Draft, allow_over = false) => readDraft(snapshot, draft, { locale: snapshot.doc.household.locale, ids: IDS, allow_over, escrow: null })

describe('opening the Add sheet', () => {
  it('opens quick add on Out, today, the remembered account and an empty amount', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const opened = openDraft(snapshot, walk, { mode: 'out' }, 'pesos', 'en-PH')
    expect(opened).toMatchObject({ prefilled: false, statement_first: null })
    // Groceries is the one budget this month, so an expense starts tagged with it rather than counting on top of every budget.
    expect(opened.draft).toMatchObject({ mode: 'out', account: 'pesos', amount: '', date: '2026-10-07', link: null, category: 'cat-groceries' })
    // An account the household no longer has falls back to the first cash account.
    expect(openDraft(snapshot, walk, {}, 'gone', 'en-PH').draft.account).toBe('main')
  })

  it('preselects the only budget, else the category tagged last, and none when settling a bill or with no budget', () => {
    const { snapshot } = world(abroad, '2026-10-07')
    expect(defaultCategory(snapshot, '2026-10-07')).toBe('cat-groceries')
    const two = world(abroad, '2026-10-07', (doc) => {
      doc.categories.push({ id: 'fun', name: 'Fun' })
      doc.plan_items.push({ id: 'fun-budget', kind: 'allowance', name: 'Fun', from_account_id: 'main', to_account_id: null, category_id: 'fun', amount_minor: 10000, every: 'month', starts_on: '2026-10-01', ends_on: null, roll: 'none', confidence: 'committed', skip_periods: [] })
    })
    // Groceries was tagged last; Fun never was.
    expect(defaultCategory(two.snapshot, '2026-10-07')).toBe('cat-groceries')
    const untagged = world(abroad, '2026-10-07', (doc) => {
      doc.transactions = doc.transactions.map((t) => ({ ...t, category_id: null }))
      doc.categories.push({ id: 'fun', name: 'Fun' })
      doc.plan_items.push({ id: 'fun-budget', kind: 'allowance', name: 'Fun', from_account_id: 'main', to_account_id: null, category_id: 'fun', amount_minor: 10000, every: 'month', starts_on: '2026-10-01', ends_on: null, roll: 'none', confidence: 'committed', skip_periods: [] })
    })
    expect(defaultCategory(untagged.snapshot, '2026-10-07')).toBeNull()
    const bill = openDraft(snapshot, null, { plan_item_id: 'mobile', period: '2026-10-01' }, null, 'en-PH')
    expect(bill.draft).toMatchObject({ mode: 'out', category: null })
  })

  it('prefills a card payment with left to pay and keeps the received field for another currency', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const same = openDraft(snapshot, walk, { mode: 'move', to: 'rewards-card' }, null, 'en-PH')
    expect(same.draft).toMatchObject({ account: 'pesos', to: 'rewards-card', amount: '45000.00', received: '' })
    expect(same.prefilled).toBe(true)
    const euro = world(abroad, '2026-10-07', (doc) => {
      const card = doc.accounts.find((a) => a.id === 'rewards-card')
      if (card && card.kind === 'credit_card') card.funded_from_account_id = 'main'
    })
    const across = openDraft(euro.snapshot, euro.walk, { mode: 'move', to: 'rewards-card' }, null, 'en-PH')
    expect(across.draft).toMatchObject({ account: 'main', to: 'rewards-card', amount: '', received: '45000.00' })
  })

  it('sends Pay on a card whose cut passed with no statement to the Statement sheet first', () => {
    const { snapshot, walk } = world(missedCut, '2026-10-07')
    expect(cardPay(snapshot, walk, 'card')).toMatchObject({ provisional: true, cut_date: '2026-10-05' })
    const opened = openDraft(snapshot, walk, { mode: 'move', to: 'card' }, null, 'en-PH')
    expect(opened).toMatchObject({ statement_first: 'card', prefilled: false })
    expect(opened.draft.amount).toBe('')
  })

  it('opens Record on the occurrence: its mode, account, open amount and link', () => {
    const { snapshot, walk } = world(mortgage, '2026-10-16')
    const opened = openDraft(snapshot, walk, { plan_item_id: 'energy', period: '2026-10-01' }, null, 'en-GB')
    expect(opened.draft).toMatchObject({ mode: 'out', account: 'current', amount: '110.00', link: { plan_item_id: 'energy', period: '2026-10-01' } })
    const transfer = openDraft(snapshot, walk, { plan_item_id: 'overpayment', period: '2026-11-01' }, null, 'en-GB')
    expect(transfer.draft).toMatchObject({ mode: 'move', account: 'current', to: 'mortgage', link: { plan_item_id: 'overpayment', period: '2026-11-01' } })
  })

  it('takes an amount from the address in minor units and never overwrites it with a card figure', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    expect(openDraft(snapshot, walk, { mode: 'move', to: 'rewards-card', amount: '1234567' }, null, 'en-PH').draft.amount).toBe('12345.67')
    expect(openDraft(snapshot, walk, { mode: 'move', from: 'main', to: 'tax', amount: 'abc' }, null, 'en-PH').draft).toMatchObject({ account: 'main', to: 'tax', amount: '' })
  })
})

describe('card payments', () => {
  it('ticks Paid more than due when charges since the cut push left to pay above the remaining due', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07', rewardsItem)
    const pay = cardPay(snapshot, walk, 'rewards-card') as CardPay
    expect(pay).toMatchObject({ left_minor: 4700000, remaining_minor: 4500000, owed_minor: 4700000, charges_minor: 200000, provisional: false })
    expect(overState(pay, 4700000, null)).toEqual({ allow: true, auto: true, charged_minor: 200000, planned_minor: 0 })
    expect(overState(pay, 4500000, null)).toMatchObject({ allow: false, auto: false })
    // Above both the remaining due and left to pay, only the person can tick it.
    expect(overState(pay, 4700001, null)).toMatchObject({ allow: false, auto: false })
    expect(overState(pay, 4700001, true)).toMatchObject({ allow: true, auto: false })
    expect(overState(pay, 4700000, false)).toMatchObject({ allow: false, auto: true })
    const opened = openDraft(snapshot, walk, { mode: 'move', to: 'rewards-card' }, null, 'en-PH')
    expect(opened.draft.amount).toBe('47000.00')
    const reading = read(snapshot, opened.draft, overState(pay, 4700000, opened.draft.over).allow)
    expect(reading.input?.allow_over).toBe(true)
  })

  it('splits what a payment above the remaining due covers into charges since the cut and charges the plan adds', () => {
    const pay: CardPay = { card_id: 'c', currency: 'PHP', left_minor: 5000, remaining_minor: 1000, owed_minor: 3000, charges_minor: 2000, provisional: false, cut_date: '2026-09-20', due_date: '2026-10-16' }
    expect(overState(pay, 5000, null)).toEqual({ allow: true, auto: true, charged_minor: 2000, planned_minor: 2000 })
    // A credit (remaining due below zero) is not counted as charges.
    expect(overState({ ...pay, remaining_minor: -1000, charges_minor: 4000 }, 3000, null)).toEqual({ allow: true, auto: true, charged_minor: 3000, planned_minor: 0 })
    expect(overState({ ...pay, provisional: true }, 5000, null).auto).toBe(false)
  })
})

describe('a loan payment with escrow due the same day', () => {
  it('adds a prefilled escrow row inside the payment window and saves it as an expense linked to the escrow bill', () => {
    const early = world(mortgage, '2026-10-07')
    expect(loanPay(early.snapshot, early.walk, 'mortgage', 'current')).toMatchObject({ due_minor: 100000, on: '2026-11-01', in_window: false })
    expect(openDraft(early.snapshot, early.walk, { mode: 'move', to: 'mortgage' }, null, 'en-GB').draft).toMatchObject({ amount: '', escrow: false })

    const { snapshot, walk } = world(mortgage, '2026-10-29')
    const pay = loanPay(snapshot, walk, 'mortgage', 'current')
    expect(pay).toMatchObject({ due_minor: 100000, on: '2026-11-01', in_window: true, escrow: { plan_item_id: 'escrow', period: '2026-11-01', name: 'Escrow', amount_minor: 18000 } })
    const opened = openDraft(snapshot, walk, { mode: 'move', to: 'mortgage' }, null, 'en-GB')
    expect(opened.draft).toMatchObject({ account: 'current', to: 'mortgage', amount: '1000.00', escrow: true, escrow_amount: '180.00' })
    const reading = readDraft(snapshot, opened.draft, { locale: 'en-GB', ids: IDS, allow_over: false, escrow: pay?.escrow ?? null })
    expect(reading.errors).toEqual({})
    expect(reading.input?.rows.map((r) => [r.id, r.account_id, r.amount_minor, r.kind, r.transfer_id, r.plan_item_id, r.period])).toEqual([
      [IDS.rows[0], 'current', -100000, 'transfer', IDS.transfer_id, null, null],
      [IDS.rows[1], 'mortgage', 100000, 'transfer', IDS.transfer_id, null, null],
      [IDS.rows[2], 'current', -18000, 'expense', null, 'escrow', '2026-11-01'],
    ])
    expect(reading.input && 'allow_over' in reading.input).toBe(false)
    const without = readDraft(snapshot, { ...opened.draft, escrow: false }, { locale: 'en-GB', ids: IDS, allow_over: false, escrow: pay?.escrow ?? null })
    expect(without.input?.rows).toHaveLength(2)
  })
})

describe('budget tags', () => {
  it('offers the latest used of the month’s allowance categories, and the allowance categories when none was used', () => {
    const { snapshot } = world(mortgage, '2026-10-16')
    expect(categoryOffer(snapshot, '2026-10-16', null)).toMatchObject({ chips: [{ id: 'cat-transport' }, { id: 'cat-groceries' }], unbudgeted: false })
    const fresh = world(mortgage, '2026-10-16', (doc) => {
      doc.transactions = doc.transactions.filter((t) => !('category_id' in t))
    })
    expect(categoryOffer(fresh.snapshot, '2026-10-16', null).chips.map((c) => c.id)).toEqual(['cat-groceries', 'cat-transport'])
  })

  it('lists the categories budgeted in the month of the transaction first, then every other active category', () => {
    const { snapshot } = world(mortgage, '2026-10-16', (doc) => {
      const transport = doc.plan_items.find((p) => p.id === 'transport')
      if (transport) transport.ends_on = '2026-09-01'
    })
    const october = categoryOffer(snapshot, '2026-10-16', null)
    expect(october.budgeted.map((c) => c.id)).toEqual(['cat-groceries'])
    expect(october.all.map((c) => c.id)).toEqual(['cat-groceries', 'cat-transport'])
    expect(categoryOffer(snapshot, '2026-09-30', null).budgeted.map((c) => c.id)).toEqual(['cat-transport', 'cat-groceries'])
  })

  it('never blocks a save on a tag with no budget that month, and says it counts against none', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const offer = categoryOffer(snapshot, '2026-10-07', 'cat-dining')
    expect(offer.unbudgeted).toBe(true)
    expect(offer.budgeted.map((c) => c.id)).toEqual(['cat-groceries'])
    // Dining and Home have no budget this month but were tagged before, so they stay offered.
    expect(offer.all.map((c) => c.id)).toEqual(['cat-groceries', 'cat-dining', 'cat-home'])
    expect(offer.chips.map((c) => c.id)).toEqual(['cat-groceries', 'cat-dining', 'cat-home'])
    const draft = { ...openDraft(snapshot, walk, {}, 'main', 'en-PH').draft, amount: '12.50', category: 'cat-dining' }
    expect(read(snapshot, draft).input?.rows[0]).toMatchObject({ kind: 'expense', amount_minor: -1250, category_id: 'cat-dining' })
  })

  it('puts a tag only on an expense or a refund', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const base = { ...openDraft(snapshot, walk, { mode: 'in' }, 'main', 'en-PH').draft, amount: '20.00', category: 'cat-groceries' }
    expect(read(snapshot, base).input?.rows[0]).toMatchObject({ kind: 'income', amount_minor: 2000, category_id: null })
    expect(read(snapshot, { ...base, refund: true }).input?.rows[0]).toMatchObject({ kind: 'refund', amount_minor: 2000, category_id: 'cat-groceries' })
    const move = { ...base, mode: 'move' as const, to: 'tax' }
    expect(read(snapshot, move).input?.rows.map((r) => r.category_id)).toEqual([null, null])
  })
})

describe('a new category from the picker', () => {
  const archived = (doc: SampleDoc) => {
    doc.categories.push({ id: 'cat-accountant', name: 'Accountant', archived_at: '2026-09-01T00:00:00.000Z' })
  }

  it('reads the name trimmed and sends Settings’ add_category write on the id made when the field opened', () => {
    const { snapshot } = world(abroad, '2026-10-07')
    expect(newCategory(snapshot, '  Tax adviser ', 'cat-new', 'household-1')).toEqual({ edit: { kind: 'add_category', row: { id: 'cat-new', name: 'Tax adviser', archived_at: null, household_id: 'household-1' } } })
    expect(newCategory(snapshot, '   ', 'cat-new', 'household-1')).toEqual({ error: 'Type a name.', existing: null, use: null })
    expect(newCategory(snapshot, 'x'.repeat(41), 'cat-new', 'household-1')).toEqual({ error: 'Use at most 40 characters.', existing: null, use: null })
  })

  it('offers the category a name in use names, ignoring case, and never one that is archived', () => {
    const { snapshot } = world(abroad, '2026-10-07', archived)
    const groceries = snapshot.doc.categories.find((c) => c.id === 'cat-groceries')
    expect(newCategory(snapshot, ' GROCERIES', 'cat-new', 'household-1')).toEqual({ error: 'A category with this name exists.', existing: groceries, use: groceries })
    expect(newCategory(snapshot, 'accountant', 'cat-new', 'household-1')).toMatchObject({ error: 'Accountant is archived. Unarchive it in Settings to use it.', existing: { id: 'cat-accountant' }, use: null })
  })

  it('shows the new category picked once the household holds it, and saves the expense or refund tagged with it', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07', (doc) => {
      doc.categories.push({ id: 'cat-tax', name: 'Tax adviser' })
    })
    const offer = categoryOffer(snapshot, '2026-10-07', 'cat-tax')
    expect(offer.chips.map((c) => c.id)).toEqual(['cat-groceries', 'cat-dining', 'cat-home', 'cat-tax'])
    // A later sheet with nothing picked still finds it under All categories, though it has no budget.
    expect(categoryOffer(snapshot, '2026-10-07', null).all.map((c) => c.id)).toContain('cat-tax')
    expect(offer.unbudgeted).toBe(true)
    const draft = { ...openDraft(snapshot, walk, { mode: 'out' }, 'pesos', 'en-PH').draft, amount: '4500.00', category: 'cat-tax' }
    expect(categoryNote(snapshot, draft, offer, 'October 2026')).toBe('No Tax adviser budget in October 2026. It saves with the tag and counts against no budget.')
    expect(read(snapshot, draft)).toMatchObject({ errors: {}, input: { rows: [{ account_id: 'pesos', kind: 'expense', amount_minor: -450000, category_id: 'cat-tax', plan_item_id: null }] } })
    const refund = { ...draft, mode: 'in' as const, refund: true }
    expect(read(snapshot, refund).input?.rows[0]).toMatchObject({ kind: 'refund', amount_minor: 450000, category_id: 'cat-tax' })
  })

  it('says what a tag does when the month has no budgets, and when an expense goes untagged', () => {
    const none = world(abroad, '2026-10-07', (doc) => {
      doc.plan_items = doc.plan_items.filter((p) => p.kind !== 'allowance')
    })
    const empty = categoryOffer(none.snapshot, '2026-10-07', null)
    expect(empty.budgeted).toEqual([])
    expect(empty.all.map((c) => c.id)).toEqual(['cat-groceries', 'cat-dining', 'cat-home'])
    expect(categoryNote(none.snapshot, { category: null, link: null }, empty, 'October 2026')).toBe('No budgets in October 2026. A category tags the spending and counts against no budget.')
    const { snapshot } = world(abroad, '2026-10-07')
    expect(categoryNote(snapshot, { category: null, link: null }, categoryOffer(snapshot, '2026-10-07', null), 'October 2026')).toBe('No category: this counts as extra spending on top of your budgets.')
    expect(categoryNote(snapshot, { category: 'cat-groceries', link: null }, categoryOffer(snapshot, '2026-10-07', 'cat-groceries'), 'October 2026')).toBeNull()
  })
})

describe('reading the draft into one post_batch', () => {
  it('saves an expense as one row with the sheet’s ids, and a retry reads the same batch', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const draft = { ...openDraft(snapshot, walk, {}, 'main', 'en-PH').draft, amount: '18.40', category: 'cat-groceries', note: ' Market ' }
    const first = read(snapshot, draft)
    expect(first.errors).toEqual({})
    expect(first.input).toEqual({
      batch_id: IDS.batch_id,
      rows: [{ id: IDS.rows[0], account_id: 'main', posted_on: '2026-10-07', amount_minor: -1840, kind: 'expense', category_id: 'cat-groceries', description: 'Market', transfer_id: null, plan_item_id: null, period: null, external_id: null }],
    })
    expect(read(snapshot, draft).input).toEqual(first.input)
  })

  it('builds a batch that post_batch’s schema accepts, with every row field present', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07', withUuids)
    const [main, pesos, card] = [uuidOf('main'), uuidOf('pesos'), uuidOf('rewards-card')]
    const out = { ...openDraft(snapshot, walk, {}, main, 'en-PH').draft, amount: '18.40', category: uuidOf('cat-groceries') }
    const pay = openDraft(snapshot, walk, { mode: 'move', to: card }, null, 'en-PH').draft
    const move = { ...openDraft(snapshot, walk, { mode: 'move', from: main, to: pesos }, null, 'en-PH').draft, amount: '500.00', received: '34600.00' }
    for (const draft of [out, pay, move]) {
      const input = read(snapshot, draft).input
      expect(input).not.toBeNull()
      expect(checkInput(postBatchInput, input).ok).toBe(true)
      for (const row of input?.rows ?? []) expect(Object.keys(row).sort()).toEqual(['account_id', 'amount_minor', 'category_id', 'description', 'external_id', 'id', 'kind', 'period', 'plan_item_id', 'posted_on', 'transfer_id'])
    }
    expect(read(snapshot, pay).input).toMatchObject({ allow_over: false, rows: [{ account_id: pesos, amount_minor: -4500000 }, { account_id: card, amount_minor: 4500000 }] })
  })

  it('moves euros to pesos as two legs with one transfer id, the link on the outgoing leg and the arrival up to 5 days later', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const draft: Draft = { ...openDraft(snapshot, walk, { mode: 'move', from: 'main', to: 'pesos' }, null, 'en-PH').draft, amount: '500.00', received: '34600.00', arrives: '2026-10-08' }
    const reading = read(snapshot, draft)
    expect(reading.input?.rows.map((r) => [r.account_id, r.posted_on, r.amount_minor, r.kind, r.transfer_id])).toEqual([
      ['main', '2026-10-07', -50000, 'transfer', IDS.transfer_id],
      ['pesos', '2026-10-08', 3460000, 'transfer', IDS.transfer_id],
    ])
    expect(read(snapshot, { ...draft, arrives: '2026-10-13' }).errors.arrives).toBe('Pick the day it left or up to 5 days later.')
    expect(read(snapshot, { ...draft, received: '' }).errors.received).toBe('Enter an amount.')
    expect(arrivalDays('2026-10-07')).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'])

    const tax = { ...draft, to: 'tax', received: '', link: { plan_item_id: 'tax-set-aside', period: '2026-10-01' } }
    expect(read(snapshot, tax).input?.rows.map((r) => [r.amount_minor, r.plan_item_id, r.period])).toEqual([
      [-50000, 'tax-set-aside', '2026-10-01'],
      [50000, null, null],
    ])
  })

  it('names what is wrong with each field and builds nothing until it reads', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const draft = openDraft(snapshot, walk, {}, 'main', 'en-PH').draft
    expect(read(snapshot, draft)).toMatchObject({ errors: { amount: 'Enter an amount.' }, input: null })
    expect(read(snapshot, { ...draft, amount: '12,5' }).errors.amount).toBe('Enter an amount in figures, such as 1250.50.')
    expect(read(snapshot, { ...draft, amount: '0' }).errors.amount).toBe('Enter more than 0.')
    expect(read(snapshot, { ...draft, amount: '5', date: '2026-10-08' }).errors.date).toBe('Pick today or an earlier day.')
    expect(read(snapshot, { ...draft, amount: '5', date: '2026-09-31' }).errors.date).toBe('Pick a date.')
    expect(read(snapshot, { ...draft, amount: '5', date: '2026-08-31' }).errors.date).toBe('Main opened on Sep 1, 2026; pick that day or later.')
    expect(read(snapshot, { ...draft, mode: 'move', amount: '5', to: null }).errors.to).toBe('Pick the account it went to.')
    expect(read(snapshot, { ...draft, amount: '5', note: 'x'.repeat(141) }).errors.note).toBe('Use at most 140 characters.')
  })
})

describe('settling a plan item', () => {
  it('offers the occurrence core’s suggestion rule pairs with the amount typed', () => {
    const { snapshot, walk } = world(mortgage, '2026-10-16')
    const draft = openDraft(snapshot, walk, {}, 'current', 'en-GB').draft
    expect(settles(snapshot, draft, 11000)).toMatchObject({ occurrence: { id: 'energy:2026-10-01' }, name: 'Energy', chosen: false })
    expect(settles(snapshot, draft, 20000)).toBeNull()
    const linked = { ...draft, link: { plan_item_id: 'energy', period: '2026-10-01' } }
    expect(settles(snapshot, linked, null)).toMatchObject({ name: 'Energy', chosen: true })
    expect(read(snapshot, { ...linked, amount: '110.00' }).input?.rows[0]).toMatchObject({ plan_item_id: 'energy', period: '2026-10-01', description: 'Energy' })
  })

  it('records a bill from the plan with no category, since a linked row counts against no budget', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const opened = openDraft(snapshot, walk, { plan_item_id: 'mobile', period: '2026-10-01' }, null, 'en-PH').draft
    expect(opened).toMatchObject({ mode: 'out', account: 'pesos', amount: '1200.00', category: null, link: { plan_item_id: 'mobile', period: '2026-10-01' } })
    expect(read(snapshot, opened)).toMatchObject({ errors: {}, input: { rows: [{ account_id: 'pesos', kind: 'expense', amount_minor: -120000, category_id: null, plan_item_id: 'mobile', period: '2026-10-01', description: 'Mobile plan' }] } })
    // The month has a budget, yet the note says the tag is optional rather than extra spending.
    expect(categoryNote(snapshot, opened, categoryOffer(snapshot, opened.date, null), 'October 2026')).toBe('A payment that settles a plan item counts against no budget, so a category is optional.')
    // A tapped suggestion settles the same way: quick add starts tagged with the one budget, and the tag can go.
    const quick = { ...openDraft(snapshot, walk, { mode: 'out' }, 'pesos', 'en-PH').draft, amount: '1200.00' }
    expect(quick.category).toBe('cat-groceries')
    const offered = settles(snapshot, quick, 120000)
    expect(offered).toMatchObject({ occurrence: { id: 'mobile:2026-10-01' }, chosen: false })
    const chosen = { ...quick, category: null, link: { plan_item_id: 'mobile', period: '2026-10-01' } }
    expect(read(snapshot, chosen).input?.rows[0]).toMatchObject({ category_id: null, plan_item_id: 'mobile', period: '2026-10-01' })
  })

  it('records a bill from the plan in a household with no categories at all', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07', (doc) => {
      doc.plan_items = doc.plan_items.filter((p) => p.kind !== 'allowance')
      doc.transactions = doc.transactions.map((t) => ({ ...t, category_id: null }))
      doc.categories = []
    })
    const opened = openDraft(snapshot, walk, { plan_item_id: 'mobile', period: '2026-10-01' }, null, 'en-PH').draft
    expect(read(snapshot, opened)).toMatchObject({ errors: {}, input: { rows: [{ kind: 'expense', amount_minor: -120000, category_id: null, plan_item_id: 'mobile' }] } })
  })

  it('drops a link the draft can no longer settle when the mode or account changes', () => {
    const { snapshot, walk } = world(mortgage, '2026-10-16')
    const draft = { ...openDraft(snapshot, walk, {}, 'current', 'en-GB').draft, link: { plan_item_id: 'energy', period: '2026-10-01' } }
    expect(linkFits(snapshot, draft)).toBe(true)
    expect(linkFits(snapshot, { ...draft, account: 'savings' })).toBe(false)
    expect(switchMode(snapshot, draft, 'in', null)).toMatchObject({ mode: 'in', account: 'current', link: null })
    expect(switchMode(snapshot, draft, 'move', null)).toMatchObject({ mode: 'move', account: 'current', to: null, link: null })
  })
})

describe('the rest of the sheet', () => {
  it('lists accounts by role: Out and In take cash and cards, Move leaves cash for any other account', () => {
    const { snapshot } = world(mortgage, '2026-10-07')
    expect(accountChoices(snapshot, 'out', 'account').map((a) => a.id)).toEqual(['current', 'savings'])
    expect(accountChoices(snapshot, 'move', 'to', 'current').map((a) => a.id)).toEqual(['savings', 'mortgage'])
  })

  it('writes a prefilled amount exactly, in the locale’s decimal mark', () => {
    expect(amountText(4500000, 'PHP', 'en-PH')).toBe('45000.00')
    expect(amountText(5, 'EUR', 'de-DE')).toBe('0,05')
    expect(amountText(1234, 'JPY', 'ja-JP')).toBe('1234')
    expect(amountText(1234567, 'KWD', 'en')).toBe('1234.567')
  })

  it('reads the rate a move got from its two amounts against the day’s ECB rate', () => {
    const { snapshot } = world(abroad, '2026-10-07')
    const rate = realRate(snapshot, 50000, 'EUR', 3475000, 'PHP')
    expect(rate).toMatchObject({ from: 'EUR', to: 'PHP', unit_minor: 100, quote_minor: 6950 })
    expect(rate?.below_ecb).toBeCloseTo(0.007142857, 6)
    expect(realRate(snapshot, 3475000, 'PHP', 50000, 'EUR')).toMatchObject({ from: 'EUR', to: 'PHP', unit_minor: 100, quote_minor: 6950 })
    expect(dayChoices('2026-10-01')).toEqual([
      { value: '2026-10-01', title: 'Today' },
      { value: '2026-09-30', title: 'Yesterday' },
    ])
  })

  it('shows a refused card payment under its amount with the remaining due, and names an already recorded row', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const draft = { ...openDraft(snapshot, walk, { mode: 'move', to: 'rewards-card' }, null, 'en-PH').draft, amount: '50000.00' }
    const input = read(snapshot, draft).input
    const leg = input?.rows[1]
    const over = problemOf(snapshot, { kind: 'rejected', code: 'over_remainder', message: 'The server did not accept this change.', detail: { error: 'over_remainder', id: leg?.id, account_id: 'rewards-card', amount_minor: 5000000, remaining_minor: 4500000, cut_date: '2026-09-20' }, technical: 'post_batch: over_remainder' }, input, 'en-PH')
    expect(over).toMatchObject({ field: 'amount', text: 'This is more than the remaining due of {money}. Tick Paid more than due to record it anyway.', money: { minor: 4500000, currency: 'PHP' } })
    const credit = problemOf(snapshot, { kind: 'rejected', code: 'over_remainder', message: '', detail: { id: leg?.id, account_id: 'rewards-card', remaining_minor: -200000 }, technical: null }, input, 'en-PH')
    expect(credit).toMatchObject({ text: 'Nothing is left due on this statement; the card is {money} in credit. Tick Paid more than due to record it anyway.', money: { minor: 200000, currency: 'PHP' } })
    const recorded = problemOf(snapshot, { kind: 'rejected', code: 'already_recorded', message: '', detail: { error: 'already_recorded', external_ids: ['x'], ids: [input?.rows[0]?.id] }, technical: null }, input, 'en-PH')
    expect(recorded.text).toBe('Already recorded: the transfer on Pesos dated Oct 7, 2026. Nothing was saved.')
    expect(problemOf(snapshot, { kind: 'network', code: null, message: 'Waypoint could not reach the server.', detail: null, technical: null }, input, 'en-PH').text).toBe('Waypoint could not reach the server. Try again; a retry never saves twice.')
  })
})

describe('filling Out from a receipt PDF', () => {
  const receipt = (over: Partial<ReceiptRead> = {}): ReceiptRead => ({ kind: 'receipt', currency: 'EUR', merchant: 'Supermercado Ejemplo', date: '2026-10-05', total_minor: 1055, category_id: 'cat-home', summary: 'Milk, rice and chicken', truncated: false, ...over })

  it('fills the total, day, shop and category as if typed, on an account in the receipt’s currency, and saves as one expense', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const opened = openDraft(snapshot, walk, { mode: 'out' }, 'pesos', 'en-PH').draft
    const filled = receiptDraft(snapshot, opened, receipt(), 'en-PH')
    if (!('draft' in filled)) throw new Error(filled.mismatch)
    // Pesos is in PHP, so the receipt moves to the first euro account.
    expect(filled.draft).toMatchObject({ mode: 'out', account: 'main', amount: amountText(1055, 'EUR', 'en-PH'), date: '2026-10-05', category: 'cat-home', note: 'Supermercado Ejemplo · Milk, rice and chicken' })
    const input = readDraft(snapshot, filled.draft, { locale: 'en-PH', ids: IDS, allow_over: false, escrow: null }).input
    expect(input?.rows).toMatchObject([{ account_id: 'main', kind: 'expense', amount_minor: -1055, posted_on: '2026-10-05', category_id: 'cat-home' }])
    // An account already in the receipt's currency stays chosen.
    const onTax = receiptDraft(snapshot, { ...opened, account: 'tax' }, receipt(), 'en-PH')
    expect('draft' in onTax && onTax.draft.account).toBe('tax')
  })

  it('keeps the sheet’s day and category where the receipt gave none, and fills nothing in a currency no account has', () => {
    const { snapshot, walk } = world(abroad, '2026-10-07')
    const opened = openDraft(snapshot, walk, { mode: 'out' }, 'main', 'en-PH').draft
    const vague = receiptDraft(snapshot, opened, receipt({ category_id: null, date: null, merchant: '' }), 'en-PH')
    expect('draft' in vague && [vague.draft.category, vague.draft.date, vague.draft.note]).toEqual([opened.category, '2026-10-07', 'Milk, rice and chicken'])
    expect(receiptDraft(snapshot, opened, receipt({ currency: 'USD' }), 'en-PH')).toEqual({ mismatch: 'This receipt is in USD, and no open account here is.' })
    expect(receiptFilledNote(receipt({ date: null, truncated: true }))).toBe('Supermercado Ejemplo. Check the amount, day, account and category before you save. It printed no day, so pick one. Only its first pages were read.')
  })
})
