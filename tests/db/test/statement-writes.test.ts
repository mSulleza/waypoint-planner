import { buildSnapshot, runEngine, type Rate, type Snapshot, type Statement } from '@waypoint/core'
import { abroad, type SampleDoc } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sendEdit } from '../../../apps/app/src/data/edits'
import { createWaypointClient, type WaypointClient } from '../../../apps/app/src/data/supabase'
import { CHIPS, debtDetail } from '../../../apps/app/src/screens/debts/debts.model'
import { initialDraft, openingEdit, openStatement, readStatement, statementEdit, type StatementDraft } from '../../../apps/app/src/screens/statement/statement.model'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
// The day after the rewards card's 20 October cut, which has no statement entered yet.
const AS_OF = '2026-10-21'
const LOCALE = 'en-PH'

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, String(v)),
  }
}

interface User {
  client: WaypointClient
  // The household is the user: row-level security checks household_id against the signed-in id.
  id: string
}

async function signUp(): Promise<User> {
  const client = createWaypointClient(url!, key!, { storage: memoryStorage() })
  const { data, error } = await client.auth.signUp({ email: `statement-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { client, id: data.user.id }
}

async function snapshotOf(client: WaypointClient, rates: readonly Rate[]): Promise<Snapshot> {
  const { data, error } = await client.rpc('export_household')
  if (error) throw new Error(`export_household: ${error.message}`)
  return buildSnapshot(data, AS_OF, rates)
}

async function imported(edit?: (doc: SampleDoc) => void): Promise<{ user: User; card: string; rates: readonly Rate[] }> {
  const { doc, rates } = abroad(AS_OF)
  edit?.(doc)
  const user = await signUp()
  const { data, error } = await user.client.rpc('import_household', { p_doc: doc })
  if (error) throw new Error(`import_household: ${error.message}`)
  return { user, card: (data as { ids: { accounts: Record<string, string> } }).ids.accounts['rewards-card']!, rates }
}

// The 20 October statement as printed: 70,000.00 − 25,000.00 + 2,000.00 + 5,000.00 + 1,555.00 + 0 = 53,555.00.
const PRINTED = { previous: '70,000.00', payments: '25,000.00', charges: '2,000.00', installments: '5,000.00', interest: '1,555.00', fees: '0', total: '53,555.00', minimum: '1,606.65' }

function rowOf(snapshot: Snapshot, card: string, patch: Partial<StatementDraft>, id: string, editing: Statement | null = null): Statement {
  const opened = openStatement(snapshot, card, editing?.id)
  if (opened.kind !== 'ready') throw new Error(`cannot open ${card}`)
  const draft = { ...initialDraft(snapshot, opened.card, editing, LOCALE), ...patch }
  const read = readStatement(snapshot, opened.card, draft, { id, locale: LOCALE })
  if (!read.row) throw new Error(`not saved: ${JSON.stringify([read.errors, read.missing, read.check, read.duplicate?.id])}`)
  return read.row
}

// By cut date; the document keeps them in id order.
const statementsOf = (snapshot: Snapshot, card: string) => snapshot.doc.statements.filter((s) => s.account_id === card).sort((a, b) => (a.cut_date < b.cut_date ? -1 : 1))

function latest(snapshot: Snapshot, card: string) {
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error('the engine did not run')
  const detail = debtDetail(snapshot, run.walk, card)
  if (detail?.kind !== 'credit_card') throw new Error('no card detail')
  return detail.statement
}

describe.skipIf(!url || !key)('statements through the REST API', () => {
  it('saves a statement that balances, which re-anchors the card at once, and a retry from the same sheet adds nothing', { timeout: 60_000 }, async () => {
    const { user, card, rates } = await imported()
    const before = await snapshotOf(user.client, rates)
    expect(latest(before, card)).toMatchObject({ chip: CHIPS.provisional, cut_date: '2026-10-20' })

    const row = rowOf(before, card, PRINTED, randomUUID())
    const edit = statementEdit(row, user.id, null)
    await sendEdit(user.client, edit)
    await sendEdit(user.client, edit)
    const after = await snapshotOf(user.client, rates)
    expect(statementsOf(after, card).map((s) => [s.cut_date, s.total_due_minor])).toEqual([
      ['2026-09-20', 7000000],
      ['2026-10-20', 5355500],
    ])
    expect(after.doc.statements.find((s) => s.id === row.id)).toEqual(row)
    expect(latest(after, card)).toMatchObject({ id: row.id, chip: CHIPS.checked, provisional: false, total_minor: 5355500, minimum_minor: 160665, remaining_minor: 5355500 })
  })

  it('takes the statement a card added today already holds: the opening moves back to its cut, then the statement saves', { timeout: 60_000 }, async () => {
    // The rewards card as set-up writes one today: no rows, no statement, cutting on the 25th.
    const { user, card, rates } = await imported((doc) => {
      const c = doc.accounts.find((a) => a.id === 'rewards-card')
      if (!c || c.kind !== 'credit_card') throw new Error('no rewards card')
      c.opening_date = AS_OF
      c.terms = { ...c.terms, cut_day: 25 }
      doc.statements = doc.statements.filter((t) => t.account_id !== 'rewards-card')
      const legs = new Set(doc.transactions.filter((t) => t.account_id === 'rewards-card').map((t) => t.transfer_id))
      doc.transactions = doc.transactions.filter((t) => t.account_id !== 'rewards-card' && !(t.transfer_id !== null && legs.has(t.transfer_id)))
      doc.plan_items = doc.plan_items.filter((i) => i.from_account_id !== 'rewards-card' && i.to_account_id !== 'rewards-card')
    })
    const before = await snapshotOf(user.client, rates)
    const opened = openStatement(before, card, undefined)
    if (opened.kind !== 'ready') throw new Error('not opened')
    const read = readStatement(before, opened.card, { ...initialDraft(before, opened.card, null, LOCALE), total_only: true, total: '85,000.00', minimum: '2,975.00' }, { id: randomUUID(), locale: LOCALE })
    expect([read.opening, read.row?.cut_date]).toEqual(['2026-09-25', '2026-09-25'])
    if (!read.row || !read.opening) throw new Error('not readable')
    await sendEdit(user.client, openingEdit(opened.card, read.opening))
    await sendEdit(user.client, statementEdit(read.row, user.id, null))
    const after = await snapshotOf(user.client, rates)
    expect(after.doc.accounts.find((a) => a.id === card)?.opening_date).toBe('2026-09-25')
    expect(statementsOf(after, card).map((t) => [t.cut_date, t.total_due_minor, t.minimum_due_minor])).toEqual([['2026-09-25', 8500000, 297500]])
    expect(latest(after, card)).toMatchObject({ id: read.row.id, chip: CHIPS.total_only, provisional: false, total_minor: 8500000, minimum_minor: 297500 })
  })

  it('refuses a second statement for the same cut, which the sheet then offers to edit', { timeout: 60_000 }, async () => {
    const { user, card, rates } = await imported()
    const first = rowOf(await snapshotOf(user.client, rates), card, PRINTED, randomUUID())
    // Two devices enter the same statement: the second insert is refused by the cut date, not added.
    const second = rowOf(await snapshotOf(user.client, rates), card, { ...PRINTED, minimum: '1,600.00' }, randomUUID())
    await sendEdit(user.client, statementEdit(first, user.id, null))
    await expect(sendEdit(user.client, statementEdit(second, user.id, null))).rejects.toMatchObject({ kind: 'rejected', code: 'statement_exists', message: 'A statement for this date exists.' })
    const reloaded = await snapshotOf(user.client, rates)
    expect(statementsOf(reloaded, card).filter((s) => s.cut_date === '2026-10-20').map((s) => s.id)).toEqual([first.id])
    const opened = openStatement(reloaded, card, undefined)
    if (opened.kind !== 'ready') throw new Error('not opened')
    const read = readStatement(reloaded, opened.card, { ...initialDraft(reloaded, opened.card, null, LOCALE), ...PRINTED }, { id: second.id, locale: LOCALE })
    expect([read.duplicate?.id, read.row]).toEqual([first.id, null])
  })

  it('edits a saved statement only while it holds what was loaded, and turns it into Total only', { timeout: 60_000 }, async () => {
    const { user, card, rates } = await imported()
    const row = rowOf(await snapshotOf(user.client, rates), card, PRINTED, randomUUID())
    await sendEdit(user.client, statementEdit(row, user.id, null))
    const loaded = (await snapshotOf(user.client, rates)).doc.statements.find((s) => s.id === row.id)!

    // This device fixes the minimum; another device, still on the loaded copy, is refused and writes nothing.
    const fixed = rowOf(await snapshotOf(user.client, rates), card, { minimum: '1,700.00' }, row.id, loaded)
    await sendEdit(user.client, statementEdit(fixed, user.id, loaded))
    const elsewhere = rowOf(await snapshotOf(user.client, rates), card, { minimum: '1,800.00' }, row.id, loaded)
    await expect(sendEdit(user.client, statementEdit(elsewhere, user.id, loaded))).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
    const now = (await snapshotOf(user.client, rates)).doc.statements.find((s) => s.id === row.id)!
    expect(now.minimum_due_minor).toBe(170000)

    const totalOnly = rowOf(await snapshotOf(user.client, rates), card, { total_only: true, total: '53,000.00', minimum: '1,590.00' }, row.id, now)
    await sendEdit(user.client, statementEdit(totalOnly, user.id, now))
    const saved = await snapshotOf(user.client, rates)
    expect(saved.doc.statements.find((s) => s.id === row.id)).toEqual({ ...row, previous_balance_minor: null, payments_and_credits_minor: null, charges_minor: null, installments_minor: null, interest_minor: null, fees_minor: null, total_due_minor: 5300000, minimum_due_minor: 159000 })
    expect(latest(saved, card)).toMatchObject({ chip: CHIPS.total_only, remaining_minor: 5300000 })
  })

  it('keeps households apart, and the table refuses a statement that does not balance', { timeout: 60_000 }, async () => {
    const { user, card, rates } = await imported()
    const other = await signUp()
    const row = rowOf(await snapshotOf(user.client, rates), card, PRINTED, randomUUID())
    // Another household cannot put a statement on this card, nor edit one on it.
    await expect(sendEdit(other.client, statementEdit(row, other.id, null))).rejects.toMatchObject({ kind: expect.stringMatching(/not_allowed|rejected/) })
    await sendEdit(user.client, statementEdit(row, user.id, null))
    await expect(sendEdit(other.client, statementEdit({ ...row, minimum_due_minor: 0 }, other.id, row))).rejects.toMatchObject({ code: 'stale' })

    const unbalanced = { ...row, id: randomUUID(), cut_date: '2026-10-19', total_due_minor: row.total_due_minor + 1 }
    await expect(sendEdit(user.client, { kind: 'add_statement', row: { ...unbalanced, household_id: user.id } })).rejects.toMatchObject({ kind: 'rejected', code: '23514' })
    expect(statementsOf(await snapshotOf(user.client, rates), card).map((s) => s.id)).toContain(row.id)
    expect(statementsOf(await snapshotOf(user.client, rates), card).map((s) => s.id)).not.toContain(unbalanced.id)
  })
})
