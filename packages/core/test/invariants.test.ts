/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'

const raw = (files: Record<string, unknown>) => files as Record<string, string>
const map = raw(import.meta.glob('../INVARIANTS.md', { query: '?raw', import: 'default', eager: true }))['../INVARIANTS.md'] ?? ''
// Every place a cited test can live, keyed by its path from the repository root.
const tests = new Map(
  Object.entries({
    ...raw(import.meta.glob('./**/*.test.ts', { query: '?raw', import: 'default', eager: true })),
    ...raw(import.meta.glob('../../../apps/app/src/**/*.test.ts', { query: '?raw', import: 'default', eager: true })),
    ...raw(import.meta.glob('../../../apps/mcp/src/**/*.test.ts', { query: '?raw', import: 'default', eager: true })),
    ...raw(import.meta.glob('../../../supabase/tests/*.sql', { query: '?raw', import: 'default', eager: true })),
    ...raw(import.meta.glob('../../../tests/db/test/**/*.ts', { query: '?raw', import: 'default', eager: true })),
  }).map(([file, text]) => [file.replace(/^\.\.\/\.\.\/\.\.\//, '').replace(/^\.\//, 'packages/core/test/'), text]),
)
const migrations = Object.values(raw(import.meta.glob('../../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }))).join('\n')

interface Rule {
  n: number
  owner: string
  clauses: string[]
}

const rules: Rule[] = map
  .split('\n')
  .filter((line) => /^\| \d+ \|/.test(line))
  .map((line) => {
    const [n = '', , owner = '', ...status] = line.slice(1, -1).split('|').map((cell) => cell.trim())
    return { n: Number(n), owner, clauses: status.join('|').split('; ') }
  })

const STARTS = /^(test|database check|structure|dropped|partly dropped): \S/
const TEST = /^test: ([^:]+\.(?:ts|tsx|sql)): (.+)$/
// The name as the file spells it: a quoted test title, with JavaScript and SQL quote escapes undone.
const titled = (text: string, name: string) => ["'", '"', '`'].some((q) => text.replace(/\\'/g, "'").replace(/''/g, "'").includes(`${q}${name}${q}`))

describe('INVARIANTS.md', () => {
  it('lists the old app’s 218 rules in order, each with one owner task', () => {
    expect(rules.map((r) => r.n)).toEqual(Array.from({ length: 218 }, (_, i) => i + 1))
    expect(rules.filter((r) => !/^P\d+-\d+$/.test(r.owner)).map((r) => r.n)).toEqual([])
  })

  it('ends every rule as a test, a database check, structure, dropped or partly dropped, and leaves none open', () => {
    expect(map.match(/\bplanned\b/g) ?? []).toEqual([])
    expect(rules.filter((r) => !STARTS.test(r.clauses[0] ?? '')).map((r) => r.n)).toEqual([])
    // A clause without its own keyword only continues the reason of a structure, dropped or partly dropped clause before it.
    const stray = rules.filter((r) => {
      let reason = false
      for (const c of r.clauses) {
        if (STARTS.test(c)) reason = !/^(test|database check): /.test(c)
        else if (!reason) return true
      }
      return false
    })
    expect(stray.map((r) => r.n)).toEqual([])
  })

  it('cites only tests that exist, by file and title', () => {
    const cited = rules.flatMap((r) => r.clauses.flatMap((c) => (TEST.test(c) ? [{ n: r.n, file: c.match(TEST)?.[1] ?? '', name: c.match(TEST)?.[2] ?? '' }] : [])))
    expect(cited.length).toBeGreaterThan(240)
    expect(tests.size).toBeGreaterThan(80)
    const missing = cited.filter((c) => !titled(tests.get(c.file) ?? '', c.name)).map((c) => `${c.n} ${c.file}: ${c.name.slice(0, 60)}`)
    expect(missing).toEqual([])
  })

  it('cites only database checks the migrations create', () => {
    const named = rules.flatMap((r) => r.clauses.filter((c) => c.startsWith('database check: ')).flatMap((c) => (c.match(/\b[a-z0-9]+(?:_[a-z0-9]+)*_check\b/g) ?? []).map((name) => ({ n: r.n, name }))))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((c) => !migrations.includes(`constraint ${c.name} check`)).map((c) => `${c.n} ${c.name}`)).toEqual([])
  })
})
