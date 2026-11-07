// Where the last post_batch wrote, so the ledger it returns to can show the saved row's month (invariant 191).
export interface LastSave {
  // Counts saves since the app started; a ledger compares it with the count it last saw.
  seq: number
  rows: readonly { account_id: string; posted_on: string }[]
}

let last: LastSave = { seq: 0, rows: [] }

export function noteSave(rows: readonly { account_id: string; posted_on: string }[]): void {
  last = { seq: last.seq + 1, rows: rows.map((r) => ({ account_id: r.account_id, posted_on: r.posted_on })) }
}

export function lastSave(): LastSave {
  return last
}
