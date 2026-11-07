import { buildSnapshot, runEngine, type ImportDocInput } from '@waypoint/core'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { initialDraft, readDraft, type Draft } from '../../../apps/app/src/screens/onboarding/onboarding.model'
import { waypointClient, type Db } from './client'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
// Day 8 of the month in Madrid, so a card due on the 25th is paid this month.
const NOW = new Date('2026-10-08T10:00:00Z')
const TODAY = '2026-10-08'

const ANSWERS: Draft = { ...initialDraft('en-IE', 'Europe/Madrid'), balance: '2400', floor: '500', income: '3200', payday_day: '28', living: '1900', debt: 'card', owed: '850', cut_day: '3', due_day: '25', pays: 'full' }

function onboardingDoc(answers: Draft = ANSWERS): ImportDocInput {
  const reading = readDraft(answers, 'en-IE', NOW)
  if (!reading.doc) throw new Error(`onboarding answers did not read: ${JSON.stringify(reading.errors)}`)
  return reading.doc
}

async function signUp(): Promise<Db> {
  const db = waypointClient(url!, key!)
  const { data, error } = await db.auth.signUp({ email: `onboarding-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return db
}

describe.skipIf(!url || !key)('onboarding', () => {
  it('writes one household whose first projection pays the card from the main account on its due day', { timeout: 30_000 }, async () => {
    const db = await signUp()
    try {
      const doc = onboardingDoc()
      const imported = await db.rpc('import_household', { p_doc: doc })
      expect(imported.error).toBeNull()
      const exported = await db.rpc('export_household')
      expect(exported.error).toBeNull()
      const snapshot = buildSnapshot(exported.data, TODAY, [])
      expect([snapshot.doc.accounts.length, snapshot.doc.categories.length, snapshot.doc.plan_items.length, snapshot.doc.transactions.length]).toEqual([2, 1, 2, 0])
      expect(snapshot.doc.household.track_from).toBe(TODAY)
      const main = snapshot.doc.accounts.find((a) => a.kind === 'cash')
      const card = snapshot.doc.accounts.find((a) => a.kind === 'credit_card')
      expect(main?.floor_windows).toEqual([{ from_month: '2026-10', to_month: null, amount_minor: 50000 }])
      const run = runEngine(snapshot)
      if (!run.ok) throw new Error('walk failed')
      expect(run.walk.lines.find((l) => l.id === `payment:${card?.id}:${TODAY}#out`)).toMatchObject({ account_id: main?.id, date: '2026-10-25', amount_minor: -85000 })
      // The account already has its household, so a second import changes nothing.
      const again = await db.rpc('import_household', { p_doc: doc })
      expect(again.error?.message).toMatch(/^household_not_empty: /)
      expect((await db.rpc('export_household')).data).toEqual(exported.data)
    } finally {
      await db.rpc('delete_my_account')
    }
  })

  it('writes a set extra on the card as a transfer item into it, which the database routes from the card’s paying account', { timeout: 30_000 }, async () => {
    const db = await signUp()
    try {
      const imported = await db.rpc('import_household', { p_doc: onboardingDoc({ ...ANSWERS, pays: 'extra', extra: '100' }) })
      expect(imported.error).toBeNull()
      const snapshot = buildSnapshot((await db.rpc('export_household')).data, TODAY, [])
      const card = snapshot.doc.accounts.find((a) => a.kind === 'credit_card')
      expect(card?.kind === 'credit_card' && card.terms.pay.mode).toBe('minimum')
      expect(snapshot.doc.plan_items.filter((p) => p.kind === 'transfer').map((p) => [p.name, p.from_account_id, p.to_account_id === card?.id, p.amount_minor, p.every, p.starts_on])).toEqual([['Extra card payment', null, true, 10000, 'month', TODAY]])
      const run = runEngine(snapshot)
      if (!run.ok) throw new Error('walk failed')
      // The opening balance is October's statement, so its payment on the 25th is the minimum and the extra together.
      const october = run.walk.lines.find((l) => l.id === `payment:${card?.id}:${TODAY}#out`)
      expect(october).toMatchObject({ account_id: snapshot.doc.accounts.find((a) => a.kind === 'cash')?.id, date: '2026-10-25' })
      expect(october?.amount_minor).toBeLessThan(-10000)
    } finally {
      await db.rpc('delete_my_account')
    }
  })

  it('leaves no household behind when the import fails after its first rows went in', { timeout: 30_000 }, async () => {
    const db = await signUp()
    try {
      const doc = onboardingDoc()
      // Accounts and the category are inserted before plan items, so this row fails mid-import.
      const broken = { ...doc, plan_items: doc.plan_items?.map((p) => (p.kind === 'income' ? { ...p, amount_minor: 0 } : p)) }
      const failed = await db.rpc('import_household', { p_doc: broken })
      expect([failed.error?.code, failed.error?.message]).toEqual(['23514', 'new row for relation "plan_items" violates check constraint "plan_items_amount_check"'])
      expect((await db.rpc('export_household')).data).toBeNull()
      const retried = await db.rpc('import_household', { p_doc: doc })
      expect(retried.error).toBeNull()
      expect((await db.rpc('export_household')).data).toMatchObject({ household: { track_from: TODAY } })
    } finally {
      await db.rpc('delete_my_account')
    }
  })
})
