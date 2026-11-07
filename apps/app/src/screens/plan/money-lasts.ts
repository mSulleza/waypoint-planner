import { monthsMoneyLastsYielding, type Snapshot } from '@waypoint/core'
import { useEffect, useState } from 'react'
import { nextTask } from '@/data/hooks'
import type { MoneyLastsResult } from './plan.model'

const RESULTS = new WeakMap<Snapshot, Promise<MoneyLastsResult | Error>>()

// One income-gap walk per snapshot, started a task after the screen asks and handing the thread back between its steps, so it never lengthens the render; a throw comes back as the Error.
export function moneyLastsOf(snapshot: Snapshot): Promise<MoneyLastsResult | Error> {
  let found = RESULTS.get(snapshot)
  if (!found) {
    found = nextTask()
      .then(() => monthsMoneyLastsYielding(snapshot, { pause: nextTask }))
      .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    RESULTS.set(snapshot, found)
  }
  return found
}

// Months the money lasts if income stops on this snapshot; undefined while it is worked out.
export function useMoneyLasts(snapshot: Snapshot): MoneyLastsResult | Error | undefined {
  const [done, setDone] = useState<{ snapshot: Snapshot; value: MoneyLastsResult | Error } | null>(null)
  useEffect(() => {
    let live = true
    void moneyLastsOf(snapshot).then((value) => live && setDone({ snapshot, value }))
    return () => {
      live = false
    }
  }, [snapshot])
  return done && done.snapshot === snapshot ? done.value : undefined
}
