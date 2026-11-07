import { applyPatch, canonical, type PatchedWorld } from '../levers'
import { parsePatch } from '../schema/patch'
import type { Snapshot } from '../snapshot'
import type { Walk, WalkError, WalkMode } from './types'
import { walk } from './walk'

export type EngineRun =
  | { ok: true; world: PatchedWorld; walk: Walk }
  | { ok: false; stage: 'patch'; errors: readonly string[] }
  | { ok: false; stage: 'walk'; errors: readonly WalkError[] }

const runs = new WeakMap<Snapshot, Map<string, EngineRun>>()

// One walk per snapshot object, patch and mode, so screens that share a snapshot share its walk (spec §6.9).
export function runEngine(snapshot: Snapshot, patch?: unknown, mode: WalkMode = 'full'): EngineRun {
  const parsed = parsePatch(patch)
  if (!parsed.ok) return Object.freeze({ ok: false, stage: 'patch', errors: Object.freeze(parsed.errors) })
  // Keyed on the checked patch with its keys sorted, so no patch, {}, the same patch as JSON text and the same ids in another order share one walk.
  const key = `${mode} ${canonical(parsed.value)}`
  let byPatch = runs.get(snapshot)
  const cached = byPatch?.get(key)
  if (cached) return cached
  const result = run(snapshot, parsed.value, mode)
  if (!byPatch) runs.set(snapshot, (byPatch = new Map()))
  byPatch.set(key, result)
  return result
}

function run(snapshot: Snapshot, patch: unknown, mode: WalkMode): EngineRun {
  const world = applyPatch(snapshot, patch)
  if (!world.ok) return Object.freeze({ ok: false, stage: 'patch', errors: Object.freeze(world.errors) })
  const walked = walk(world.value.snapshot, { ...world.value.options, mode })
  if (!walked.ok) return Object.freeze({ ok: false, stage: 'walk', errors: walked.errors })
  return Object.freeze({ ok: true, world: world.value, walk: walked })
}
