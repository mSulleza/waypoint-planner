import { z } from 'zod'
import { flagDuplicateIds, strictKeys } from './common'
import { accountRow, categoryRow, householdRow, planItemRow, statementRow, transactionRow } from './rows'

// The import format's version; the app's saved snapshot key carries it, so a new format never reads an old copy.
export const SCHEMA_VERSION = 1

// One household with document-local ids; rates are not part of it, they come with each snapshot.
export const importDoc = strictKeys({
  version: z.literal(SCHEMA_VERSION, `must be ${SCHEMA_VERSION}`),
  household: householdRow,
  accounts: z.array(accountRow).default([]),
  categories: z.array(categoryRow).default([]),
  plan_items: z.array(planItemRow).default([]),
  statements: z.array(statementRow).default([]),
  transactions: z.array(transactionRow).default([]),
  // export_meals' rows, which core/meals checks; the snapshot never reads them.
  meals: z.record(z.string(), z.unknown()).optional(),
}).superRefine((doc, ctx) => {
  for (const table of ['accounts', 'categories', 'plan_items', 'statements', 'transactions'] as const) flagDuplicateIds(doc[table], table, ctx)
})

export type ImportDoc = z.output<typeof importDoc>
export type ImportDocInput = z.input<typeof importDoc>
