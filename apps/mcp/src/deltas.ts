import { fxBreakeven, snapshotIndex, walkMetrics, type CashMetrics, type Snapshot } from '@waypoint/core'
import type { World } from './data'
import { amount, bySortOrder, type Amount } from './tools/read/shape'

export interface LowestChange {
  account_id: string
  currency: string
  // The lowest end-of-day balance from today to the projection's end; null when the account was not walked on that side.
  before: Amount | null
  after: Amount | null
  change: Amount | null
  lowest_on_before: string | null
  lowest_on_after: string | null
}

export interface FloorDays {
  account_id: string
  before: number | null
  after: number | null
  change: number | null
}

export interface MarginChange {
  before: number | null
  after: number | null
  change: number | null
  // Why a side has no margin, when its breakeven walk failed.
  problem: string | null
}

// What a write moved, from the engine on the export before it and the export after it (spec §9).
export interface Deltas {
  moved: boolean
  lowest: LowestChange[]
  days_under_floor: { before: number; after: number; change: number; by_account: FloorDays[] }
  // Null in a one-currency household.
  fx_margin: MarginChange | null
}

// Node has no screen to hand back to between walks.
const pause = () => Promise.resolve()

type Margin = { margin: number } | { problem: string } | null

async function marginOf(snapshot: Snapshot): Promise<Margin> {
  const found = await fxBreakeven(snapshot, { pause })
  if (found === null) return null
  return found.ok ? { margin: found.margin } : { problem: found.errors.map((e) => e.message).join(' ') }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

// Cash accounts in the after world's order, then any the write took away.
function cashIds(before: World, after: World): string[] {
  const ids: string[] = []
  for (const world of [after, before]) {
    for (const a of [...world.snapshot.doc.accounts].sort(bySortOrder)) if (a.kind === 'cash' && !ids.includes(a.id)) ids.push(a.id)
  }
  return ids
}

export async function deltas(before: World, after: World): Promise<Deltas> {
  const [was, is] = [walkMetrics(before.snapshot, before.walk), walkMetrics(after.snapshot, after.walk)]
  const [marginBefore, marginAfter] = await Promise.all([marginOf(before.snapshot), marginOf(after.snapshot)])
  const metric = (cash: readonly CashMetrics[], id: string) => cash.find((c) => c.account_id === id)
  const currencyOf = (id: string) => (snapshotIndex(after.snapshot).accounts.get(id) ?? snapshotIndex(before.snapshot).accounts.get(id))?.currency ?? before.snapshot.doc.household.base_currency
  const ids = cashIds(before, after).filter((id) => metric(was.cash, id) || metric(is.cash, id))
  const lowest = ids.map((id) => {
    const [b, a] = [metric(was.cash, id), metric(is.cash, id)]
    const currency = currencyOf(id)
    return {
      account_id: id,
      currency,
      before: b ? amount(b.lowest_minor, currency) : null,
      after: a ? amount(a.lowest_minor, currency) : null,
      change: a && b ? amount(a.lowest_minor - b.lowest_minor, currency) : null,
      lowest_on_before: b?.lowest_on ?? null,
      lowest_on_after: a?.lowest_on ?? null,
    }
  })
  const by_account = ids.map((id) => {
    const [b, a] = [metric(was.cash, id)?.days_under_floor ?? null, metric(is.cash, id)?.days_under_floor ?? null]
    return { account_id: id, before: b, after: a, change: a !== null && b !== null ? a - b : null }
  })
  const sum = (side: 'before' | 'after') => by_account.reduce((n, d) => n + (d[side] ?? 0), 0)
  const days_under_floor = { before: sum('before'), after: sum('after'), change: sum('after') - sum('before'), by_account }
  const value = (m: Margin) => (m !== null && 'margin' in m ? m.margin : null)
  const problem = [marginBefore, marginAfter].flatMap((m) => (m !== null && 'problem' in m ? [m.problem] : [])).join(' ') || null
  const [mb, ma] = [value(marginBefore), value(marginAfter)]
  const fx_margin = marginBefore === null && marginAfter === null ? null : { before: mb, after: ma, change: mb !== null && ma !== null ? round3(ma - mb) : null, problem }
  const moved = lowest.some((l) => l.change === null || l.change.amount_minor !== 0) || by_account.some((d) => d.change !== 0) || (fx_margin !== null && fx_margin.change !== 0)
  return { moved, lowest, days_under_floor, fx_margin }
}
