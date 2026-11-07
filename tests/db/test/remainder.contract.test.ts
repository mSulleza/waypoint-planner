import { buildSnapshot, cardsOf, debtFigures, runEngine, type CardAccount, type Snapshot, type Walk } from '@waypoint/core'
import { abroad, conversionClears, markSize, missedCut, revolvingDaily, usCardsCar, type Sample } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { waypointClient, type Db } from './client'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const AS_OF = '2026-10-07'

// Every fixture with a card: the samples, the large household and the statement shapes, one of which (missedCut) sits in a provisional cycle.
const FIXTURES: { id: string; build: (asOf: string) => Sample }[] = [
  { id: 'abroad', build: abroad },
  { id: 'us-cards-car', build: usCardsCar },
  { id: 'mark-size', build: markSize },
  { id: 'revolving-daily', build: revolvingDaily },
  { id: 'conversion-clears', build: conversionClears },
  { id: 'missed-cut', build: missedCut },
]

interface OverRemainder {
  error: string
  id: string
  account_id: string
  amount_minor: number
  remaining_minor: number
  cut_date: string | null
}

async function signUp(): Promise<Db> {
  const db = waypointClient(url!, key!)
  const { data, error } = await db.auth.signUp({ email: `remainder-${randomUUID()}@example.test`, password: randomUUID() })
  if (error || !data.session) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return db
}

async function call<T>(db: Db, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

// The Add sheet's card payment, both legs posted on as_of: the outgoing leg from the funded-from account, the card leg of `amount`.
function payment(card: CardAccount, amount: number, allowOver: boolean) {
  const transfer = randomUUID()
  const leg = (account_id: string, amount_minor: number) => ({ id: randomUUID(), account_id, posted_on: AS_OF, amount_minor, kind: 'transfer', category_id: null, description: 'Contract check', transfer_id: transfer, plan_item_id: null, period: null, external_id: null })
  return { batch_id: randomUUID(), allow_over: allowOver, rows: [leg(card.funded_from_account_id, -amount), leg(card.id, amount)] }
}

// post_batch's threshold for one card: a payment one unit above the given amount comes back as over_remainder with the remaining it measured.
async function threshold(db: Db, card: CardAccount, above: number): Promise<OverRemainder> {
  const { error } = await db.rpc('post_batch', { p_batch: payment(card, Math.max(1, above + 1), false) })
  if (!error) throw new Error(`post_batch accepted a payment above ${above} into ${card.name}`)
  expect(error.message.startsWith('over_remainder:'), error.message).toBe(true)
  return JSON.parse(error.details ?? '{}') as OverRemainder
}

function engine(snapshot: Snapshot): Walk {
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  return run.walk
}

describe.skipIf(!url || !key)('post_batch over_remainder against core', () => {
  it.each(FIXTURES)('$id: refuses a card payment exactly above core’s remaining due outside a provisional cycle, and accepts that amount', { timeout: 60_000 }, async ({ id, build }) => {
    const sample = build(AS_OF)
    const db = await signUp()
    try {
      await call(db, 'import_household', { p_doc: sample.doc })
      const snapshot = buildSnapshot(await call<unknown>(db, 'export_household'), AS_OF, sample.rates)
      const walk = engine(snapshot)
      const replays = cardsOf(walk)
      const cards = snapshot.doc.accounts.filter((a): a is CardAccount => a.kind === 'credit_card')
      expect(cards.length).toBeGreaterThan(0)
      let compared = 0
      for (const figures of debtFigures(snapshot, walk).cards) {
        const card = cards.find((c) => c.id === figures.account_id)!
        const replay = replays?.get(card.id)
        const current = replay?.statements.find((s) => s.id === replay.current_id)
        if (!current || current.provisional) continue
        const measured = await threshold(db, card, figures.remaining_due_minor)
        expect([card.name, measured.remaining_minor], `${id}: ${card.name}`).toEqual([card.name, figures.remaining_due_minor])
        expect(measured.cut_date).toBe(current.source === 'opening' ? null : current.cut_date)
        // The threshold is inclusive: exactly the remaining due goes through without allow_over.
        if (figures.remaining_due_minor > 0) {
          const saved = await call<{ status: string; inserted: number }>(db, 'post_batch', { p_batch: payment(card, figures.remaining_due_minor, false) })
          expect(saved).toMatchObject({ status: 'applied', inserted: 2 })
        }
        compared++
      }
      expect(compared).toBe(id === 'missed-cut' ? 0 : cards.length)
    } finally {
      await db.rpc('delete_my_account')
    }
  })

  it('measures from the latest entered statement while the latest cut is provisional (spec §9)', { timeout: 60_000 }, async () => {
    const sample = missedCut(AS_OF)
    const db = await signUp()
    try {
      await call(db, 'import_household', { p_doc: sample.doc })
      const snapshot = buildSnapshot(await call<unknown>(db, 'export_household'), AS_OF, sample.rates)
      const walk = engine(snapshot)
      const card = snapshot.doc.accounts.find((a): a is CardAccount => a.kind === 'credit_card')!
      const replay = cardsOf(walk)?.get(card.id)
      const current = replay?.statements.find((s) => s.id === replay.current_id)
      expect(current).toMatchObject({ provisional: true, cut_date: '2026-10-05' })
      const entered = snapshot.doc.statements.find((s) => s.account_id === card.id)!
      expect(entered).toMatchObject({ cut_date: '2026-09-05', total_due_minor: 800000 })
      const core = debtFigures(snapshot, walk).cards.find((c) => c.account_id === card.id)!.remaining_due_minor
      // Core's remaining due counts from the simulated cut; post_batch from the entered total less the one payment posted after its cut, so core's figure is refused.
      expect(core).toBe(633493)
      const measured = await threshold(db, card, core)
      expect(measured).toMatchObject({ remaining_minor: 800000 - 300000, cut_date: '2026-09-05' })
    } finally {
      await db.rpc('delete_my_account')
    }
  })
})
