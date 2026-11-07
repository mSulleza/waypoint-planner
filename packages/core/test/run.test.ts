import { describe, expect, it } from 'vitest'
import { abroad } from '../fixtures'
import { expandPlan } from '../src/engine/events'
import { runEngine, type EngineRun } from '../src/engine/run'
import type { Walk } from '../src/engine/types'
import { buildSnapshot } from '../src/snapshot'
import { sampleAt } from './advice-helpers'
import { balanceOn, topUpPairs } from './walk-helpers'

const AS_OF = '2026-10-16'

function walkOf(run: EngineRun): Walk {
  if (!run.ok) throw new Error(`The run failed: ${JSON.stringify(run.errors)}`)
  return run.walk
}

// The euros sent to Pesos on each top-up day of this month.
const octoberSends = (run: EngineRun) => topUpPairs(walkOf(run)).filter(([date]) => date < '2026-11-01').map(([date, , , sent]) => [date, sent])

describe('runEngine', () => {
  it('returns the same result object for the same snapshot object and walks a new snapshot object again', () => {
    const snapshot = sampleAt(abroad, AS_OF)
    const first = runEngine(snapshot)
    expect(octoberSends(first)).toEqual([
      ['2026-10-16', 43750],
      ['2026-10-28', 10487],
    ])
    expect(Object.isFrozen(first)).toBe(true)
    expect(first.ok && first.world.snapshot).toBe(snapshot)
    expect(runEngine(snapshot)).toBe(first)
    for (const same of [{}, '{}', { patch: {} }]) expect(runEngine(snapshot, same, 'full')).toBe(first)

    const again = sampleAt(abroad, AS_OF)
    const second = runEngine(again)
    expect(second).not.toBe(first)
    expect(walkOf(second)).not.toBe(walkOf(first))
    expect(expandPlan(again)).not.toBe(expandPlan(snapshot))
    expect(octoberSends(second)).toEqual(octoberSends(first))
    expect(runEngine(again)).toBe(second)
  })

  it('keys a run on the checked patch and the mode', () => {
    const snapshot = sampleAt(abroad, AS_OF)
    const full = runEngine(snapshot)
    const metrics = runEngine(snapshot, undefined, 'metrics')
    expect(metrics).not.toBe(full)
    expect([walkOf(metrics).mode, walkOf(metrics).lines.length]).toEqual(['metrics', 0])
    expect(walkOf(metrics).balances.get('main')).toEqual(walkOf(full).balances.get('main'))

    const weaker = runEngine(snapshot, { fx_shift_pct: -0.1 })
    expect(weaker).not.toBe(full)
    expect(walkOf(weaker).fx_shift_pct).toBe(-0.1)
    expect(octoberSends(weaker)).toEqual([
      ['2026-10-16', 43750],
      ['2026-10-28', 16514],
    ])

    const raise = { groceries: { amount_minor: 50000, from_month: '2026-11' } }
    const both = runEngine(snapshot, { fx_shift_pct: -0.1, items: raise })
    expect(runEngine(snapshot, { items: { groceries: { from_month: '2026-11', amount_minor: 50000 } }, fx_shift_pct: -0.1 })).toBe(both)
    expect(runEngine(snapshot, JSON.stringify({ patch: { items: raise, fx_shift_pct: -0.1 } }))).toBe(both)
    if (!both.ok) throw new Error('The raise failed')
    expect(both.world.snapshot).not.toBe(snapshot)
    expect(both.world.snapshot.doc.plan_items.filter((p) => p.id.startsWith('groceries@')).map((p) => [p.id, p.amount_minor, p.starts_on])).toEqual([['groceries@2026-11', 50000, '2026-11-01']])
    // The walk ran on the patched plan: Main spends 100.00 more on groceries each month from November.
    const gap = (day: string) => balanceOn(walkOf(both), 'main', day) - balanceOn(walkOf(weaker), 'main', day)
    expect([gap('2026-10-31'), gap('2026-11-30'), gap('2026-12-31')]).toEqual([0, -10000, -20000])
    expect(runEngine(snapshot)).toBe(full)
  })

  it('shares one run for the same item ids written in another order', () => {
    const snapshot = sampleAt(abroad, AS_OF)
    const first = runEngine(snapshot, { items: { salary: { removed: true }, rent: { removed: true } } })
    expect(runEngine(snapshot, { items: { rent: { removed: true }, salary: { removed: true } } })).toBe(first)
    if (!first.ok) throw new Error('Removing salary and rent failed')
    const ids = first.world.snapshot.doc.plan_items.map((p) => p.id)
    expect([ids.includes('salary'), ids.includes('rent'), ids.includes('groceries')]).toEqual([false, false, true])
    // No 4,000.00 salary on the 28th leaves Main nothing above its floor for that day's 104.87 top-up; no rent keeps 900.00 from 2 November.
    const gap = (day: string) => balanceOn(walkOf(first), 'main', day) - balanceOn(walkOf(runEngine(snapshot)), 'main', day)
    expect([gap('2026-10-27'), gap('2026-10-28'), gap('2026-11-02') - gap('2026-11-01')]).toEqual([0, -400000 + 10487, 90000])
    expect(octoberSends(first)).toEqual([['2026-10-16', 43750]])
  })

  it('reports a bad patch and a walk that cannot run, and keeps the run the patch named', () => {
    const snapshot = sampleAt(abroad, AS_OF)
    expect(runEngine(snapshot, { fx_shift_pct: 2 })).toEqual({ ok: false, stage: 'patch', errors: ['fx_shift_pct: must be a fraction below 1, such as 0.1 for 10% stronger'] })
    const unknown = runEngine(snapshot, { items: { nope: { removed: true } } })
    expect(unknown).toEqual({ ok: false, stage: 'patch', errors: ["items.nope: no plan item 'nope'"] })
    expect(runEngine(snapshot, { items: { nope: { removed: true } } })).toBe(unknown)

    const { doc, rates } = abroad(AS_OF)
    const noPesoRate = buildSnapshot(doc, AS_OF, rates.filter((r) => r.quote !== 'PHP'))
    const failed = runEngine(noPesoRate)
    expect(failed).toEqual({ ok: false, stage: 'walk', errors: [{ code: 'missing_rate', message: "No reference rate for PHP, so money cannot move between 'main', 'pesos'", ids: ['main', 'pesos'] }] })
    expect(runEngine(noPesoRate)).toBe(failed)
  })
})
