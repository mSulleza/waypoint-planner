import { cpus } from 'node:os'
import { markSize } from '../fixtures'
import { buildSnapshot, expandPlan, fxBreakeven, runEngine, type Snapshot, type WalkMode } from '../src'

// Fixed so every run walks the same calendar; the fixture dates itself from it.
const AS_OF = '2026-10-07'
const RUNS = 30
const WARM_UP = 5
// Spec §11: 30 ms jitless on an M-series Mac; CI sets 90 ms because GitHub's runner measured 66 ms (8 Oct 2026).
const BUDGET_MS = Number(process.env.WALK_BUDGET_MS ?? 30)
const JIT_TARGET_MS = 10

// node --jitless also turns off WebAssembly, so its absence tells the two runs apart.
const jitless = !('WebAssembly' in globalThis)
const sample = markSize(AS_OF)
const fresh = (): Snapshot => buildSnapshot(sample.doc, AS_OF, sample.rates)

const median = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b)
  const mid = s.length / 2
  return s.length % 2 === 0 ? ((s[mid - 1] as number) + (s[mid] as number)) / 2 : (s[Math.floor(mid)] as number)
}
const p95 = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.ceil(0.95 * ms.length) - 1] as number
const ms = (n: number) => `${n.toFixed(2).padStart(6)} ms`
const line = (label: string, times: number[], extra = '') => console.log(`${label.padEnd(38)} median ${ms(median(times))}   p95 ${ms(p95(times))}${extra}`)

// Each run gets a snapshot object the engine has not seen, as after a reload, so the plan expansion is part of the walk.
function timeWalks(mode: WalkMode): { total: number[]; expansion: number[] } {
  const total: number[] = []
  const expansion: number[] = []
  for (let i = 0; i < WARM_UP + RUNS; i++) {
    const snapshot = fresh()
    const start = performance.now()
    expandPlan(snapshot)
    const expanded = performance.now()
    const result = runEngine(snapshot, undefined, mode)
    const end = performance.now()
    if (!result.ok) throw new Error(`The ${mode} walk failed: ${JSON.stringify(result.errors)}`)
    if (i < WARM_UP) continue
    total.push(end - start)
    expansion.push(expanded - start)
  }
  return { total, expansion }
}

async function timeBreakeven(): Promise<{ times: number[]; walks: number }> {
  const times: number[] = []
  let walks = 0
  for (let i = 0; i < WARM_UP + RUNS; i++) {
    const snapshot = fresh()
    // The screen walks a snapshot before it asks for the breakeven, so the expansion is already shared.
    expandPlan(snapshot)
    const start = performance.now()
    const result = await fxBreakeven(snapshot, { pause: () => Promise.resolve() })
    const end = performance.now()
    if (result === null || !result.ok) throw new Error(`The breakeven failed: ${JSON.stringify(result)}`)
    if (i < WARM_UP) continue
    times.push(end - start)
    walks = result.walks
  }
  return { times, walks }
}

const { doc } = fresh()
console.log(`markSize as of ${AS_OF}: ${doc.accounts.length} accounts, ${doc.plan_items.length} plan items, ${doc.transactions.length} transactions`)
console.log(`${RUNS} runs after ${WARM_UP} warm-up; each walk is of a new snapshot object, so it includes the plan expansion`)
// Timings only compare on one machine, so the log names the CPU, such as a CI runner's.
console.log(`node ${process.version}, ${jitless ? 'JIT off (--jitless)' : 'JIT on'}, ${cpus()[0]?.model ?? 'unknown CPU'}`)
const full = timeWalks('full')
line('full walk', full.total)
line('  of which plan expansion', full.expansion)
const metrics = timeWalks('metrics')
line('metrics walk', metrics.total)
const breakeven = await timeBreakeven()
line('fx breakeven, no yields', breakeven.times, `   ${breakeven.walks} walks`)

// Checked with or without the JIT, so a misread flag cannot pass a slow walk; compared as printed.
const fullMedian = Math.round(median(full.total) * 100) / 100
const pass = fullMedian <= BUDGET_MS
console.log(`budget: median full walk ${fullMedian.toFixed(2)} ms against ${BUDGET_MS} ms: ${pass ? 'pass' : 'FAIL'}`)
if (!jitless) console.log(`target with the JIT on this Mac: ${JIT_TARGET_MS} ms: ${fullMedian <= JIT_TARGET_MS ? 'met' : 'over'}`)
if (!pass) process.exitCode = 1
