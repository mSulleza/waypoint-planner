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

describe('status colour', () => {
  it('draws a bare status word only in the chart readout’s Under floor; every account word is a Pill', () => {
    expect(filesMatching(/<StatusText\b/)).toEqual(['ui/chart/LinePlot.tsx'])
    expect(filesMatching(/<Pill tone=\{WORD_TONE\[/)).toEqual(['screens/months/Months.tsx', 'screens/months/Strip.tsx', 'screens/plan/Plan.tsx', 'screens/today/Today.tsx'])
  })

  it('paints status ink directly only in form fields’ errors, the chart’s floor mark and a week column past its budget, each with its triangle; screens use Pill, Banner or AlertLine', () => {
    expect(filesMatching(/colors\.(positive|caution|negative)\b/)).toEqual(['ui/DateField.tsx', 'ui/MonthStepper.tsx', 'ui/SelectField.tsx', 'ui/TextField.tsx', 'ui/WeekColumns.tsx', 'ui/chart/LinePlot.tsx'])
  })
})
