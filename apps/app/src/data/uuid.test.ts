import { describe, expect, it } from 'vitest'
import { uuidOf } from './uuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuidOf', () => {
  it('makes a v4 uuid from sixteen random bytes, for a browser without crypto.randomUUID', () => {
    expect(uuidOf(new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    expect(uuidOf(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000')
    expect(uuidOf(crypto.getRandomValues(new Uint8Array(16)))).toMatch(V4)
  })
})
