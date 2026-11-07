import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_KEY, MASK_AT_OPEN_KEY, readAppearance, readMaskAtOpen, rememberAppearance, rememberMaskAtOpen } from './device'
import { memoryStorage } from './test-helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mask amounts when the app opens', () => {
  it('is off until set on this device, then kept under its own key', () => {
    const store = memoryStorage()
    vi.stubGlobal('localStorage', store)
    expect(readMaskAtOpen()).toBe(false)
    expect(rememberMaskAtOpen(true)).toBe(true)
    expect([readMaskAtOpen(), store.getItem(MASK_AT_OPEN_KEY)]).toEqual([true, '1'])
    expect(rememberMaskAtOpen(false)).toBe(true)
    expect([readMaskAtOpen(), store.getItem(MASK_AT_OPEN_KEY)]).toEqual([false, null])
  })

  it('opens with amounts shown, and says it was not kept, where the browser blocks storage', () => {
    const blocked = { ...memoryStorage(), getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    vi.stubGlobal('localStorage', blocked)
    expect(readMaskAtOpen()).toBe(false)
    expect(rememberMaskAtOpen(true)).toBe(false)
  })
})

describe('appearance on this device', () => {
  it('is System until Light or Dark is kept under its own key, and System clears the key', () => {
    const store = memoryStorage()
    vi.stubGlobal('localStorage', store)
    expect(readAppearance()).toBe('system')
    expect(rememberAppearance('dark')).toBe(true)
    expect([readAppearance(), store.getItem(APPEARANCE_KEY)]).toEqual(['dark', 'dark'])
    expect(rememberAppearance('light')).toBe(true)
    expect([readAppearance(), store.getItem(APPEARANCE_KEY)]).toEqual(['light', 'light'])
    expect(rememberAppearance('system')).toBe(true)
    expect([readAppearance(), store.getItem(APPEARANCE_KEY), store.length]).toEqual(['system', null, 0])
  })

  it('reads a value it does not know as System', () => {
    const store = memoryStorage()
    vi.stubGlobal('localStorage', store)
    for (const kept of ['sepia', 'Dark', '', '"dark"']) {
      store.setItem(APPEARANCE_KEY, kept)
      expect(readAppearance()).toBe('system')
    }
  })

  it('opens on System, and says it was not kept, where the browser blocks storage', () => {
    const blocked = { ...memoryStorage(), getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
    vi.stubGlobal('localStorage', blocked)
    expect(readAppearance()).toBe('system')
    expect(rememberAppearance('dark')).toBe(false)
    expect(rememberAppearance('system')).toBe(false)
  })

  it('opens on System where there is no storage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readAppearance()).toBe('system')
    expect(rememberAppearance('light')).toBe(false)
  })
})
