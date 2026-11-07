import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGE_ROUTES, PUBLIC_ROUTES, SHEET_ROUTES } from './gate.model'

const APP = join(import.meta.dirname, '..', 'app')

// Every screen file under src/app, leaving out layouts and the development pages.
function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'dev' ? [] : routeFiles(path)
    return entry.name.endsWith('.tsx') && !entry.name.startsWith('_') ? [relative(APP, path)] : []
  })
}

// The name the root stack gives a route file: the tabs group is one screen.
const stackName = (file: string) => (file.startsWith('(tabs)/') ? '(tabs)' : file.replace(/\.tsx$/, ''))

describe('routes', () => {
  const files = routeFiles(APP)
  const source = (file: string) => readFileSync(join(APP, file), 'utf8')

  it('draws every route but Welcome through Screen or RouteSheet, so every page has the header with Settings or sits over one', () => {
    expect(files.length).toBeGreaterThanOrEqual(18)
    for (const file of files.filter((f) => f !== 'welcome.tsx')) expect(/<(Screen|RouteSheet)\b/.test(source(file)), file).toBe(true)
  })

  it('opens exactly the sheet routes as transparent modals over the tabs', () => {
    const sheets = files.filter((f) => source(f).includes('<RouteSheet')).sort()
    expect(sheets).toEqual(SHEET_ROUTES.map((name) => `${name}.tsx`).sort())
    expect(source('_layout.tsx')).toContain("presentation: 'transparentModal'")
  })

  it('puts every route behind the gate except Welcome, onboarding and the public delete-account page', () => {
    const gated = new Set<string>(['(tabs)', ...SHEET_ROUTES, ...PAGE_ROUTES])
    const ungated = new Set<string>(['welcome', 'onboarding', ...PUBLIC_ROUTES])
    const names = [...new Set(files.map(stackName))].sort()
    expect(names).toEqual([...gated, ...ungated].sort())
    const layout = source('_layout.tsx')
    expect(layout).toMatch(/<Stack\.Protected guard=\{open\.app\}>\s*<Stack\.Screen name="\(tabs\)" \/>\s*\{SHEET_ROUTES\.map[\s\S]*\{PAGE_ROUTES\.map[\s\S]*?<\/Stack\.Protected>/)
  })
})
