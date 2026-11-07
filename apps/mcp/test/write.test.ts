import { fxBreakeven, walkMetrics, type CompareResult } from '@waypoint/core'
import { compare, encodeLevers } from '@waypoint/core/compare'
import type { PostTransactionsInput } from '@waypoint/core/agent'
import { abroad, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import type { World } from '../src/data'
import { deltas } from '../src/deltas'
import { AgentError, messageOf, Refusal } from '../src/errors'
import { written, type ServerDeps } from '../src/server'
import { compareTool } from '../src/tools/compare'
import { amount } from '../src/tools/read/shape'
import { deleteFilter, deleteTransactions } from '../src/tools/write/delete'
import { upsertPlanItem } from '../src/tools/write/item'
import { setLink } from '../src/tools/write/link'
import { batchOf, postTransactions } from '../src/tools/write/post'
import { itemOf, periodProblem, refusal, rowId } from '../src/tools/write/shape'
import { addStatement, statementOf } from '../src/tools/write/statement'
import { fakeIO, ok, OWNER, refused, typedOutside, typedText, uuid, withUuids, worldAt } from './worlds'

const AS_OF = '2026-10-16'
const id = uuid
const [MAIN, PESOS, REWARDS] = [id('main'), id('pesos'), id('rewards-card')]
const BATCH = id('batch-1')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// abroad on its first top-up day, with database ids and an unlinked Mobile plan payment this month.
function household(edit?: (doc: SampleDoc) => void): World {
  return worldAt(abroad, AS_OF, (doc) => {
    doc.transactions.push({ id: 'mobile-now', account_id: 'pesos', posted_on: '2026-10-09', amount_minor: -120000, kind: 'expense', description: 'Mobile plan' })
    edit?.(doc)
    withUuids(doc)
  })
}

const refusalOf = (error: unknown) => JSON.parse(messageOf(error)) as Record<string, unknown>

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('it did not refuse')
}

type Row = PostTransactionsInput['rows'][number]
const FOOD: Row = { account_id: MAIN, posted_on: AS_OF, amount: '-23.40', kind: 'expense', category_id: id('cat-groceries'), description: 'Corner shop' }
const PHONE: Row = { account_id: PESOS, posted_on: AS_OF, amount: '-1200', kind: 'expense', plan_item_id: id('mobile'), period: '2026-10-01', description: 'Mobile plan' }
const receipt: PostTransactionsInput = { batch_id: BATCH, rows: [FOOD, PHONE], expect_before: { [MAIN]: '6450.00', [PESOS]: '30000' } }

describe('post_transactions', () => {
  it('reads each amount once in its row’s account currency and makes the row ids from the batch, the same for the same call', () => {
    const { snapshot } = household()
    const batch = batchOf(snapshot, receipt)
    expect(batch.rows.map((r) => [r.id, r.account_id, r.amount_minor, r.category_id, r.plan_item_id, r.period, r.description])).toEqual([
      [rowId(BATCH, 0), MAIN, -2340, id('cat-groceries'), null, null, 'Corner shop'],
      [rowId(BATCH, 1), PESOS, -120000, null, id('mobile'), '2026-10-01', 'Mobile plan'],
    ])
    expect(batch.expect_before).toEqual({ [MAIN]: 645000, [PESOS]: 3000000 })
    expect(batchOf(snapshot, receipt)).toEqual(batch)
    expect(rowId(BATCH, 0)).toMatch(UUID)
    expect(new Set([rowId(BATCH, 0), rowId(BATCH, 1), rowId(id('batch-2'), 0)]).size).toBe(3)
  })

  it('refuses before sending: too many decimals, an account the household lacks, a period the item does not have, and a sign core refuses', () => {
    const { snapshot } = household()
    const one = (row: Partial<Row>) => ({ batch_id: BATCH, rows: [{ ...FOOD, ...row }] })
    expect(() => batchOf(snapshot, one({ amount: '-23.405' }))).toThrow("rows[0].amount: '-23.405' is not an amount in EUR, which takes at most 2 decimals. Nothing was saved.")
    expect(() => batchOf(snapshot, one({ account_id: id('gone') }))).toThrow(`No account '${id('gone')}' in this household.`)
    expect(() => batchOf(snapshot, { batch_id: BATCH, rows: [{ ...PHONE, period: '2026-10-10' }] })).toThrow(`rows[0].period: 2026-10-10 is not a period of plan item ${id('mobile')}; its period in 2026-10 is 2026-10-01. Nothing was saved.`)
    const sign = (() => {
      try {
        batchOf(snapshot, one({ amount: '23.40' }))
      } catch (error) {
        return refusalOf(error)
      }
    })()
    expect(sign).toEqual({ error: 'bad_input', message: 'Nothing was saved: rows[0].amount: an expense is money out, so it must be negative', issues: ['rows[0].amount_minor: an expense is money out, so it must be negative'] })
  })

  it('sends one post_batch call and answers with its status, batch and row ids', async () => {
    const world = household()
    const io = fakeIO(world, [ok({ status: 'applied', batch_id: BATCH, inserted: 2, balances_before: {}, balances_after: {} })])
    const out = await postTransactions.run(io, receipt)
    expect(io.requests).toEqual([[['rpc', ['post_batch', { p_batch: batchOf(world.snapshot, receipt) }]]]])
    expect(out).toEqual({ status: 'applied', batch_id: BATCH, inserted: 2, row_ids: [rowId(BATCH, 0), rowId(BATCH, 1)], link: `http://localhost:8090/money/${MAIN}?month=2026-10` })
  })
})

describe('a post_batch refusal', () => {
  it('comes back as the refusal answer, naming the external ids already recorded', async () => {
    const world = household()
    const detail = { error: 'already_recorded', external_ids: ['TRANSFER-1'], ids: [rowId(BATCH, 0)] }
    const io = fakeIO(world, [refused('P0001', "already_recorded: external id 'TRANSFER-1' is already recorded on its account", detail)])
    const error = await rejection(postTransactions.run(io, { batch_id: BATCH, rows: [{ ...FOOD, external_id: 'TRANSFER-1' }] }))
    expect(refusalOf(error)).toEqual({
      error: 'already_recorded',
      message: "Nothing was saved: external id 'TRANSFER-1' is already recorded on its account. Those bank transactions are in the ledger already (get_ledger shows each row’s external_id); leave them out.",
      external_ids: ['TRANSFER-1'],
      ids: [rowId(BATCH, 0)],
    })
  })
})

describe('refusals', () => {
  it('give a wrong expected balance with the actual one, in the account’s currency', () => {
    const detail = { error: 'balance_mismatch', when: 'before', accounts: [{ account_id: MAIN, expected_minor: 100, actual_minor: 645000 }] }
    const error = refusal({ code: 'P0001', message: `balance_mismatch: before the batch, account ${MAIN} is 645000, not the expected 100`, details: JSON.stringify(detail) }, household())
    expect(error).toBeInstanceOf(Refusal)
    expect(refusalOf(error)).toEqual({
      error: 'balance_mismatch',
      message: `Nothing was saved: before the batch, account ${MAIN} is 6450.00 EUR, not the expected 1.00 EUR. A balance is the opening balance plus every row dated today or earlier, as the bank shows it.`,
      when: 'before',
      accounts: [{ account_id: MAIN, expected: amount(100, 'EUR'), actual: amount(645000, 'EUR') }],
    })
  })

  it('name the external ids already recorded, and a card payment above what is left on the statement', () => {
    const world = household()
    const recorded = refusal({ code: 'P0001', message: "already_recorded: external id 'TRANSFER-1' is already recorded on its account", details: JSON.stringify({ error: 'already_recorded', external_ids: ['TRANSFER-1'], ids: [rowId(BATCH, 0)] }) }, world)
    expect(refusalOf(recorded)).toMatchObject({ error: 'already_recorded', external_ids: ['TRANSFER-1'], ids: [rowId(BATCH, 0)], message: expect.stringContaining("external id 'TRANSFER-1' is already recorded") })
    const detail = { error: 'over_remainder', id: rowId(BATCH, 1), account_id: REWARDS, amount_minor: 5000000, remaining_minor: 4500000, cut_date: '2026-09-20' }
    const over = refusal({ code: 'P0001', message: 'over_remainder: row pays too much', details: JSON.stringify(detail) }, world)
    expect(refusalOf(over)).toEqual({
      error: 'over_remainder',
      message: `Nothing was saved: row ${rowId(BATCH, 1)} pays 50000.00 PHP into card ${REWARDS}, above the 45000.00 PHP remaining due on the statement cut 2026-09-20. get_debt gives left_to_pay; enter a newer statement with add_statement first, or set allow_over to pay more.`,
      id: rowId(BATCH, 1),
      account_id: REWARDS,
      amount: amount(5000000, 'PHP'),
      remaining: amount(4500000, 'PHP'),
      cut_date: '2026-09-20',
    })
  })

  it('name the check a trigger refused at commit, a second statement for a cut, and anything else in the database’s words', () => {
    const world = household()
    expect(refusalOf(refusal({ code: '23514', message: `check_link: transaction ${MAIN}: an adjustment never links` }, world))).toEqual({ error: 'check_link', message: `Nothing was saved: transaction ${MAIN}: an adjustment never links` })
    expect(refusalOf(refusal({ code: '23505', message: 'duplicate key value violates unique constraint "statements_account_id_cut_date_key"' }, world))).toEqual({
      error: 'statement_exists',
      message: 'Nothing was saved: the card already has a statement cut on that day; Waypoint keeps one per cut.',
    })
    expect(refusalOf(refusal({ code: '42501', message: 'permission denied for table transactions' }, world, 'Nothing was deleted'))).toEqual({ error: 'database', message: 'Nothing was deleted: the database refused the write: permission denied for table transactions (42501)' })
  })
})

describe('delete_transactions', () => {
  it('deletes rows by id with every leg of their transfers, in one request', async () => {
    const world = household()
    const filter = deleteFilter(world.snapshot, [id('topup-now-in'), id('rent-now')])
    expect(filter).toBe(`id.in.(${id('topup-now-in')},${id('rent-now')}),transfer_id.in.(${id('topup-now')})`)
    const gone = [
      { id: id('topup-now-out'), account_id: MAIN, posted_on: '2026-10-02' },
      { id: id('topup-now-in'), account_id: PESOS, posted_on: '2026-10-02' },
      { id: id('rent-now'), account_id: MAIN, posted_on: '2026-10-01' },
    ]
    const io = fakeIO(world, [ok(gone)])
    const out = await deleteTransactions.run(io, { ids: [id('topup-now-in'), id('rent-now')] })
    expect(io.requests).toEqual([
      [
        ['from', ['transactions']],
        ['delete', []],
        ['or', [filter]],
        ['select', ['id,account_id,posted_on']],
      ],
    ])
    expect(out).toEqual({ status: 'deleted', batch_id: null, deleted_ids: gone.map((g) => g.id).sort(), link: `http://localhost:8090/money/${MAIN}?month=2026-10` })
  })

  it('deletes a batch by its id, and says when no row has it', async () => {
    const world = household()
    const io = fakeIO(world, [ok([{ id: rowId(BATCH, 0), account_id: MAIN, posted_on: AS_OF }]), ok([])])
    expect(await deleteTransactions.run(io, { batch_id: BATCH })).toMatchObject({ status: 'deleted', batch_id: BATCH, deleted_ids: [rowId(BATCH, 0)] })
    expect(io.requests[0]).toEqual([
      ['from', ['transactions']],
      ['delete', []],
      ['eq', ['batch_id', BATCH]],
      ['select', ['id,account_id,posted_on']],
    ])
    await expect(deleteTransactions.run(io, { batch_id: BATCH })).rejects.toThrow(`Nothing was deleted: no transaction in this household has batch_id ${BATCH}.`)
  })

  it('refuses an id the household lacks before sending anything', async () => {
    const io = fakeIO(household())
    await expect(deleteTransactions.run(io, { ids: [id('gone')] })).rejects.toThrow(`No transaction '${id('gone')}' in this household.`)
    expect(io.requests).toEqual([])
  })
})

describe('set_link', () => {
  it('links a row only while it settles nothing, and gives the occurrence as the engine sees it after', async () => {
    const before = household()
    const after = household((doc) => Object.assign(doc.transactions.find((t) => t.id === 'mobile-now') ?? {}, { plan_item_id: 'mobile', period: '2026-10-01' }))
    const io = fakeIO(before, [ok([{ id: id('mobile-now') }])], after)
    const out = await setLink.run(io, { action: 'link', row_id: id('mobile-now'), plan_item_id: id('mobile'), period: '2026-10-01' })
    expect(io.requests).toEqual([
      [
        ['from', ['transactions']],
        ['update', [{ plan_item_id: id('mobile'), period: '2026-10-01' }]],
        ['eq', ['id', id('mobile-now')]],
        ['is', ['plan_item_id', null]],
        ['select', ['id']],
      ],
    ])
    expect(out).toMatchObject({ status: 'linked', batch_id: null, row_id: id('mobile-now'), occurrence: { id: `${id('mobile')}:2026-10-01`, state: 'settled', open: amount(0, 'PHP'), linked_row_ids: [id('mobile-now')] } })
    expect(out.link).toBe('http://localhost:8090/months?month=2026-10&view=todo')
    // The same link again changes nothing and sends nothing.
    const again = fakeIO(after, [], after)
    expect(await setLink.run(again, { action: 'link', row_id: id('mobile-now'), plan_item_id: id('mobile'), period: '2026-10-01' })).toMatchObject({ status: 'already_applied' })
    expect(again.requests).toEqual([])
  })

  it('links a transfer by its outgoing leg whichever leg is named, and refuses one that does not fit the item', async () => {
    const world = household((doc) => doc.plan_items.push({ id: 'pesos-topup', kind: 'transfer', name: 'Pesos top-up', from_account_id: 'main', to_account_id: 'pesos', amount_minor: 50000, starts_on: '2026-09-02' }))
    const io = fakeIO(world, [ok([{ id: id('topup-now-out') }])])
    expect(await setLink.run(io, { action: 'link', row_id: id('topup-now-in'), plan_item_id: id('pesos-topup'), period: '2026-10-01' })).toMatchObject({ status: 'linked', row_id: id('topup-now-out') })
    await expect(setLink.run(fakeIO(world), { action: 'link', row_id: id('topup-now-in'), plan_item_id: id('tax-set-aside'), period: '2026-10-01' })).rejects.toThrow(
      `Nothing was saved: row ${id('topup-now-out')} cannot settle plan item ${id('tax-set-aside')}: the other leg must land in the item's account '${id('tax')}'.`,
    )
    await expect(setLink.run(fakeIO(world), { action: 'link', row_id: id('rent-now'), plan_item_id: id('rent'), period: '2026-11-01' })).rejects.toThrow(`row ${id('rent-now')} already settles plan item ${id('rent')} for 2026-10-01. Unlink it first.`)
  })

  it('unlinks only while the row still settles that occurrence, and skips or unskips only while the list reads as found', async () => {
    const world = household()
    const unlink = fakeIO(world, [ok([{ id: id('rent-now') }])])
    expect(await setLink.run(unlink, { action: 'unlink', row_id: id('rent-now') })).toMatchObject({ status: 'unlinked', row_id: id('rent-now') })
    expect(unlink.requests[0]).toEqual([
      ['from', ['transactions']],
      ['update', [{ plan_item_id: null, period: null }]],
      ['eq', ['id', id('rent-now')]],
      ['eq', ['plan_item_id', id('rent')]],
      ['eq', ['period', '2026-10-01']],
      ['select', ['id']],
    ])
    const skip = fakeIO(world, [ok([{ id: id('insurance') }])])
    expect(await setLink.run(skip, { action: 'skip', plan_item_id: id('insurance'), period: '2026-10-01' })).toMatchObject({ status: 'skipped' })
    expect(skip.requests[0]).toEqual([
      ['from', ['plan_items']],
      ['update', [{ skip_periods: ['2026-10-01'] }]],
      ['eq', ['id', id('insurance')]],
      ['eq', ['skip_periods', '{}']],
      ['select', ['id']],
    ])
    expect(await setLink.run(fakeIO(world), { action: 'unskip', plan_item_id: id('insurance'), period: '2026-10-01' })).toMatchObject({ status: 'already_applied' })
    // A row someone else changed first matches nothing, and the answer says so.
    await expect(setLink.run(fakeIO(world, [ok([])]), { action: 'skip', plan_item_id: id('insurance'), period: '2026-10-01' })).rejects.toThrow('Nothing was saved: the row changed since this call read the household.')
  })
})

describe('upsert_plan_item', () => {
  it('refuses to move a linked item’s account and points to change_from', async () => {
    const io = fakeIO(household())
    const error = await rejection(upsertPlanItem.run(io, { id: id('rent'), from_account_id: id('tax') }))
    expect(refusalOf(error)).toMatchObject({ error: 'linked', plan_item_id: id('rent'), linked_row_ids: [id('rent-last'), id('rent-now')].sort() })
    expect(refusalOf(error).message).toContain('change_from')
    expect(io.requests).toEqual([])
  })

  it('changes only the fields given, only while every column reads as found', async () => {
    const world = household()
    const io = fakeIO(world, [ok([{ id: id('rent') }])])
    expect(await upsertPlanItem.run(io, { id: id('rent'), amount: '950.00' })).toMatchObject({ status: 'updated', plan_item_id: id('rent'), changed: ['amount'] })
    const [request = []] = io.requests
    expect(request.slice(0, 3)).toEqual([
      ['from', ['plan_items']],
      ['update', [{ amount_minor: 95000 }]],
      ['eq', ['id', id('rent')]],
    ])
    expect(request.slice(3, -1)).toEqual([
      ['eq', ['kind', 'bill']],
      ['eq', ['name', 'Rent']],
      ['eq', ['from_account_id', MAIN]],
      ['is', ['to_account_id', null]],
      ['is', ['category_id', null]],
      ['eq', ['amount_minor', 90000]],
      ['eq', ['every', 'month']],
      ['eq', ['starts_on', '2026-09-01']],
      ['is', ['ends_on', null]],
      ['eq', ['roll', 'following']],
      ['eq', ['confidence', 'committed']],
      ['eq', ['stops_with_income', false]],
    ])
    expect(await upsertPlanItem.run(fakeIO(world), { id: id('rent'), amount: '900' })).toMatchObject({ status: 'already_applied' })
  })

  it('adds an item with the id given, as the signed-in household’s, after core’s checks', async () => {
    const io = fakeIO(household(), [ok([{ id: id('gym') }])])
    const out = await upsertPlanItem.run(io, { id: id('gym'), kind: 'bill', name: 'Gym', from_account_id: MAIN, amount: '30', starts_on: '2026-11-05' })
    expect(out).toMatchObject({ status: 'created', plan_item_id: id('gym'), link: `http://localhost:8090/plan/item/${id('gym')}` })
    expect(io.requests[0]?.[1]).toEqual([
      'insert',
      [{ id: id('gym'), kind: 'bill', name: 'Gym', from_account_id: MAIN, to_account_id: null, category_id: null, amount_minor: 3000, every: 'month', starts_on: '2026-11-05', ends_on: null, roll: 'none', confidence: 'committed', stops_with_income: false, skip_periods: [], household_id: OWNER }],
    ])
    await expect(upsertPlanItem.run(fakeIO(household()), { kind: 'bill', name: 'Gym', from_account_id: MAIN, starts_on: '2026-11-05' })).rejects.toThrow('amount: a new item needs its amount.')
    await expect(upsertPlanItem.run(fakeIO(household()), { kind: 'income', name: 'Gym', from_account_id: MAIN, amount: '30', starts_on: '2026-11-05' })).rejects.toThrow('income has no from account')
  })

  it('adds a bill every 3 months, and refuses a budget every 3 months before sending', async () => {
    const io = fakeIO(household(), [ok([{ id: id('fee') }])])
    expect(await upsertPlanItem.run(io, { id: id('fee'), kind: 'bill', name: 'Accountant', from_account_id: PESOS, amount: '4500', every: 'quarter', starts_on: '2026-10-15' })).toMatchObject({ status: 'created', plan_item_id: id('fee') })
    expect(io.requests[0]?.[1]).toEqual([
      'insert',
      [{ id: id('fee'), kind: 'bill', name: 'Accountant', from_account_id: PESOS, to_account_id: null, category_id: null, amount_minor: 450000, every: 'quarter', starts_on: '2026-10-15', ends_on: null, roll: 'none', confidence: 'committed', stops_with_income: false, skip_periods: [], household_id: OWNER }],
    ])
    const budget = fakeIO(household())
    await expect(upsertPlanItem.run(budget, { kind: 'allowance', name: 'Food', from_account_id: MAIN, category_id: id('cat-groceries'), amount: '300', every: 'quarter', starts_on: '2026-11-01' })).rejects.toThrow(
      'Nothing was saved: every: an allowance is a monthly budget, so it never repeats every 3 months',
    )
    expect(budget.requests).toEqual([])
  })

  it('changes a quarterly item from a month inside its quarter at its next occurrence, and links only its own periods', async () => {
    const world = household((doc) => {
      doc.plan_items.push({ id: 'fee', kind: 'bill', name: 'Accountant', from_account_id: 'pesos', amount_minor: 450000, every: 'quarter', starts_on: '2026-07-15' })
    })
    const fee = itemOf(world.snapshot, id('fee'))
    expect(periodProblem(fee, '2026-10-01')).toBeNull()
    expect(periodProblem(fee, '2026-11-01')).toBe(`plan item ${id('fee')} has no occurrence in 2026-11`)
    const io = fakeIO(world, [ok(id('fee-copy'))])
    expect(await upsertPlanItem.run(io, { id: id('fee'), amount: '5000', day: 20, change_from: '2026-11' })).toMatchObject({ status: 'split', new_plan_item_id: id('fee-copy') })
    expect(io.requests).toEqual([[['rpc', ['split_plan_item', { p_id: id('fee'), p_from: '2026-11-01', p_patch: { amount_minor: 500000, day: 20 } }]]]])
  })

  it('changes from a month through split_plan_item, carrying only what changed', async () => {
    const io = fakeIO(household(), [ok(id('rent-copy'))])
    const out = await upsertPlanItem.run(io, { id: id('rent'), amount: '950.00', day: 3, change_from: '2026-11' })
    expect(io.requests).toEqual([[['rpc', ['split_plan_item', { p_id: id('rent'), p_from: '2026-11-01', p_patch: { amount_minor: 95000, day: 3 } }]]]])
    expect(out).toMatchObject({ status: 'split', plan_item_id: id('rent'), new_plan_item_id: id('rent-copy'), from_month: '2026-11' })
    await expect(upsertPlanItem.run(fakeIO(household()), { id: id('rent'), from_account_id: id('tax'), change_from: '2026-10' })).rejects.toThrow(`2026-10-01 has transaction ${id('rent-now')} linked on the old account`)
    await expect(upsertPlanItem.run(fakeIO(household()), { id: id('rent'), name: 'Rent', change_from: '2026-11' })).rejects.toThrow('change_from needs a field that changes from 2026-11')
  })
})

describe('add_statement', () => {
  const printed = { account_id: REWARDS, cut_date: '2026-10-20', due_date: '2026-11-16', previous_balance: '70000.00', payments_and_credits: '70000', charges: '2000.00', installments: '0', interest: '0', fees: '0', total_due: '2000.00', minimum_due: '200.00' }

  it('reads the printed figures in the card’s currency and checks they add up', () => {
    const statement = statementOf({ id: REWARDS, currency: 'PHP' }, printed, id('s'))
    expect(statement).toMatchObject({ id: id('s'), previous_balance_minor: 7000000, payments_and_credits_minor: 7000000, charges_minor: 200000, installments_minor: 0, total_due_minor: 200000, minimum_due_minor: 20000, available_credit_minor: null })
    expect(() => statementOf({ id: REWARDS, currency: 'PHP' }, { ...printed, total_due: '2500.00' }, id('s'))).toThrow('Nothing was saved: total_due: the parts add up to 2000.00, but total_due is 2500.00: off by 500.00')
  })

  it('inserts a new cut as the signed-in household’s and answers with core’s checks on the household after it', async () => {
    const before = household()
    const after = household((doc) => doc.statements.push({ id: 'entered', account_id: 'rewards-card', cut_date: '2026-10-20', due_date: '2026-11-16', previous_balance_minor: 7000000, payments_and_credits_minor: 7000000, charges_minor: 200000, installments_minor: 0, interest_minor: 0, fees_minor: 0, total_due_minor: 200000, minimum_due_minor: 20000 }))
    const io = fakeIO(before, [ok([{ id: id('entered') }])], after)
    const out = await addStatement.run(io, { ...printed, id: id('entered') })
    expect(io.requests[0]?.slice(0, 2)).toEqual([
      ['from', ['statements']],
      ['insert', [{ ...statementOf({ id: REWARDS, currency: 'PHP' }, printed, id('entered')), household_id: OWNER }]],
    ])
    // The laptop's 5,000.00 bills at this cut, and the printed statement says none.
    expect(out).toMatchObject({ status: 'added', statement_id: id('entered'), checks: { previous_balance: null, installments: { printed: amount(0, 'PHP'), expected: amount(500000, 'PHP'), difference: amount(-500000, 'PHP') } } })
    // The same figures again change nothing; other figures for the cut are refused.
    const again = fakeIO(after, [], after)
    expect(await addStatement.run(again, printed)).toMatchObject({ status: 'already_applied', statement_id: id('entered') })
    expect(again.requests).toEqual([])
    expect(refusalOf(await rejection(addStatement.run(fakeIO(after), { ...printed, charges: '2500.00', total_due: '2500.00' })))).toMatchObject({ error: 'statement_exists', statement_id: id('entered') })
    await expect(addStatement.run(fakeIO(before), { ...printed, account_id: MAIN })).rejects.toThrow('statements are for cards')
  })
})

describe('what a write moved', () => {
  it('is nothing on the same household', async () => {
    const world = household()
    const same = await deltas(world, world)
    expect(same.moved).toBe(false)
    expect(same.lowest.every((l) => l.change?.amount_minor === 0)).toBe(true)
    expect(same.days_under_floor.change).toBe(0)
    expect(same.fx_margin?.change).toBe(0)
  })

  it('is the engine’s change in each cash account’s lowest balance, days under floor and FX margin', async () => {
    const before = household()
    const after = household((doc) => doc.transactions.push({ id: 'shoes', account_id: 'main', posted_on: AS_OF, amount_minor: -50000, kind: 'expense', description: 'Shoes' }))
    const moved = await deltas(before, after)
    const [b, a] = [walkMetrics(before.snapshot, before.walk), walkMetrics(after.snapshot, after.walk)]
    expect(moved.lowest.map((l) => [l.account_id, l.change?.amount_minor])).toEqual(b.cash.map((c) => [c.account_id, (a.cash.find((x) => x.account_id === c.account_id)?.lowest_minor ?? 0) - c.lowest_minor]))
    expect(moved.lowest.find((l) => l.account_id === MAIN)?.change?.amount_minor).toBeLessThan(0)
    const days = (m: typeof b) => m.cash.reduce((n, c) => n + c.days_under_floor, 0)
    expect(moved.days_under_floor).toMatchObject({ before: days(b), after: days(a), change: days(a) - days(b) })
    const margin = async (w: World) => {
      const found = await fxBreakeven(w.snapshot)
      return found && found.ok ? found.margin : null
    }
    const [mb, ma] = [await margin(before), await margin(after)]
    expect(moved.fx_margin).toEqual({ before: mb, after: ma, change: Math.round(((ma ?? 0) - (mb ?? 0)) * 1000) / 1000, problem: null })
    expect(moved.moved).toBe(true)
  })

  it('comes with the status, every balance after and the basis, around the tool’s own answer', async () => {
    const before = household()
    const after = household((doc) => doc.transactions.push({ id: 'shoes', account_id: 'main', posted_on: AS_OF, amount_minor: -50000, kind: 'expense', description: 'Shoes' }))
    const worlds = [before, after]
    const deps: ServerDeps = { world: async () => worlds.shift() ?? after, send: async () => ok({ status: 'applied', batch_id: BATCH, inserted: 1 }) }
    const out = (await written(deps, postTransactions, { batch_id: BATCH, rows: [{ account_id: MAIN, posted_on: AS_OF, amount: '-500', kind: 'expense', description: 'Shoes' }] })) as Record<string, unknown> & { balances_after: { account_id: string; balance: unknown }[] }
    expect(Object.keys(out)).toEqual(['status', 'batch_id', 'inserted', 'row_ids', 'balances_after', 'changes', 'basis', 'link'])
    expect(out.balances_after.find((b) => b.account_id === MAIN)?.balance).toEqual(amount(595000, 'EUR'))
    expect(out.changes).toEqual(await deltas(before, after))
    expect(typedOutside(out, typedText(after.snapshot))).toEqual([])
  })
})

describe('a write whose second read fails', () => {
  it('still answers with what it saved, and says to read the household again', async () => {
    const before = household()
    let reads = 0
    const deps: ServerDeps = {
      world: async () => {
        if (reads++ > 0) throw new AgentError('export_household failed: connection reset')
        return before
      },
      send: async () => ok({ status: 'applied', batch_id: BATCH, inserted: 1 }),
    }
    const out = await written(deps, postTransactions, { batch_id: BATCH, rows: [FOOD] })
    expect(out).toEqual({
      status: 'applied',
      batch_id: BATCH,
      inserted: 1,
      row_ids: [rowId(BATCH, 0)],
      balances_after: null,
      changes: null,
      problem: 'Saved, but reading the household again failed: export_household failed: connection reset. Call get_overview to see it.',
      link: `http://localhost:8090/money/${MAIN}?month=2026-10`,
    })
  })
})

describe('a write the tool refuses in plain words', () => {
  it('answers JSON all the same, so every refusal reads one way, while a household it could not read stays a plain failure', async () => {
    const deps: ServerDeps = { world: async () => household(), send: async () => ok(null) }
    const refused = await written(deps, { ...postTransactions, run: async () => Promise.reject(new AgentError('The agent has no session for this write; call again to sign in.')) }, {}).catch((e: unknown) => e)
    expect([refused instanceof Refusal, refusalOf(refused)]).toEqual([true, { error: 'refused', message: 'The agent has no session for this write; call again to sign in.' }])
    const unread: ServerDeps = { world: async () => Promise.reject(new AgentError('export_household failed: connection reset')), send: async () => ok(null) }
    expect(messageOf(await written(unread, postTransactions, {}).catch((e: unknown) => e))).toBe('export_household failed: connection reset')
  })
})

describe('compare', () => {
  it('gives core’s rows for the baseline, each patch and all together, and the web app’s link to the same comparison', async () => {
    const world = worldAt(abroad, AS_OF)
    const patches = [
      { label: 'Rent up 50', patch: { items: { rent: { amount_minor: 95000, from_month: '2026-11' } } } },
      { label: 'Euro 10% weaker', patch: { fx_shift_pct: -0.1 } },
    ]
    const out = (await compareTool.run(world, { patches })) as { rows: { role: string; ok: boolean; delta_days_under_floor?: number; lowest_by_account?: { delta: { amount_minor: number } }[]; data_text: { label: string } }[]; link: string }
    const reference: CompareResult[] = []
    for await (const row of compare(world.snapshot, patches, { pause: () => Promise.resolve() })) reference.push(row)
    expect(out.rows.map((r) => [r.role, r.ok, r.data_text.label])).toEqual(reference.map((r) => [r.role, r.ok, r.label]))
    expect(out.rows.map((r) => [r.delta_days_under_floor, r.lowest_by_account?.map((l) => l.delta.amount_minor)])).toEqual(reference.map((r) => (r.ok ? [r.delta_days_under_floor, r.lowest_by_account.map((l) => l.delta_minor)] : [undefined, undefined])))
    expect(out.link).toBe(`http://localhost:8090/plan/compare#l=${encodeLevers(patches)}`)
    expect(typedOutside(out, typedText(world.snapshot))).toEqual([])
  })

  it('reports a patch core refuses as a failed row, beside the others', async () => {
    const out = (await compareTool.run(worldAt(abroad, AS_OF), { patches: [{ label: 'Gone', patch: { items: { gone: { removed: true } } } }] })) as { rows: { ok: boolean; errors?: string[] }[] }
    expect(out.rows.map((r) => r.ok)).toEqual([true, false])
    expect(out.rows[1]?.errors?.join(' ')).toContain('gone')
  })
})
