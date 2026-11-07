// A pane draws at most this many points across its lines (spec §8).
export const MAX_POINTS = 300
// The smallest budget for one line: both ends plus one bucket's minimum and maximum on each side of today.
export const MIN_LINE_POINTS = 8

// A run of days [start, end) and the indices of its lowest and highest balance, the first of each.
export interface Bucket {
  start: number
  end: number
  lo: number
  hi: number
}

export function bucketOf(values: ArrayLike<number>, start: number, end: number): Bucket {
  let lo = start
  let hi = start
  for (let i = start + 1; i < end; i++) {
    const v = values[i] as number
    if (v < (values[lo] as number)) lo = i
    if (v > (values[hi] as number)) hi = i
  }
  return { start, end, lo, hi }
}

// Indices of `values` in [from, to] to draw, at most `max` of them: both ends, then each bucket's minimum and maximum in order, so the dip before payday survives.
export function downsample(values: ArrayLike<number>, max: number = MAX_POINTS, from = 0, to = values.length - 1): number[] {
  if (to < from) return []
  const n = to - from + 1
  if (n <= Math.max(max, 2)) return Array.from({ length: n }, (_, i) => from + i)
  const inner = n - 2
  const buckets = Math.max(1, Math.floor((max - 2) / 2))
  const kept = [from]
  for (let b = 0; b < buckets; b++) {
    const start = from + 1 + Math.floor((b * inner) / buckets)
    const end = from + 1 + Math.floor(((b + 1) * inner) / buckets)
    if (end <= start) continue
    const { lo, hi } = bucketOf(values, start, end)
    if (lo === hi) kept.push(lo)
    else kept.push(Math.min(lo, hi), Math.max(lo, hi))
  }
  kept.push(to)
  return kept
}

// Calendar buckets of `months` months each, from the 1st, for a span too long to draw by the day; `firsts` are the indices where each month starts after index 0.
export function monthBuckets(values: ArrayLike<number>, firsts: readonly number[], months: number): Bucket[] {
  const edges = [0, ...firsts.filter((_, k) => (k + 1) % months === 0), values.length].filter((e, k, all) => k === 0 || e > (all[k - 1] as number))
  const out: Bucket[] = []
  for (let k = 0; k + 1 < edges.length; k++) out.push(bucketOf(values, edges[k] as number, edges[k + 1] as number))
  return out
}

// Past and projection downsampled apart, both keeping `at` (today), so each half ends on the today rule; at most `max` indices in all, for any max from MIN_LINE_POINTS.
export function downsampleAround(values: ArrayLike<number>, at: number, max: number = MAX_POINTS): number[] {
  const last = values.length - 1
  if (last < 0) return []
  if (at <= 0 || at >= last) return downsample(values, max)
  const pastLength = at + 1
  // The today index is shared, so the halves may take max + 1 between them; each half gets at least 4, the least downsample() keeps within.
  const share = Math.round(((max + 1) * pastLength) / (values.length + 1))
  const pastBudget = Math.min(pastLength, Math.max(4, Math.min(max - 3, share)))
  const past = downsample(values, pastBudget, 0, at)
  const future = downsample(values, max + 1 - pastBudget, at, last)
  return [...past, ...future.slice(1)]
}
