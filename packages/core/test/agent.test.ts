import { describe, expect, it } from 'vitest'
import {
  addStatementInput,
  compareInput,
  decimalMinor,
  deleteTransactionsInput,
  getDebtInput,
  getLedgerInput,
  getOverviewInput,
  listOpenInput,
  listPlanInput,
  postTransactionsInput,
  setLinkInput,
  upsertPlanItemInput,
} from '../src/agent'
import { checkInput } from '../src/schema/common'

const BATCH = '0000000a-0007-4000-9000-000000000001'
const MAIN = '0000000a-0001-4000-9000-000000000001'
const ITEM = '0000000a-0003-4000-9000-000000000001'

describe('the agent’s read tool inputs', () => {
  it('take an account and an optional month for the ledger', () => {
    expect(checkInput(getLedgerInput, { account_id: 'main' })).toEqual({ ok: true, value: { account_id: 'main' } })
    expect(checkInput(getLedgerInput, { account_id: 'main', month: '2026-10' })).toEqual({ ok: true, value: { account_id: 'main', month: '2026-10' } })
    expect(checkInput(getLedgerInput, { account_id: '', month: '2026-13' })).toEqual({ ok: false, errors: ['account_id: must be a non-empty id', 'month: must be a YYYY-MM month'] })
  })

  it('refuse an unknown key by name, so a typo never reads as a different question', () => {
    expect(checkInput(getOverviewInput, { as_of: '2026-10-07' })).toEqual({ ok: false, errors: ["(root): Unknown key 'as_of'; it takes no keys"] })
    expect(checkInput(getDebtInput, { account: 'card' })).toEqual({ ok: false, errors: ['account_id: Invalid input: expected string, received undefined', "(root): Unknown key 'account'; allowed keys: account_id"] })
    expect(checkInput(listOpenInput, { through: '2026-11' })).toEqual({ ok: false, errors: ["(root): Unknown key 'through'; allowed keys: through_month"] })
  })

  it('take the optional month and flag of the open and plan lists', () => {
    expect(checkInput(listOpenInput, {})).toEqual({ ok: true, value: {} })
    expect(checkInput(listOpenInput, { through_month: '2026-11' })).toEqual({ ok: true, value: { through_month: '2026-11' } })
    expect(checkInput(listPlanInput, { include_ended: 'yes' })).toEqual({ ok: false, errors: ['include_ended: Invalid input: expected boolean, received string'] })
  })
})

describe('decimal text', () => {
  it('reads once into whole minor units of the account’s currency, with no float drift', () => {
    expect(decimalMinor('-12.40', 'EUR')).toBe(-1240)
    expect(decimalMinor('0.1', 'EUR')).toBe(10)
    expect(decimalMinor('1200', 'PHP')).toBe(120000)
    expect(decimalMinor('19.99', 'EUR')).toBe(1999)
    expect(decimalMinor('1234', 'JPY')).toBe(1234)
    expect(decimalMinor('1.234', 'BHD')).toBe(1234)
    expect(decimalMinor('-0.00', 'EUR')).toBe(0)
    expect(decimalMinor('12.400', 'EUR')).toBe(1240)
  })

  it('refuses more decimals than the currency takes, grouping, signs and amounts beyond a safe integer', () => {
    expect(decimalMinor('12.345', 'EUR')).toBeNull()
    expect(decimalMinor('100.5', 'JPY')).toBeNull()
    expect(decimalMinor('1,200.00', 'EUR')).toBeNull()
    expect(decimalMinor('+5', 'EUR')).toBeNull()
    expect(decimalMinor('€5', 'EUR')).toBeNull()
    expect(decimalMinor('.5', 'EUR')).toBeNull()
    expect(decimalMinor('90071992547409.92', 'EUR')).toBeNull()
  })
})

describe('the agent’s write tool inputs', () => {
  it('take post_batch’s batch with decimal text for amounts and expected balances, and ids left out', () => {
    const batch = { batch_id: BATCH, rows: [{ account_id: MAIN, posted_on: '2026-10-07', amount: '-23.40', kind: 'expense' }], expect_before: { [MAIN]: '6450.00' } }
    expect(checkInput(postTransactionsInput, batch)).toEqual({ ok: true, value: batch })
    expect(checkInput(postTransactionsInput, { ...batch, rows: [{ ...batch.rows[0], amount: -23.4, amount_minor: -2340 }] })).toEqual({
      ok: false,
      errors: ['rows[0].amount: Invalid input: expected string, received number', "rows[0]: Unknown key 'amount_minor'; allowed keys: id, account_id, posted_on, amount, kind, category_id, description, transfer_id, plan_item_id, period, external_id"],
    })
    expect(checkInput(postTransactionsInput, { ...batch, expect_after: { main: '1,000' } })).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('expect_after')]) })
  })

  it('delete by row ids or by a batch, never both', () => {
    expect(checkInput(deleteTransactionsInput, { batch_id: BATCH })).toEqual({ ok: true, value: { batch_id: BATCH } })
    expect(checkInput(deleteTransactionsInput, { ids: [MAIN] })).toEqual({ ok: true, value: { ids: [MAIN] } })
    expect(checkInput(deleteTransactionsInput, { ids: [MAIN], batch_id: BATCH })).toEqual({ ok: false, errors: ['(root): give ids or batch_id, one of the two'] })
    expect(checkInput(deleteTransactionsInput, {})).toEqual({ ok: false, errors: ['(root): give ids or batch_id, one of the two'] })
  })

  it('link and skip name what each action needs and refuse what it does not take', () => {
    expect(checkInput(setLinkInput, { action: 'skip', plan_item_id: ITEM, period: '2026-10-01' })).toMatchObject({ ok: true })
    expect(checkInput(setLinkInput, { action: 'link', row_id: MAIN })).toEqual({ ok: false, errors: ['plan_item_id: link needs plan_item_id', 'period: link needs period'] })
    expect(checkInput(setLinkInput, { action: 'unlink', row_id: MAIN, period: '2026-10-01' })).toEqual({ ok: false, errors: ['period: unlink takes no period'] })
  })

  it('take every repeat the plan items table takes, every 3 months included', () => {
    const fee = { kind: 'bill', name: 'Accountant', from_account_id: MAIN, amount: '4500.00', every: 'quarter', starts_on: '2026-10-15' }
    expect(checkInput(upsertPlanItemInput, fee)).toEqual({ ok: true, value: fee })
    expect(checkInput(upsertPlanItemInput, { ...fee, every: 'quarterly' })).toEqual({ ok: false, errors: ['every: Invalid option: expected one of "once"|"week"|"2weeks"|"month"|"quarter"|"year"'] })
  })

  it('change a plan item from a month only with its id, keeping its kind and first date', () => {
    expect(checkInput(upsertPlanItemInput, { id: ITEM, amount: '950.00', change_from: '2026-11' })).toMatchObject({ ok: true })
    expect(checkInput(upsertPlanItemInput, { kind: 'bill', starts_on: '2026-11-01', change_from: '2026-11' })).toEqual({
      ok: false,
      errors: ['id: change_from changes an item already in the plan; add its id', 'kind: change_from keeps the kind', 'starts_on: change_from keeps the first date; give day to move the day from that month'],
    })
    expect(checkInput(upsertPlanItemInput, { id: ITEM, day: 20 })).toEqual({ ok: false, errors: ['day: day moves an item from a month on; add change_from, or change starts_on'] })
  })

  it('take a statement’s printed figures as decimal text', () => {
    const statement = { account_id: MAIN, cut_date: '2026-10-20', due_date: '2026-11-16', total_due: '2000.00', minimum_due: '200.00', installments: '0' }
    expect(checkInput(addStatementInput, statement)).toEqual({ ok: true, value: statement })
    expect(checkInput(addStatementInput, { ...statement, total_due_minor: 200000 })).toMatchObject({ ok: false, errors: [expect.stringContaining("Unknown key 'total_due_minor'")] })
  })

  it('compare takes core patches with their labels, at most as many as a link holds', () => {
    expect(checkInput(compareInput, { patches: [{ label: 'Peso 10% weaker', patch: { fx_shift_pct: -0.1 } }] })).toMatchObject({ ok: true })
    expect(checkInput(compareInput, { patches: [] })).toEqual({ ok: false, errors: ['patches: must hold at least one patch'] })
    expect(checkInput(compareInput, { patches: Array.from({ length: 21 }, (_, i) => ({ label: `Option ${i}`, patch: {} })) })).toEqual({ ok: false, errors: ['patches: must hold at most 20 patches, as a Compare link does'] })
    expect(checkInput(compareInput, { patches: [{ label: 'Typo', patch: { fx_shift: -0.1 } }] })).toMatchObject({ ok: false, errors: [expect.stringContaining("Unknown key 'fx_shift'")] })
  })
})
