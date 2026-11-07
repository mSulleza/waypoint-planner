// Imports one household file into a Waypoint project as the signed-in user and checks the export against it; run from the repo root with pnpm import:cloud.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { authProblem, cleanEmail, looksLikeEmail } from '../apps/mcp/src/auth'
import { linePrompt, type Prompt } from '../apps/mcp/src/prompt'
import { buildSnapshot, checkInput, formatMoney, importDoc, ledgerSum, SnapshotError, snapshotIndex, todayIn, type Snapshot } from '../packages/core/src/index'

const USAGE = 'Usage: pnpm import:cloud --env <file with EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY> --file <household JSON> [--replace]'
const URL_NAME = 'EXPO_PUBLIC_SUPABASE_URL'
const KEY_NAME = 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'
const TABLES = ['accounts', 'categories', 'plan_items', 'statements', 'transactions'] as const
type Table = (typeof TABLES)[number]
// ledgerSum's last day: every row counts, future-dated ones included.
const EVERY_DAY = '9999-12-31'

const connect = (url: string, key: string) => createClient(url, key, { db: { schema: 'waypoint' }, auth: { persistSession: false, autoRefreshToken: false } })
export type Db = ReturnType<typeof connect>

export interface Io {
  prompt: Prompt
  // Problems; everything else goes through prompt.say.
  err(line: string): void
  // Test seams: the client to sign in with, and a change to the export before the check reads it.
  connect?(url: string, key: string): Db
  readBack?(exported: unknown): unknown
}

// A refusal in plain words: printed as it is, and the run exits 1.
class Stop extends Error {}

const maskEmail = (email: string) => `${email.slice(0, 1)}***${email.slice(email.lastIndexOf('@'))}`

function parseArgv(argv: readonly string[]): { env: string; file: string; replace: boolean } {
  try {
    const { values } = parseArgs({ args: argv[0] === '--' ? argv.slice(1) : [...argv], options: { env: { type: 'string' }, file: { type: 'string' }, replace: { type: 'boolean', default: false } }, strict: true })
    if (values.env && values.file) return { env: values.env, file: values.file, replace: values.replace }
  } catch (error) {
    throw new Stop(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  }
  throw new Stop(USAGE)
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Stop(`Could not read the ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Only the two keys are kept; any other line in the file is skipped unread.
function readEnv(path: string): { url: string; key: string } {
  const found = new Map<string, string>()
  for (const line of readText(path, 'env file').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*?)\s*$/.exec(line)
    if (match?.[1] && match[2] !== undefined) found.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'))
  }
  const [url, key] = [found.get(URL_NAME) ?? '', found.get(KEY_NAME) ?? '']
  const missing = [url ? null : URL_NAME, key ? null : KEY_NAME].filter((name) => name !== null)
  if (missing.length > 0) throw new Stop(`${path} has no ${missing.join(' and no ')}.`)
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Stop(`${URL_NAME} in ${path} is not an http or https address.`)
  return { url: url.replace(/\/+$/, ''), key }
}

const problems = (path: string, issues: readonly string[]) => new Stop(`${path} is not a household Waypoint can import:\n${issues.map((i) => `  - ${i}`).join('\n')}`)

// The file as given, checked by core's import schema and then by the cross-table checks every export passes.
function readDoc(path: string): { raw: unknown; file: Snapshot } {
  let raw: unknown
  try {
    raw = JSON.parse(readText(path, 'household file'))
  } catch (error) {
    if (error instanceof Stop) throw error
    throw new Stop(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const checked = checkInput(importDoc, raw)
  if (!checked.ok) throw problems(path, checked.errors)
  try {
    return { raw, file: buildSnapshot(raw, todayIn(checked.value.household.timezone, Date.now()), []) }
  } catch (error) {
    if (error instanceof SnapshotError) throw problems(path, error.issues)
    throw error
  }
}

async function call<T>(db: Db, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Stop(`${fn} failed: ${error.message}`)
  return data as T
}

function rowCounts(doc: unknown): Record<Table, number> {
  const tables = (doc ?? {}) as Record<string, unknown>
  const counts = {} as Record<Table, number>
  for (const t of TABLES) {
    const rows = tables[t]
    counts[t] = Array.isArray(rows) ? rows.length : 0
  }
  return counts
}

const countsText = (counts: Record<string, number>) => Object.entries(counts).map(([table, n]) => `${table} ${n}`).join(', ')

// The households row alone: every other Waypoint row of the user goes with it through the tables' on-delete cascades.
export async function deleteHousehold(db: Db, userId: string): Promise<void> {
  const { data, error } = await db.from('households').delete().eq('id', userId).select('id')
  if (error) throw new Stop(`Could not delete the old household: ${error.message}. Nothing was imported.`)
  if (data.length !== 1) throw new Stop(`Deleting the old household removed ${data.length} households rows, not 1. Nothing was imported.`)
}

async function clearOld(db: Db, userId: string, replace: boolean, io: Io, url: string): Promise<void> {
  const { data, error } = await db.from('households').select('id')
  if (error) throw new Stop(`Could not read this account's household: ${error.message}`)
  if (data.length === 0) return
  if (!replace) throw new Stop(`This account already has a household at ${url}. Nothing changed. Run again with --replace to delete it and import the file in its place.`)
  const old = await call<unknown>(db, 'export_household')
  io.prompt.say(`This account's household at ${url} holds ${countsText(rowCounts(old))}. --replace deletes all of it, then imports the file.`)
  const answer = await io.prompt.ask('Type REPLACE to go on: ')
  if (answer.trim() !== 'REPLACE') throw new Stop('Nothing changed: the answer was not REPLACE.')
  await deleteHousehold(db, userId)
  io.prompt.say('Deleted the old household.')
}

interface Figure {
  kind: 'cash' | 'credit_card'
  currency: string
  minor: number
}

// A cash account's opening plus every row; a card's latest statement total less the card credits after its cut.
function figuresByName(snapshot: Snapshot): Map<string, Figure[]> {
  const index = snapshotIndex(snapshot)
  const out = new Map<string, Figure[]>()
  for (const a of snapshot.doc.accounts) {
    let minor: number
    if (a.kind === 'cash') minor = ledgerSum(snapshot, a.id, EVERY_DAY)
    else if (a.kind === 'credit_card') {
      const latest = index.statementsByAccount.get(a.id)?.at(-1)
      // With no statement the opening balance stands in, and a row on the opening day counts after it, as the card replay reads it.
      const total = latest ? latest.total_due_minor : 0 - a.opening_balance_minor
      const after = (day: string) => (latest ? day > latest.cut_date : day >= a.opening_date)
      minor = total - (index.rowsByAccount.get(a.id) ?? []).reduce((sum, t) => (t.amount_minor > 0 && after(t.posted_on) ? sum + t.amount_minor : sum), 0)
    } else continue
    out.set(a.name, [...(out.get(a.name) ?? []), { kind: a.kind, currency: a.currency, minor }].sort((x, y) => x.minor - y.minor))
  }
  return out
}

export interface Line {
  label: string
  file: string
  cloud: string
  difference: string
  same: boolean
}

function countLines(file: Snapshot, cloud: Snapshot): Line[] {
  const [f, c] = [{ households: 1, ...rowCounts(file.doc) }, { households: 1, ...rowCounts(cloud.doc) }]
  return Object.entries(f).map(([table, n]) => {
    const m = c[table as keyof typeof c]
    return { label: `rows: ${table}`, file: String(n), cloud: String(m), difference: String(m - n), same: m === n }
  })
}

// Accounts are matched by name; two accounts with one name are paired in order of their figures.
function figureLines(file: Snapshot, cloud: Snapshot): Line[] {
  const locale = file.doc.household.locale
  const [f, c] = [figuresByName(file), figuresByName(cloud)]
  const money = (x: Figure | undefined) => (x ? formatMoney(x.minor, x.currency, locale) : 'missing')
  const lines: Line[] = []
  for (const name of new Set([...f.keys(), ...c.keys()])) {
    const [fs, cs] = [f.get(name) ?? [], c.get(name) ?? []]
    const n = Math.max(fs.length, cs.length)
    for (let i = 0; i < n; i++) {
      const [x, y] = [fs[i], cs[i]]
      const kind = (x ?? y)?.kind === 'credit_card' ? 'card' : 'cash'
      const label = `${name} (${kind}${n > 1 ? `, ${i + 1} of ${n}` : ''})`
      const comparable = x !== undefined && y !== undefined && x.kind === y.kind && x.currency === y.currency
      const difference = comparable ? formatMoney(y.minor - x.minor, x.currency, locale) : x && y ? `${x.kind} ${x.currency} vs ${y.kind} ${y.currency}` : 'missing'
      lines.push({ label, file: money(x), cloud: money(y), difference, same: comparable && x.minor === y.minor })
    }
  }
  return lines
}

// Row counts per table, then each cash account and card by name.
export const compare = (file: Snapshot, cloud: Snapshot): Line[] => [...countLines(file, cloud), ...figureLines(file, cloud)]

function table(lines: readonly Line[]): string[] {
  const rows = [['account', 'file', 'cloud', 'difference'], ...lines.map((l) => [l.label, l.file, l.cloud, l.difference])]
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => (r[i] ?? '').length)))
  return rows.map((r) => r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join('  '))
}

function check(file: Snapshot, exported: unknown, io: Io): number {
  if (exported === null) {
    io.err('MISMATCH: the cloud has no household after the import.')
    return 1
  }
  let cloud: Snapshot
  try {
    cloud = buildSnapshot(exported, file.as_of, [])
  } catch (error) {
    if (!(error instanceof SnapshotError)) throw error
    io.err(`MISMATCH: the cloud's export is not a valid household: ${error.issues.join('; ')}`)
    return 1
  }
  const lines = compare(file, cloud)
  io.prompt.say('Read back from the cloud:')
  for (const line of table(lines)) io.prompt.say(line)
  if (lines.some((l) => !l.same)) {
    io.err('MISMATCH')
    return 1
  }
  io.prompt.say('OK: cloud matches the file')
  return 0
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let db: Db | null = null
  try {
    const args = parseArgv(argv)
    const env = readEnv(args.env)
    const { raw, file } = readDoc(args.file)
    io.prompt.say(`Importing ${args.file} into ${env.url}${args.replace ? ', replacing any household the account has' : ''}.`)
    const email = cleanEmail(await io.prompt.ask('Email: '))
    if (!looksLikeEmail(email)) throw new Stop('Enter a whole email address, like name@example.com.')
    const password = await io.prompt.secret('Password: ')
    if (password === '') throw new Stop('Enter the account’s password.')
    db = (io.connect ?? connect)(env.url, env.key)
    const { data, error } = await db.auth.signInWithPassword({ email, password })
    if (error || !data.user) throw new Stop(authProblem(error, 'login', env.url))
    io.prompt.say(`Signed in as ${maskEmail(email)}.`)
    await clearOld(db, data.user.id, args.replace, io, env.url)
    const imported = await call<{ ids: Record<string, Record<string, string>> }>(db, 'import_household', { p_doc: raw })
    io.prompt.say(`Imported: ${countsText({ households: 1, ...Object.fromEntries(TABLES.map((t) => [t, Object.keys(imported.ids[t] ?? {}).length])) })}.`)
    const exported = await call<unknown>(db, 'export_household')
    return check(file, io.readBack ? io.readBack(exported) : exported, io)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    if (db) await db.auth.signOut({ scope: 'local' })
  }
}

if (import.meta.main) {
  const prompt = linePrompt(process.stdin, process.stdout)
  const code = await main(process.argv.slice(2), { prompt, err: (line) => void process.stderr.write(`${line}\n`) })
  prompt.close()
  process.exit(code)
}
