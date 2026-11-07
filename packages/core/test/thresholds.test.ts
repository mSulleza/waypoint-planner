/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { THRESHOLDS } from '../src/thresholds'

const sources = import.meta.glob(['../src/**/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('display thresholds', () => {
  it('keeps display thresholds in one place, each paired with its word, and no engine module reads them', () => {
    for (const [name, t] of Object.entries(THRESHOLDS)) {
      expect([name, t.word.length > 0, t.otherwise.length > 0, new Set<string>([t.word, t.otherwise]).size]).toEqual([name, true, true, 2])
    }
    const readers = Object.entries(sources)
      .filter(([, text]) => /from '\.{1,2}\/thresholds'/.test(text))
      .map(([file]) => file)
      .sort()
    expect(Object.keys(sources).length).toBeGreaterThan(30)
    expect(readers).toEqual(['../src/alerts.ts', '../src/budget.ts', '../src/index.ts', '../src/pace.ts'])
  })
})
