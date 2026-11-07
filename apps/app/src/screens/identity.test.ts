import { buildSnapshot, fxBreakeven, runEngine, type Snapshot, type Walk } from '@waypoint/core'
import { abroad, mortgage, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import { identityIndex } from '../ui/identity'
import { debtsModel } from './debts/debts.model'
import { moneyModel } from './money/money.model'
import { monthPanes, planPanes } from './months/months.model'
import { todayModel } from './today/today.model'

const AS_OF = '2026-10-09'

async function world(build: (asOf: string) => Sample, edit?: (doc: SampleDoc) => void): Promise<{ snapshot: Snapshot; walk: Walk; today: ReturnType<typeof todayModel> }> {
  const sample = build(AS_OF)
  edit?.(sample.doc)
  const snapshot = buildSnapshot(sample.doc, AS_OF, sample.rates)
  const run = runEngine(snapshot)
  if (!run.ok) throw new Error(`the engine did not run: ${JSON.stringify(run.errors)}`)
  const breakeven = await fxBreakeven(snapshot)
  if (breakeven !== null && !breakeven.ok) throw new Error('the breakeven did not run')
  return { snapshot, walk: run.walk, today: todayModel({ snapshot, walk: run.walk, breakeven }) }
}

// Every colour each screen gives an account: Today's cash tiles, Money's rows, Debts' rows and both charts' series.
async function coloursOn(build: (asOf: string) => Sample, edit?: (doc: SampleDoc) => void) {
  const { snapshot, walk, today } = await world(build, edit)
  const money = moneyModel(snapshot)
  const seen: [string, string, number][] = [
    ...today.cash.map((c) => ['today', c.account_id, c.colour] as [string, string, number]),
    ...[...money.groups.flatMap((g) => g.accounts), ...money.debts].map((a) => ['money', a.account_id, a.colour] as [string, string, number]),
    ...(debtsModel(snapshot, walk)?.debts ?? []).map((d) => ['debts', d.account_id, d.colour] as [string, string, number]),
    ...monthPanes(snapshot, walk, '2026-10').flatMap((p) => p.lines.map((l) => ['month chart', l.account_id, l.colour] as [string, string, number])),
    ...planPanes(snapshot, walk).flatMap((p) => p.lines.map((l) => ['plan chart', l.account_id, l.colour] as [string, string, number])),
  ]
  return { snapshot, today, seen }
}

const byAccount = (seen: readonly [string, string, number][]) => {
  const out: Record<string, number[]> = {}
  for (const [, id, colour] of seen) (out[id] ??= []).push(colour)
  return out
}

describe('account colours across screens', () => {
  it('give each account one colour on Today, Money, Debts and every chart, by its place in the account order', async () => {
    const { seen } = await coloursOn(abroad)
    expect(byAccount(seen)).toEqual({ main: [0, 0, 0, 0], tax: [1, 1, 1, 1], pesos: [2, 2, 2, 2], 'rewards-card': [3, 3], 'shopping-card': [4, 4] })
    const us = await coloursOn(usCardsCar)
    expect(byAccount(us.seen)).toEqual({ checking: [0, 0, 0, 0], savings: [1, 1, 1, 1], 'travel-card': [2, 2], 'store-card': [3, 3], 'car-loan': [4, 4] })
    const uk = await coloursOn(mortgage)
    expect(byAccount(uk.seen)).toEqual({ current: [0, 0, 0, 0], savings: [1, 1, 1, 1], mortgage: [2, 2] })
  })

  it('count cards in the order too: a card sorted first moves every cash tile and chart series one colour on', async () => {
    const { seen } = await coloursOn(abroad, (doc) => {
      const card = doc.accounts.find((a) => a.id === 'rewards-card')
      if (card) card.sort_order = -1
    })
    expect(byAccount(seen)).toEqual({ main: [1, 1, 1, 1], tax: [2, 2, 2, 2], pesos: [3, 3, 3, 3], 'rewards-card': [0, 0], 'shopping-card': [4, 4] })
  })

  it('keep every account’s colour when a paid-off card is archived', async () => {
    const before = await coloursOn(usCardsCar)
    const after = await coloursOn(usCardsCar, (doc) => {
      const card = doc.accounts.find((a) => a.id === 'travel-card')
      if (card) card.archived_at = '2026-10-01T00:00:00+00:00'
    })
    // The archived card leaves the screens; every account still on them keeps its colour.
    expect(byAccount(after.seen)).toEqual({ checking: [0, 0, 0, 0], savings: [1, 1, 1, 1], 'store-card': [3, 3], 'car-loan': [4, 4] })
    expect(byAccount(before.seen)['car-loan']).toEqual([4, 4])
  })

  it('keep the same colours after a reload that brings the accounts back in another order', async () => {
    for (const build of [abroad, usCardsCar, mortgage]) {
      const first = await coloursOn(build)
      const again = await coloursOn(build, (doc) => void doc.accounts.reverse())
      expect(again.seen.sort()).toEqual(first.seen.sort())
      expect([...identityIndex(again.snapshot.doc.accounts)]).toEqual([...identityIndex(first.snapshot.doc.accounts)])
    }
  })

  it('mark each of Today’s next 30 days with the colour of the account it is listed on, as its cash tile has', async () => {
    const swatches = async (edit?: (doc: SampleDoc) => void) => {
      const { today } = await coloursOn(abroad, edit)
      const out: Record<string, number[]> = {}
      for (const item of today.agenda.flatMap((d) => d.items)) if (!(out[item.account_id] ??= []).includes(item.colour)) out[item.account_id]?.push(item.colour)
      return { out, tiles: Object.fromEntries(today.cash.map((c) => [c.account_id, c.colour])) }
    }
    const plain = await swatches()
    expect(plain.out).toEqual({ main: [0], pesos: [2] })
    expect(plain.tiles).toMatchObject({ main: 0, pesos: 2 })
    const moved = await swatches((doc) => {
      const card = doc.accounts.find((a) => a.id === 'rewards-card')
      if (card) card.sort_order = -1
    })
    expect(moved.out).toEqual({ main: [1], pesos: [3] })
  })

  it('never follow an account’s state: Pesos keeps its colour from Short to OK', async () => {
    const short = await coloursOn(abroad)
    const ok = await coloursOn(abroad, (doc) => {
      const pesos = doc.accounts.find((a) => a.id === 'pesos')
      if (pesos) pesos.opening_balance_minor = (pesos.opening_balance_minor ?? 0) + 50000000
    })
    expect([short.today.cash.find((c) => c.account_id === 'pesos')?.word, ok.today.cash.find((c) => c.account_id === 'pesos')?.word]).toEqual(['Short', 'OK'])
    expect(ok.seen).toEqual(short.seen)
  })
})
