import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function filesMatching(pattern: RegExp): string[] {
  return sources(SRC)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path))
    .sort()
}

const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

describe('Cobalt', () => {
  it('fills one hero on Today, Debts, Plan and Lending, and none on Months or Money', () => {
    expect(filesMatching(/<Hero>/)).toEqual(['screens/debts/Debts.tsx', 'screens/lending/Lending.tsx', 'screens/plan/Plan.tsx', 'screens/today/Today.tsx'])
  })

  it('paints brand as a fill only in the hero and the round + button; a primary button on a card or sheet takes tab-ind', () => {
    expect(filesMatching(/colors\.brand\b/)).toEqual(['ui/Button.tsx', 'ui/Hero.tsx'])
    expect(read('ui/Button.tsx')).toContain('round ? [colors.brand, colors.onBrand] : [colors.tabInd, colors.onTabInd]')
  })

  it('makes every other button tonal by default, a white one with a brand-text label only on a banner’s status fill, and a disabled filled one an outline', () => {
    const button = read('ui/Button.tsx')
    expect(button).toMatch(/variant = 'tonal'/)
    expect(filesMatching(/'secondary'/)).toEqual(['ui/Banner.tsx', 'ui/Button.tsx'])
    expect(read('ui/Banner.tsx')).toContain("variant={neutral ? 'tonal' : 'secondary'}")
    expect(button).toContain("variant === 'icon' ? colors.text : colors.brandText")
    expect(button).toContain('const outlined = disabled && filled')
  })

  it('keeps Cobalt in the header to the + button: Back, the eye and Settings are ink, the FX chip neutral, the title in display type', () => {
    const header = read('ui/Header.tsx')
    expect(header.match(/iconOnly variant="icon"/g)?.length).toBe(3)
    expect(header).not.toMatch(/brandText|brandSoft/)
    expect(header).toContain('backgroundColor: colors.surface2')
    expect(header).toContain('<Text variant="display" level={1} style={{ flexShrink: 1 }}>')
    expect(read('ui/Banner.tsx')).not.toMatch(/surface2/)
  })

  it('marks the active section in the sidebar tonally, keeping the solid Cobalt pill for the phone tab bar', () => {
    const bar = read('ui/TabBar.tsx')
    expect(bar).toContain('backgroundColor: active ? colors.brandSoft')
    expect(bar).toContain("backgroundColor: active ? colors.tabInd : 'transparent' }, hover(s)]")
  })
})
