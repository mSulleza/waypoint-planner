import type { Sample, SampleDoc } from '../fixtures'
import { alerts, type Alert } from '../src/alerts'
import { budgetRows, type BudgetRow } from '../src/budget'
import { plainNames, renderCopy, type Copy } from '../src/copy'
import { CARDS } from '../src/engine/cards'
import { fxBreakeven, type FxBreakeven } from '../src/engine/fx-breakeven'
import { LOANS } from '../src/engine/loans'
import type { Walk } from '../src/engine/types'
import { nextAction, type NextAction } from '../src/next-action'
import { reviewList, type ReviewItem } from '../src/review'
import { buildSnapshot, type Snapshot } from '../src/snapshot'
import { walked } from './walk-helpers'

export interface Advice {
  snapshot: Snapshot
  walk: Walk
  breakeven: FxBreakeven | null
  review: readonly ReviewItem[]
  budgets: readonly BudgetRow[]
  alerts: readonly Alert[]
  next: NextAction
  // Plain text in the household locale, for reading copy in a test.
  say: (copy: Copy) => string
}

// Everything Today reads, from one full walk with the card and loan modules and, in two currencies, the FX breakeven.
export async function advise(snapshot: Snapshot): Promise<Advice> {
  const walk = walked(snapshot, { cards: CARDS, loans: LOANS })
  const found = await fxBreakeven(snapshot)
  if (found !== null && !found.ok) throw new Error(`The breakeven failed: ${found.errors.map((e) => e.message).join('; ')}`)
  const review = reviewList(snapshot, walk)
  const budgets = budgetRows(snapshot)
  const names = plainNames(snapshot)
  return {
    snapshot,
    walk,
    breakeven: found,
    review,
    budgets,
    alerts: alerts({ snapshot, walk, review, breakeven: found, budgets }),
    next: nextAction({ snapshot, walk, review }),
    say: (copy) => renderCopy(copy, names),
  }
}

export function sampleAt(sample: (asOf: string) => Sample, asOf: string, edit?: (doc: SampleDoc) => void): Snapshot {
  const { doc, rates } = sample(asOf)
  edit?.(doc)
  return buildSnapshot(doc, asOf, rates)
}

// Every title the advice shows, alerts and the next action's words alike.
export const titlesOf = (a: Advice): string[] => [...a.alerts.map((x) => x.title), a.next.title.map((p) => ('text' in p ? p.text : '')).join('')]
