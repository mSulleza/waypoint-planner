import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fnv1a64 } from '../src/hash'

const { TextEncoder } = globalThis as unknown as { TextEncoder: new () => { encode(text: string): Uint8Array } }

function bigintFnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  return h.toString(16).padStart(16, '0')
}

const anyChar = fc.oneof(
  fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
  fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c)),
)

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64-bit vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325')
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c')
    expect(fnv1a64('foobar')).toBe('85944171f73967e8')
  })

  it('agrees with a BigInt reference over UTF-8 for any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: anyChar, maxLength: 40 }), (text) => {
        expect(fnv1a64(text)).toBe(bigintFnv1a64(text))
      }),
      { numRuns: 1000 },
    )
  })

  it('gives 16 hex characters and tells near rows apart', () => {
    const a = fnv1a64('2026-01-15|-450|COFFEE SHOP|0')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(fnv1a64('2026-01-15|-450|COFFEE SHOP|1')).not.toBe(a)
  })
})
