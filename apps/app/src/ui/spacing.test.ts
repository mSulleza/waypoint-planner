import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { iconNudge, SEGMENT_INSET, SPACE, TEXT_GAP } from './tokens'

const SRC = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// A gap, padding or margin typed as a bare number in a style.
const RAW = /\b(gap|rowGap|columnGap|padding\w*|margin\w*)\s*:\s*(-?\d+(?:\.\d+)?)\b/g

describe('spacing', () => {
  it('keeps every step on the 4-point scale', () => {
    expect(Object.values(SPACE).filter((v) => v % 4 !== 0)).toEqual([])
  })

  it('types no gap, padding or margin off the 4-point scale; the half steps are named tokens', () => {
    const off: string[] = []
    for (const path of sources(SRC)) {
      const text = readFileSync(path, 'utf8')
      for (const m of text.matchAll(RAW)) if (Number(m[2]) % 4 !== 0) off.push(`${relative(SRC, path)}: ${m[0]}`)
    }
    expect(off).toEqual([])
    expect([TEXT_GAP, SEGMENT_INSET]).toEqual([2, 2])
  })

  it('centres an icon on the first line beside it', () => {
    expect([iconNudge(20, 20), iconNudge(20, 18), iconNudge(18, 16), iconNudge(22, 18), iconNudge(16, 20)]).toEqual([0, 1, 1, 2, 0])
  })
})
