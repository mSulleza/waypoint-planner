import { canonical, type CompareResult, type Lever, type Snapshot } from '@waypoint/core'
import { compare } from '@waypoint/core/compare'
import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { nextTask } from '@/data/hooks'
import { slotsOf, type Slot } from './compare.model'

// Rows measured on each snapshot, by what they measure; a row depends only on its snapshot and its patch, so a list that gains or loses a lever keeps the others' figures while the run starts again.
const MEASURED = new WeakMap<Snapshot, Map<string, CompareResult>>()

function slotKey(slot: Slot, levers: readonly Lever[]): string {
  if (slot.role === 'baseline') return 'baseline'
  if (slot.role === 'together') return `together ${canonical(levers.map((l) => l.patch))}`
  const lever = levers[slot.lever ?? -1]
  return `lever ${canonical(lever ?? null)}`
}

function memoOf(snapshot: Snapshot): Map<string, CompareResult> {
  let memo = MEASURED.get(snapshot)
  if (!memo) {
    memo = new Map()
    MEASURED.set(snapshot, memo)
  }
  return memo
}

export interface CompareRun {
  // In slotsOf order; null while a slot is still measuring.
  results: readonly (CompareResult | null)[]
  // The run has handed over every row it will (it stops after a baseline that fails).
  finished: boolean
}

// Core compare() on the shared snapshot, a row at a time: each walk runs in its own task (spec §6.9), so the screen draws between them.
export function useCompare(snapshot: Snapshot, levers: readonly Lever[], key: string): CompareRun {
  const [state, setState] = useState<{ snapshot: Snapshot; key: string; seen: number; finished: boolean }>({ snapshot, key, seen: 0, finished: false })
  useEffect(() => {
    let live = true
    const slots = slotsOf(levers.length)
    const memo = memoOf(snapshot)
    const run = compare(snapshot, levers, { pause: nextTask })
    setState({ snapshot, key, seen: 0, finished: false })
    void (async () => {
      let i = 0
      for await (const row of run) {
        if (!live) break
        const slot = slots[i]
        if (slot) memo.set(slotKey(slot, levers), row)
        const seen = ++i
        startTransition(() => setState((s) => (s.snapshot === snapshot && s.key === key ? { ...s, seen } : s)))
      }
      if (live) startTransition(() => setState((s) => (s.snapshot === snapshot && s.key === key ? { ...s, finished: true } : s)))
    })()
    return () => {
      live = false
      void run.return(undefined)
    }
    // levers follow key, their link fragment.
  }, [snapshot, key])
  // A reload brings a new snapshot; its rows replace the last ones as they are measured, so the screen never blanks back to Measuring.
  const last = useRef<{ key: string; results: readonly (CompareResult | null)[] } | null>(null)
  const run = useMemo(() => {
    const memo = memoOf(snapshot)
    const current = state.snapshot === snapshot && state.key === key
    const before = last.current?.key === key ? last.current.results : []
    const results = slotsOf(levers.length).map((slot, i) => memo.get(slotKey(slot, levers)) ?? before[i] ?? null)
    return { results, finished: current && state.finished }
    // state.seen moves when the memo gains a row.
  }, [snapshot, key, state])
  useEffect(() => {
    last.current = { key, results: run.results }
  }, [key, run])
  return run
}
