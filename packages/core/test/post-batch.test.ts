import { describe, expect, it } from 'vitest'
import { checkInput } from '../src/schema/common'
import { postBatchInput } from '../src/schema/post-batch'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const out = { id: id(1), account_id: id(10), posted_on: '2026-10-05', amount_minor: -150000, kind: 'transfer', transfer_id: id(20), plan_item_id: id(30), period: '2026-10-01' }
const into = { id: id(2), account_id: id(11), posted_on: '2026-10-05', amount_minor: 10500000, kind: 'transfer', transfer_id: id(20) }
const batch = { batch_id: id(99), rows: [out, into] }

describe('postBatchInput', () => {
  it('takes a batch id, rows and the optional expected balances and allow_over', () => {
    const parsed = postBatchInput.parse({ ...batch, allow_over: true, expect_before: { [id(10)]: 1000000 }, expect_after: { [id(10)]: 850000 } })
    expect(parsed.rows.map((r) => r.id)).toEqual([id(1), id(2)])
    expect(parsed.allow_over).toBe(true)
    expect('allow_over' in postBatchInput.parse(batch)).toBe(false)
  })

  it('needs uuids, at least one row, and leaves batch_id to the batch', () => {
    expect(checkInput(postBatchInput, { batch_id: 'b1', rows: [] })).toEqual({ ok: false, errors: ['batch_id: must be a uuid', 'rows: must hold at least one row'] })
    expect(checkInput(postBatchInput, { ...batch, rows: [{ ...out, account_id: 'checking', batch_id: id(99) }] })).toEqual({
      ok: false,
      errors: [
        'rows[0].account_id: must be a uuid',
        "rows[0]: Unknown key 'batch_id'; allowed keys: id, account_id, posted_on, amount_minor, kind, category_id, description, transfer_id, plan_item_id, period, external_id",
      ],
    })
  })

  it('checks every row like a transaction row and refuses one id twice', () => {
    expect(checkInput(postBatchInput, { ...batch, rows: [out, { ...into, id: id(1), kind: 'income' }] })).toEqual({
      ok: false,
      errors: ['rows[1].transfer_id: only a transfer has a transfer_id', `rows[1].id: duplicate id '${id(1)}'`],
    })
    expect(checkInput(postBatchInput, { ...batch, expect_after: { [id(10)]: 1.5 } })).toEqual({ ok: false, errors: [`expect_after.${id(10)}: must be a whole number of minor units`] })
  })
})
