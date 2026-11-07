import { z } from 'zod'
import { flagDuplicateIds, minorUnits, strictKeys, uuid } from './common'
import { batchTransactionRow } from './rows'

const balances = z.record(uuid, minorUnits)

// Expected balances are the bank's figure per account: opening plus every row to today.
export const postBatchInput = strictKeys({
  batch_id: uuid,
  allow_over: z.boolean().optional(),
  expect_before: balances.optional(),
  expect_after: balances.optional(),
  rows: z.array(batchTransactionRow).min(1, 'must hold at least one row'),
}).superRefine((batch, ctx) => flagDuplicateIds(batch.rows, 'rows', ctx))

export type PostBatchInput = z.output<typeof postBatchInput>
