import { describe, expect, it } from 'vitest'
import { APPEARANCES, nativeScheme, resolveScheme, rootTheme } from './appearance'

describe('appearance', () => {
  it('follows the device on System and keeps Light or Dark whatever the device says', () => {
    const devices = ['light', 'dark', null, undefined, 'unspecified'] as const
    const table = APPEARANCES.map((a) => [a, devices.map((d) => resolveScheme(a, d))])
    expect(table).toEqual([
      ['system', ['light', 'dark', 'light', 'light', 'light']],
      ['light', ['light', 'light', 'light', 'light', 'light']],
      ['dark', ['dark', 'dark', 'dark', 'dark', 'dark']],
    ])
  })

  it('pins the phone’s system UI to Light or Dark and hands it back to the device on System', () => {
    expect(APPEARANCES.map(nativeScheme)).toEqual(['unspecified', 'light', 'dark'])
  })

  it('marks the web root only for a pinned scheme, so System stays with prefers-color-scheme', () => {
    expect(APPEARANCES.map(rootTheme)).toEqual([null, 'light', 'dark'])
  })
})
