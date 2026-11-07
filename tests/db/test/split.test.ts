import { buildSnapshot, occurrenceId, occurrencesOf, validateLink, type ImportDocInput } from '@waypoint/core'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { waypointClient, type Db } from './client'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-07'

// A monthly bill linked June to August with September skipped, and a weekly bill linked on three Thursdays.
const DOC: ImportDocInput = {
  version: 1,
  household: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es-ES', track_from: '2026-01-01' },
  accounts: [{ id: 'main', name: 'Current', kind: 'cash', currency: 'EUR', opening_balance_minor: 500000, opening_date: '2026-01-01' }],
  plan_items: [
    { id: 'phone', kind: 'bill', name: 'Phone', from_account_id: 'main', amount_minor: 4000, every: 'month', starts_on: '2026-01-20', skip_periods: ['2026-09-01'] },
    { id: 'cleaner', kind: 'bill', name: 'Cleaner', from_account_id: 'main', amount_minor: 3000, every: 'week', starts_on: '2026-09-03' },
  ],
  transactions: [
    { id: 'phone-jun', account_id: 'main', posted_on: '2026-06-20', amount_minor: -4000, kind: 'expense', plan_item_id: 'phone', period: '2026-06-01' },
    { id: 'phone-jul', account_id: 'main', posted_on: '2026-07-20', amount_minor: -4000, kind: 'expense', plan_item_id: 'phone', period: '2026-07-01' },
    { id: 'phone-aug', account_id: 'main', posted_on: '2026-08-20', amount_minor: -4000, kind: 'expense', plan_item_id: 'phone', period: '2026-08-01' },
    { id: 'cleaner-1', account_id: 'main', posted_on: '2026-09-10', amount_minor: -3000, kind: 'expense', plan_item_id: 'cleaner', period: '2026-09-10' },
    { id: 'cleaner-2', account_id: 'main', posted_on: '2026-09-17', amount_minor: -3000, kind: 'expense', plan_item_id: 'cleaner', period: '2026-09-17' },
    { id: 'cleaner-3', account_id: 'main', posted_on: '2026-10-01', amount_minor: -3000, kind: 'expense', plan_item_id: 'cleaner', period: '2026-10-01' },
  ],
}

async function signUp(): Promise<Db> {
  const db = waypointClient(url!, key!)
  const { data, error } = await db.auth.signUp({ email: `split-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return db
}

async function call<T>(db: Db, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

describe.skipIf(!url || !key)('split_plan_item then export', () => {
  it('keeps each moved link on its occurrence: the first of the month for a monthly bill, the date for a weekly one', { timeout: 30_000 }, async () => {
    const db = await signUp()
    try {
      const { ids } = await call<{ ids: Record<'plan_items' | 'transactions', Record<string, string>> }>(db, 'import_household', { p_doc: DOC })
      const phone = await call<string>(db, 'split_plan_item', { p_id: ids.plan_items.phone, p_from: '2026-07-01', p_patch: { amount_minor: 4500 } })
      const cleaner = await call<string>(db, 'split_plan_item', { p_id: ids.plan_items.cleaner, p_from: '2026-09-15', p_patch: { amount_minor: 3500 } })

      const snapshot = buildSnapshot(await call<unknown>(db, 'export_household'), AS_OF, [])
      const accounts = snapshot.doc.accounts.map((a) => ({ id: a.id, kind: a.kind }))
      const items = new Map(snapshot.doc.plan_items.map((p) => [p.id, p]))
      expect([items.get(phone)?.starts_on, items.get(phone)?.skip_periods, items.get(cleaner)?.starts_on]).toEqual(['2026-07-20', ['2026-09-01'], '2026-09-17'])
      expect(items.get(ids.plan_items.phone!)?.ends_on).toBe('2026-06-30')

      const linkOf = (docId: string) => snapshot.doc.transactions.find((t) => t.id === ids.transactions[docId])!
      expect(DOC.transactions!.map((t) => [t.id, linkOf(t.id).plan_item_id, linkOf(t.id).period])).toEqual([
        ['phone-jun', ids.plan_items.phone, '2026-06-01'],
        ['phone-jul', phone, '2026-07-01'],
        ['phone-aug', phone, '2026-08-01'],
        ['cleaner-1', ids.plan_items.cleaner, '2026-09-10'],
        ['cleaner-2', cleaner, '2026-09-17'],
        ['cleaner-3', cleaner, '2026-10-01'],
      ])
      for (const t of snapshot.doc.transactions) expect(validateLink(t, null, items.get(t.plan_item_id!)!, accounts)).toEqual([])

      const occurrences = new Map(occurrencesOf(snapshot).map((o) => [o.id, o]))
      const settled = DOC.transactions!.map((t) => {
        const o = occurrences.get(occurrenceId(linkOf(t.id).plan_item_id!, linkOf(t.id).period!))
        return [t.id, o?.scheduled_on, o?.linked_minor]
      })
      expect(settled).toEqual([
        ['phone-jun', '2026-06-20', 4000],
        ['phone-jul', '2026-07-20', 4000],
        ['phone-aug', '2026-08-20', 4000],
        ['cleaner-1', '2026-09-10', 3000],
        ['cleaner-2', '2026-09-17', 3000],
        ['cleaner-3', '2026-10-01', 3000],
      ])
      expect(occurrences.get(occurrenceId(phone, '2026-09-01'))?.skipped).toBe(true)
    } finally {
      await db.rpc('delete_my_account')
    }
  })

  it('splits a quarterly bill inside a quarter at its next occurrence, and core settles each link and skip on it across the year end', { timeout: 30_000 }, async () => {
    const quarterly: ImportDocInput = {
      ...DOC,
      plan_items: [{ id: 'fee', kind: 'bill', name: 'Accountant', from_account_id: 'main', amount_minor: 45000, every: 'quarter', starts_on: '2026-01-15', skip_periods: ['2027-01-01'] }],
      transactions: ['2026-01', '2026-04', '2026-07'].map((m) => ({ id: `fee-${m}`, account_id: 'main', posted_on: `${m}-15`, amount_minor: -45000, kind: 'expense' as const, plan_item_id: 'fee', period: `${m}-01` })),
    }
    const db = await signUp()
    try {
      const { ids } = await call<{ ids: Record<'plan_items' | 'transactions', Record<string, string>> }>(db, 'import_household', { p_doc: quarterly })
      const copy = await call<string>(db, 'split_plan_item', { p_id: ids.plan_items.fee, p_from: '2026-05-01', p_patch: { amount_minor: 50000 } })

      const snapshot = buildSnapshot(await call<unknown>(db, 'export_household'), AS_OF, [])
      const items = new Map(snapshot.doc.plan_items.map((p) => [p.id, p]))
      expect([ids.plan_items.fee!, copy].map((id) => [items.get(id)?.every, items.get(id)?.starts_on, items.get(id)?.ends_on, items.get(id)?.amount_minor, items.get(id)?.skip_periods])).toEqual([
        ['quarter', '2026-01-15', '2026-04-30', 45000, []],
        ['quarter', '2026-07-15', null, 50000, ['2027-01-01']],
      ])
      const linkOf = (docId: string) => snapshot.doc.transactions.find((t) => t.id === ids.transactions[docId])!
      expect(['fee-2026-01', 'fee-2026-04', 'fee-2026-07'].map((t) => [linkOf(t).plan_item_id, linkOf(t).period])).toEqual([
        [ids.plan_items.fee, '2026-01-01'],
        [ids.plan_items.fee, '2026-04-01'],
        [copy, '2026-07-01'],
      ])

      const occurrences = occurrencesOf(snapshot).filter((o) => o.date <= '2027-04-30')
      // July's 450.00 link is short of the copy's 500.00, so the rest is overdue.
      expect(occurrences.map((o) => [o.id, o.scheduled_on, o.amount_minor, o.linked_minor, o.state])).toEqual([
        [occurrenceId(ids.plan_items.fee!, '2026-01-01'), '2026-01-15', 45000, 45000, 'settled'],
        [occurrenceId(ids.plan_items.fee!, '2026-04-01'), '2026-04-15', 45000, 45000, 'settled'],
        [occurrenceId(copy, '2026-07-01'), '2026-07-15', 50000, 45000, 'overdue'],
        [occurrenceId(copy, '2026-10-01'), '2026-10-15', 50000, 0, 'due'],
        [occurrenceId(copy, '2027-01-01'), '2027-01-15', 50000, 0, 'settled'],
        [occurrenceId(copy, '2027-04-01'), '2027-04-15', 50000, 0, 'due'],
      ])
      expect(occurrences.find((o) => o.period === '2027-01-01')?.skipped).toBe(true)
    } finally {
      await db.rpc('delete_my_account')
    }
  })
})
