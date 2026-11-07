import { describe, expect, it } from 'vitest'
import { sheetMotion } from './motion'

describe('sheetMotion', () => {
  it('returns a 150 ms fade with no movement when Reduce Motion is on', () => {
    expect(sheetMotion('enter', true)).toEqual({ kind: 'fade', opacity: [0, 1], translateY: [0, 0], duration: 150, easing: [0.2, 0, 0, 1] })
    expect(sheetMotion('exit', true)).toEqual({ kind: 'fade', opacity: [1, 0], translateY: [0, 0], duration: 150, easing: [0.2, 0, 0, 1] })
  })

  it('rises 32 into place over 350 ms and leaves in 263 ms when Reduce Motion is off', () => {
    expect(sheetMotion('enter', false)).toEqual({ kind: 'rise', opacity: [0, 1], translateY: [32, 0], duration: 350, easing: [0.05, 0.7, 0.1, 1] })
    expect(sheetMotion('exit', false)).toEqual({ kind: 'rise', opacity: [1, 0], translateY: [0, 32], duration: 263, easing: [0.3, 0, 0.8, 0.15] })
  })
})
