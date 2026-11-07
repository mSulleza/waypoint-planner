import { AuthApiError } from '@supabase/supabase-js'
import { buildSnapshot, debtFigures, formatMoney, ledgerSum, runEngine } from '@waypoint/core'
import { abroad, usCardsCar } from '@waypoint/core/fixtures'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as tick } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linePrompt, type Prompt } from '../../../apps/mcp/src/prompt'
import { compare, deleteHousehold, main, type Io } from '../../../scripts/import-to-cloud'
import { waypointClient, type Db } from './client'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/
const AS_OF = '2026-10-07'
const TABLES = ['households', 'accounts', 'categories', 'plan_items', 'statements', 'transactions'] as const
const PASSWORD = 'Existing pw "1" \\ é'

// A folder with an env file and the abroad sample as a household file.
function files(envUrl: string, envKey: string) {
  const dir = mkdtempSync(join(tmpdir(), 'waypoint-import-'))
  const env = join(dir, 'project.env')
  const file = join(dir, 'household.json')
  writeFileSync(env, `# other keys are skipped\nEXPO_PUBLIC_WEB_URL=https://example.test\nEXPO_PUBLIC_SUPABASE_URL=${envUrl}\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${envKey}\n`)
  writeFileSync(file, JSON.stringify(abroad(AS_OF).doc))
  return { dir, env, file }
}

// A terminal as readline sees one: keys arrive one by one and raw mode is switched by the reader.
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input })
  let shown = ''
  const output = new PassThrough().on('data', (chunk: Buffer) => (shown += chunk.toString()))
  const type = async (keys: string) => {
    for (const k of keys) {
      input.write(k)
      await tick(1)
    }
  }
  return { input, output, shown: () => shown, type }
}

async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ready(); i++) await tick(5)
  if (!ready()) throw new Error('timed out waiting for the prompt')
}

describe('pnpm import:cloud on a terminal, with a stand-in server', () => {
  const at = files('http://127.0.0.1:9', 'sb_publishable_test')
  afterAll(() => rmSync(at.dir, { recursive: true, force: true }))

  const signedIn = { data: { user: { id: 'u1' }, session: {} }, error: null }
  const refused = { data: { user: null, session: null }, error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials') }
  it.each([
    { name: 'a household already there', signIn: signedIn, said: 'Signed in as a***@example.test.', problem: 'This account already has a household at http://127.0.0.1:9. Nothing changed.' },
    { name: 'a wrong password', signIn: refused, said: 'Importing', problem: 'That email and password do not match.' },
  ])('$name: echoes the email as typed, masks it after sign-in, and never shows the password on stdout or stderr', async ({ signIn, said, problem }) => {
    const term = fakeTerminal()
    const prompt = linePrompt(term.input, term.output)
    const errors: string[] = []
    const sent: unknown[] = []
    const fake = {
      auth: {
        signInWithPassword: async (credentials: unknown) => {
          sent.push(credentials)
          return signIn
        },
        signOut: async () => {
          sent.push('signOut')
          return { error: null }
        },
      },
      from: () => ({ select: async () => ({ data: [{ id: 'u1' }], error: null }) }),
    }
    const done = main(['--env', at.env, '--file', at.file], { prompt, err: (line) => void errors.push(line), connect: () => fake as unknown as Db })
    await waitFor(() => term.shown().includes('Email: '))
    await term.type('A@Example.test\r')
    await waitFor(() => term.shown().includes('Password: '))
    await term.type(`${PASSWORD}\r`)
    expect(await done).toBe(1)
    prompt.close()
    expect(sent).toEqual([{ email: 'a@example.test', password: PASSWORD }, 'signOut'])
    expect(term.shown()).toContain('A@Example.test')
    expect(term.shown()).toContain(said)
    expect(errors.join('\n')).toContain(problem)
    expect(term.shown()).not.toContain(PASSWORD)
    expect(errors.join('\n')).not.toContain(PASSWORD)
    expect(term.shown() + errors.join('\n')).not.toContain('sb_publishable_test')
  })

  it('checks the file with core’s schema before it asks anything or reaches a server', async () => {
    const bad = join(at.dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ ...abroad(AS_OF).doc, version: 2 }))
    const lines: string[] = []
    const prompt: Prompt = { ask: () => Promise.reject(new Error('asked')), secret: () => Promise.reject(new Error('asked')), say: (line) => void lines.push(line) }
    const code = await main(['--env', at.env, '--file', bad], { prompt, err: (line) => void lines.push(line), connect: () => { throw new Error('connected') } })
    expect(code).toBe(1)
    expect(lines).toEqual([`${bad} is not a household Waypoint can import:\n  - version: must be 1`])
  })
})

describe('the check of the cloud copy against the file', () => {
  const lineOf = (doc: unknown, against: unknown, label: string) => compare(buildSnapshot(doc, AS_OF, []), buildSnapshot(against, AS_OF, [])).find((l) => l.label === label)

  it('reads a card’s latest statement, whatever statements came before it', () => {
    const doc = abroad(AS_OF).doc
    const earlier = { ...doc, statements: [...doc.statements, { id: 'rewards-earlier', account_id: 'rewards-card', cut_date: '2026-08-20', due_date: '2026-09-15', total_due_minor: 1234500, minimum_due_minor: 0 }] }
    const plain = lineOf(doc, doc, 'Rewards card (card)')!
    expect(plain.file).toBe('₱45,000.00')
    expect(lineOf(earlier, earlier, 'Rewards card (card)')).toEqual(plain)
  })

  it('pairs two accounts with one name by their figures, and flags an account the other side lacks', () => {
    const doc = abroad(AS_OF).doc
    const twins = { ...doc, accounts: doc.accounts.map((a) => (a.id === 'tax' ? { ...a, name: 'Main' } : a)) }
    const swapped = { ...twins, accounts: [...twins.accounts].reverse() }
    expect(compare(buildSnapshot(twins, AS_OF, []), buildSnapshot(swapped, AS_OF, [])).every((l) => l.same)).toBe(true)
    expect(lineOf(twins, swapped, 'Main (cash, 1 of 2)')).toMatchObject({ file: '€1,800.00', cloud: '€1,800.00' })
    const renamed = { ...doc, accounts: doc.accounts.map((a) => (a.id === 'pesos' ? { ...a, name: 'Pesos 2' } : a)) }
    expect(lineOf(doc, renamed, 'Pesos (cash)')).toEqual({ label: 'Pesos (cash)', file: '₱30,000.00', cloud: 'missing', difference: 'missing', same: false })
    expect(lineOf(doc, renamed, 'Pesos 2 (cash)')).toMatchObject({ file: 'missing', cloud: '₱30,000.00', same: false })
  })
})

interface User {
  db: Db
  id: string
  email: string
  password: string
}

async function signUp(): Promise<User> {
  const db = waypointClient(url!, key!)
  const email = `import-cloud-${randomUUID()}@example.test`
  const password = `${PASSWORD} ${randomUUID()}`
  const { data, error } = await db.auth.signUp({ email, password })
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message ?? 'no session'}`)
  return { db, id: data.user.id, email, password }
}

async function exportOf(db: Db): Promise<{ accounts: { id: string }[] } & Record<string, unknown>> {
  const { data, error } = await db.rpc('export_household')
  if (error) throw new Error(`export_household: ${error.message}`)
  return data
}

async function rowsSeenBy(db: Db): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of TABLES) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true })
    if (error) throw new Error(`${table}: ${error.message}`)
    counts[table] = count ?? -1
  }
  return counts
}

describe.skipIf(!url || !key || !LOCAL.test(url))('pnpm import:cloud against the local stack', () => {
  const doc = abroad(AS_OF).doc
  const counts = { households: 1, accounts: doc.accounts.length, categories: doc.categories.length, plan_items: doc.plan_items.length, statements: doc.statements.length, transactions: doc.transactions.length }
  let at: ReturnType<typeof files>
  const users: User[] = []
  let a: User
  let b: User
  let bBefore: unknown

  // The script with scripted answers: the account's email and password, then the confirmation word when one is given.
  async function run(flags: string[], confirm?: string, extra: Partial<Io> = {}) {
    const answers = [a.email, a.password, ...(confirm === undefined ? [] : [confirm])]
    const lines: string[] = []
    const answer = async (question: string) => {
      lines.push(question)
      const next = answers.shift()
      if (next === undefined) throw new Error('The input ended before an answer was given.')
      return next
    }
    const prompt: Prompt = { ask: answer, secret: answer, say: (line) => void lines.push(line) }
    const code = await main(['--env', at.env, '--file', at.file, ...flags], { prompt, err: (line) => void lines.push(line), ...extra })
    const text = lines.join('\n')
    expect(text).not.toContain(a.password)
    expect(text).not.toContain(key!)
    return { code, text, unanswered: answers.length }
  }

  beforeAll(async () => {
    at = files(url!, key!)
    a = await signUp()
    users.push(a)
    b = await signUp()
    users.push(b)
    const { error } = await b.db.rpc('import_household', { p_doc: usCardsCar(AS_OF).doc })
    if (error) throw new Error(`import_household: ${error.message}`)
    bBefore = await exportOf(b.db)
  }, 30_000)

  afterAll(async () => {
    await Promise.all(users.map((u) => u.db.rpc('delete_my_account')))
    if (at) rmSync(at.dir, { recursive: true, force: true })
  })

  it('imports into an account with no household, prints the counts and the check, and ends with OK', { timeout: 30_000 }, async () => {
    const { code, text } = await run([])
    expect(code).toBe(0)
    expect(text).toContain(`Signed in as i***@example.test.`)
    expect(text).toContain(`Imported: households 1, accounts ${counts.accounts}, categories ${counts.categories}, plan_items ${counts.plan_items}, statements ${counts.statements}, transactions ${counts.transactions}.`)
    // The figures the app shows today: each cash account's ledger balance, and each card's remaining due while its current cut is an entered statement.
    const sample = abroad(AS_OF)
    const snapshot = buildSnapshot(sample.doc, AS_OF, sample.rates)
    const engine = runEngine(snapshot)
    if (!engine.ok) throw new Error('the engine did not run')
    const cards = new Map(debtFigures(snapshot, engine.walk).cards.map((c) => [c.account_id, c]))
    for (const acc of snapshot.doc.accounts) {
      const card = cards.get(acc.id)
      expect(card === undefined || snapshot.doc.statements.some((st) => st.id === card.statement_id)).toBe(true)
      const minor = card ? card.remaining_due_minor : ledgerSum(snapshot, acc.id, AS_OF)
      const figure = formatMoney(minor, acc.currency, 'en-PH').replace('.', '\\.')
      expect(text).toMatch(new RegExp(`^${acc.name} \\(${card ? 'card' : 'cash'}\\) +${figure} +${figure} +`, 'm'))
    }
    expect(text.trimEnd().split('\n').at(-1)).toBe('OK: cloud matches the file')
    expect(await rowsSeenBy(a.db)).toEqual(counts)
  })

  it('refuses a second import without --replace and changes nothing', { timeout: 30_000 }, async () => {
    const before = await exportOf(a.db)
    const { code, text } = await run([])
    expect(code).toBe(1)
    expect(text).toContain('This account already has a household')
    expect(text).toContain('Run again with --replace')
    expect(await exportOf(a.db)).toEqual(before)
  })

  it('aborts --replace on any answer but REPLACE and changes nothing', { timeout: 30_000 }, async () => {
    const before = await exportOf(a.db)
    const { code, text, unanswered } = await run(['--replace'], 'replace')
    expect(code).toBe(1)
    expect(unanswered).toBe(0)
    expect(text).toContain(`holds accounts ${counts.accounts}, categories ${counts.categories}`)
    expect(text.trimEnd().split('\n').at(-1)).toBe('Nothing changed: the answer was not REPLACE.')
    expect(await exportOf(a.db)).toEqual(before)
  })

  it('deletes the old household on REPLACE, imports the file again and ends with OK', { timeout: 30_000 }, async () => {
    const before = await exportOf(a.db)
    const { code, text } = await run(['--replace'], 'REPLACE')
    expect(code).toBe(0)
    expect(text).toContain('Deleted the old household.')
    expect(text.trimEnd().split('\n').at(-1)).toBe('OK: cloud matches the file')
    const after = await exportOf(a.db)
    const old = new Set(before.accounts.map((acc) => acc.id))
    expect(after.accounts.some((acc) => old.has(acc.id))).toBe(false)
    expect(await rowsSeenBy(a.db)).toEqual(counts)
  })

  type Exported = { accounts: { name: string; opening_balance_minor: number }[]; plan_items: { name: string }[] }
  it.each([
    {
      change: 'one account’s opening balance up by 1.00',
      tamper: (copy: Exported) => void (copy.accounts.find((acc) => acc.name === 'Main')!.opening_balance_minor += 100),
      lines: [/^Main \(cash\) +€6,450\.00 +€6,451\.00 +€1\.00$/m, /^rows: plan_items +14 +14 +0$/m],
    },
    {
      change: 'one plan item fewer',
      tamper: (copy: Exported) => void (copy.plan_items = copy.plan_items.filter((p) => p.name !== 'Sell the old camera')),
      lines: [/^rows: plan_items +14 +13 +-1$/m, /^Main \(cash\) +€6,450\.00 +€6,450\.00 +€0\.00$/m],
    },
  ])('reports MISMATCH and exits 1 when the export read back has $change', { timeout: 30_000 }, async ({ tamper, lines }) => {
    const readBack = (exported: unknown) => {
      const copy = structuredClone(exported) as Exported
      tamper(copy)
      return copy
    }
    const { code, text } = await run(['--replace'], 'REPLACE', { readBack })
    expect(code).toBe(1)
    for (const line of lines) expect(text).toMatch(line)
    expect(text.trimEnd().split('\n').at(-1)).toBe('MISMATCH')
  })

  it('leaves a second user’s household untouched through every --replace', { timeout: 30_000 }, async () => {
    expect(await exportOf(b.db)).toEqual(bBefore)
  })

  it('deleting the households row removes every Waypoint row of that user through the cascades, and no one else’s', { timeout: 30_000 }, async () => {
    const others = await rowsSeenBy(b.db)
    expect(Object.values(await rowsSeenBy(a.db)).every((n) => n > 0)).toBe(true)
    await deleteHousehold(a.db, a.id)
    expect(await rowsSeenBy(a.db)).toEqual({ households: 0, accounts: 0, categories: 0, plan_items: 0, statements: 0, transactions: 0 })
    expect(Object.values(others).every((n) => n > 0)).toBe(true)
    expect(await rowsSeenBy(b.db)).toEqual(others)
    expect(await exportOf(b.db)).toEqual(bBefore)
  })
})
