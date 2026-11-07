import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { knownCurrencies, moneyLike } from './dev/audit'

const REPO = join(import.meta.dirname, '..', '..', '..')

// Everything a screen can draw: the app, core's words and the sample households. Development pages never ship, and tests and their card households never render.
const ROOTS = ['apps/app/src', 'packages/core/src', 'packages/core/fixtures']
const SKIP_DIRS = new Set(['apps/app/src/dev', 'apps/app/src/app/dev', 'packages/core/fixtures/statements'])

interface Line {
  file: string
  line: number
  text: string
  // The JSX attribute or property the string is given as, such as title or body.
  key: string | null
  // The nearest named function around it.
  fn: string | null
  // A template part's sides that meet a substitution: a head ends at one, a tail starts after one, a middle has both.
  before: boolean
  after: boolean
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(relative(REPO, path)) ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|\.d\.ts$|test-helpers\.ts$/.test(entry.name) ? [path] : []
  })
}

function keyOf(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return p.name.getText()
    if (ts.isPropertyAssignment(p)) return p.name.getText()
    if (!(ts.isJsxExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p) || ts.isBinaryExpression(p))) return null
  }
  return null
}

function fnOf(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText()
  }
  return null
}

// Every string literal, template part and JSX text, leaving out module paths and types.
function collect(): Line[] {
  const lines: Line[] = []
  for (const path of ROOTS.flatMap((root) => sourceFiles(join(REPO, root)))) {
    const file = relative(REPO, path)
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node) || ts.isExternalModuleReference(node)) return
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return
      let text: string | null = null
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text
      else if (ts.isJsxText(node)) text = node.getText().replace(/\s+/g, ' ').trim()
      const before = ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      const after = ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
      if (text) lines.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text, key: keyOf(node), fn: fnOf(node), before, after })
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return lines
}

const where = (l: Line) => `${l.file}:${l.line} ${JSON.stringify(l.text.slice(0, 80))}`
const offenders = (lines: readonly Line[], bad: (l: Line) => boolean) => lines.filter(bad).map(where)

// Words a person reads: two words of letters, so ids, paths, codes and icon outlines are left out.
const readable = (l: Line) => /[A-Za-z]{2,} [a-z]{2,}/.test(l.text)

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}|\u{200D}/u
const MIGRATION = /\bmigrations?\s+#?\d+|\b\d{4}_[a-z_]+\.sql\b/i
// A board task id, a dated edit marker such as 'UPDATED 9 Oct 2026', or a note to whoever edits the copy.
const EDITOR_NOTE = /\bP\d+-\d+\b|\b[A-Z][A-Z-]{3,}\b[^.]{0,40}\b\d{1,2}\s+[A-Z][a-z]{2}\w*\s+20\d\d|\b(TODO|FIXME|XXX)\b|\b[Nn]ote to self\b|\((Read|Editor|Note)\b/
const MONTHS = '(?:January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
const MONTH_LITERAL = new RegExp(`\\b${MONTHS}\\.?\\s+(\\d{1,2}(st|nd|rd|th)?,?\\s+)?(19|20)\\d\\d\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTHS}\\b|\\b${MONTHS}\\.?\\s+\\d{1,2}(st|nd|rd|th)?\\b|\\b(19|20)\\d\\d-(0[1-9]|1[0-2])\\b`)
// A symbol at the edge of a template part, or a currency code beside a substitution, frames an amount formatted by hand.
const HAND_MONEY = /\p{Sc}\s?$|^\s?\p{Sc}/u
const CODE_BEFORE = /^\s?([A-Z]{3})\b/
const CODE_AFTER = /\b([A-Z]{3})\s?$/
function handMoney(l: Line): boolean {
  if (HAND_MONEY.test(l.text)) return true
  const codes = knownCurrencies()
  const lead = l.before ? CODE_BEFORE.exec(l.text)?.[1] : undefined
  const tail = l.after ? CODE_AFTER.exec(l.text)?.[1] : undefined
  return (lead !== undefined && codes.has(lead)) || (tail !== undefined && codes.has(tail))
}

// Names and labels stay about one line on a phone; any other line stays a sentence or two.
const SURFACES = { title: 44, line: 160 } as const
const TITLE_KEYS = new Set(['title', 'label', 'listTitle', 'heading', 'placeholder', 'accessibilityLabel'])
const surfaceOf = (l: Line): keyof typeof SURFACES => (l.key !== null && TITLE_KEYS.has(l.key) ? 'title' : 'line')

describe('rendered copy (invariants 168 and 169)', () => {
  const lines = collect()
  const app = lines.filter((l) => l.file.startsWith('apps/app/'))
  const has = (file: string, text: string) => lines.some((l) => l.file === file && l.text === text)

  it('collects the strings every screen draws, from the app, core and the samples', () => {
    expect(new Set(lines.map((l) => l.file)).size).toBeGreaterThan(150)
    expect(app.filter(readable).length).toBeGreaterThan(1000)
    expect(has('apps/app/src/screens/debts/Debts.tsx', 'Revolving cleared')).toBe(true)
    expect(has('packages/core/src/next-action.ts', 'Nothing to do now')).toBe(true)
    expect(has('packages/core/fixtures/abroad.ts', 'Loan to a friend, repaid in slices')).toBe(true)
    expect(lines.some((l) => l.file === 'apps/app/src/screens/debts/Debts.tsx' && l.fn === 'CardPage' && /^EMI/.test(l.text))).toBe(true)
  })

  it('carries no emoji or pictograph, as markers are kit icons', () => {
    expect(offenders(lines, (l) => EMOJI.test(l.text))).toEqual([])
  })

  it('names no migration, board task, dated edit marker or note to the editor', () => {
    expect(offenders(lines, (l) => MIGRATION.test(l.text) || EDITOR_NOTE.test(l.text))).toEqual([])
  })

  it('keeps the app’s titles and labels to 44 characters and every other line to 160', () => {
    expect(offenders(app.filter(readable), (l) => l.text.trim().length > SURFACES[surfaceOf(l)])).toEqual([])
  })

  it('types no amount, so every figure comes from a row or the engine and passes the mask', () => {
    expect(offenders(lines, (l) => moneyLike(l.text) || handMoney(l))).toEqual([])
    // The check itself: a code typed beside a substitution counts, a name that only looks like one does not.
    const part = (text: string, before: boolean, after: boolean): Line => ({ file: '', line: 0, text, key: null, fn: null, before, after })
    expect([part(' EUR left', true, false), part('Pay USD ', false, true), part(' · ', true, true), part(' FAQ left', true, false), part('EUR', false, false)].map(handMoney)).toEqual([true, true, false, false, false])
  })

  it('types no date or month, so dates and months come from rows and the engine', () => {
    expect(offenders(lines, (l) => MONTH_LITERAL.test(l.text))).toEqual([])
  })

  it('says EMI only on Debt detail, beside a card’s installments', () => {
    const emi = lines.filter((l) => /\bEMI\b/.test(l.text)).map((l) => `${l.file} ${l.fn}`)
    expect([...new Set(emi)]).toEqual(['apps/app/src/screens/debts/Debts.tsx CardPage'])
  })

  it('never labels a button or titles the Add sheet Pay, since the app records a payment the person makes at their bank', () => {
    const pay = (l: Line) => /^Pay(\s|$)/.test(l.text) && (l.key === 'label' || l.file === 'apps/app/src/app/add.tsx' || l.file === 'apps/app/src/screens/add/sheet-words.ts')
    expect(offenders(app, pay)).toEqual([])
    expect(app.filter((l) => l.text === 'Record payment').map((l) => l.file)).toEqual(['apps/app/src/screens/today/today.model.ts'])
    expect(has('apps/app/src/screens/add/sheet-words.ts', 'Record payment to ')).toBe(true)
  })

  it('never says carry-free, since Debts names the milestone Revolving cleared', () => {
    expect(offenders(lines, (l) => /carry[- ]?free/i.test(l.text))).toEqual([])
  })
})
