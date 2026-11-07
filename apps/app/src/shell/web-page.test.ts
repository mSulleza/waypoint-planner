import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPEARANCE_KEY } from '../data/device'
import { memoryStorage } from '../data/test-helpers'
import { ROOT_THEME_ATTRIBUTE } from '../ui/appearance'
import { COLORS } from '../ui/tokens'

const PAGE = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'index.html'), 'utf8')

// Runs the page's inline appearance script against a storage and a root, and returns the root's theme mark.
function markAfterLoad(storage: Pick<Storage, 'getItem'>): string | null {
  const script = /<script id="waypoint-appearance">([\s\S]*?)<\/script>/.exec(PAGE)?.[1]
  if (!script) throw new Error('index.html has no appearance script')
  const marks = new Map<string, string>()
  const document = { documentElement: { setAttribute: (name: string, value: string) => void marks.set(name, value) } }
  new Function('localStorage', 'document', script)(storage, document)
  return marks.get(ROOT_THEME_ATTRIBUTE) ?? null
}

const rule = (selector: string) => new RegExp(`${selector.replace(/[[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(PAGE)?.[1] ?? ''

describe('the web page', () => {
  it('paints each theme’s background before the app loads, so a dark load never flashes white', () => {
    const [light, dark] = PAGE.split('@media (prefers-color-scheme: dark)')
    expect(light).toContain(`background-color: ${COLORS.light.bg};`)
    expect(dark).toContain(`background-color: ${COLORS.dark.bg};`)
    expect(PAGE).toMatch(/color-scheme: light dark;/)
  })

  it('marks the root with a pinned Light or Dark before the first paint, and leaves System to the media query', () => {
    const store = memoryStorage()
    expect(markAfterLoad(store)).toBeNull()
    store.setItem(APPEARANCE_KEY, 'dark')
    expect(markAfterLoad(store)).toBe('dark')
    store.setItem(APPEARANCE_KEY, 'light')
    expect(markAfterLoad(store)).toBe('light')
    store.setItem(APPEARANCE_KEY, 'sepia')
    expect(markAfterLoad(store)).toBeNull()
    expect(markAfterLoad({ getItem: () => { throw new Error('blocked') } })).toBeNull()
  })

  it('paints a pinned theme’s background and scheme over the device’s', () => {
    expect(rule(`:root[${ROOT_THEME_ATTRIBUTE}='light']`)).toMatch(new RegExp(`color-scheme: light;[\\s\\S]*background-color: ${COLORS.light.bg};`))
    expect(rule(`:root[${ROOT_THEME_ATTRIBUTE}='dark']`)).toMatch(new RegExp(`color-scheme: dark;[\\s\\S]*background-color: ${COLORS.dark.bg};`))
  })

  it('never lets the browser embolden a bold font file again, since each weight loads as its own family', () => {
    const font = /<style id="waypoint-font">([\s\S]*?)<\/style>/.exec(PAGE)?.[1] ?? ''
    expect(font).toMatch(/:root\s*\{\s*font-synthesis: none;\s*\}/)
  })

  it('never blocks pinch zoom (invariant 185)', () => {
    expect(PAGE).not.toMatch(/maximum-scale|user-scalable/)
  })
})
