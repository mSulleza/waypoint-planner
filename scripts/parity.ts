// Waypoint's figures on a household exported from the old app, each beside the old figure, its source and its tolerance (spec §13 step 3); saves parity-<as_of>.txt.
// Run from the repo root: WAYPOINT_HOUSEHOLD_JSON=<private dir>/<household>.json pnpm tsx scripts/parity.ts, with parity.json (old repo, account roles, old scripts) beside it.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  buildSnapshot,
  cardPreset,
  cardsOf,
  formatMoney,
  fxBreakeven,
  lastDayOfMonth,
  monthKey,
  nextAction,
  parseRates,
  plainNames,
  renderCopy,
  reviewList,
  runEngine,
  todayIn,
  toRatesPerEur,
  walkMetrics,
  type Milestone,
  type Rate,
  type Snapshot,
  type Walk,
} from '../packages/core/src/index'
import { calibrate, INTEREST_TOLERANCE, worstMissByLag, type CalibrationFile } from '../packages/core/test/calibration-helpers'

// Spec §13's tolerances (estimates).
const TOLERANCE = { margin_points: 2, months: 1, days: 5, lowest_minor: 30000, interest_share: 0.1, payment_minor: 100 }
const EXPORT_BUDGET_BYTES = 1_000_000
const RATES_URL = 'https://api.frankfurter.dev/v2/rates?base=EUR&providers=ECB'
// The funding currency's value as a multiple of today's, searched over core fxBreakeven's range at a finer step.
const [LOWEST_M, HIGHEST_M, M_STEP] = [0.5, 1.5, 0.0001]

interface Config {
  old_repo: string
  // The cash account money is sent from when it crosses currencies, and the one it tops up.
  accounts: { funding: string; topped_up: string }
  // The funding account's end-of-day level the old daily audit counts days under, in its minor units.
  threshold_minor: number
  // The last month the old scripts walk, YYYY-MM.
  through: string
  cycles: { from: string; to: string }
  payment_targets: string
  calibration: string
  old: { runway: string[]; daily: string[]; interest: string[] }
  // The old daily audit's line labels, which carry the accounts' names.
  labels: { days_under: string; funding_lowest: string; topped_up_lowest: string }
  before: { household: string; as_of: string; brief: { margin: number; breakeven: number; days_under: number; source: string } } | null
  // A named cause per row id, or per id prefix such as 'payment:card-x', printed under the tables.
  causes: Record<string, Cause>
}

// A cause's figures hold only for the rows it was measured on: `rows` keeps how each covered row read then (readingOf), so a later run flags the cause once a row reads otherwise.
interface Cause {
  measured_on: string
  rows: Record<string, string>
  text: string
  // A question only Mark can answer, such as a tolerance or a named difference to accept; its rows read 'needs Mark', not fail, and a pass it names keeps its pass but points to it.
  needs_mark?: boolean
}

interface Targets {
  cycles: { account_id: string; cut_month: string; target_minor: number }[]
}

type Result = 'pass' | 'fail' | 'not judged' | 'needs Mark'

interface Row {
  id: string
  figure: string
  waypoint: string
  old: string
  diff: string
  tolerance: string
  result: Result
  source: string
}

interface OldRun {
  command: string
  ran_at: string
  stdout: string | null
  error: string | null
}

function fail(message: string): never {
  console.error(`parity: ${message}`)
  process.exit(2)
}

const householdPath = process.env.WAYPOINT_HOUSEHOLD_JSON ?? fail('set WAYPOINT_HOUSEHOLD_JSON to the household export in the private directory')
const privateDir = dirname(resolve(householdPath))
const config = readConfig(join(privateDir, 'parity.json'))
function readConfig(path: string): Config {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Config
  } catch (error) {
    return fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const out: string[] = []
const print = (line = '') => {
  out.push(line)
  console.log(line)
}

// Rates of the latest ECB day, or of `day` for a run as of a past day.
async function ratesFor(day?: string) {
  const url = day ? `${RATES_URL}&date=${day}` : RATES_URL
  const response = await fetch(url)
  if (!response.ok) fail(`${url} answered ${response.status}`)
  return { url, rates: parseRates(await response.json()) }
}

function runOld(argv: string[]): OldRun {
  const command = argv.join(' ')
  const ran_at = new Date().toISOString()
  try {
    const stdout = execFileSync(argv[0] as string, argv.slice(1), { cwd: config.old_repo, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { command, ran_at, stdout, error: null }
  } catch (error) {
    const detail = error as { stderr?: string; message?: string }
    return { command, ran_at, stdout: null, error: (detail.stderr || detail.message || String(error)).trim().split('\n').slice(-3).join(' ') }
  }
}

// The text after `label` on the first line that starts with it, once trimmed.
function after(stdout: string | null, label: string): string | null {
  const line = stdout?.split('\n').find((l) => l.trim().startsWith(label))
  return line === undefined ? null : line.trim().slice(label.length)
}

const numbersIn = (text: string): number[] => [...text.matchAll(/[-−+]?\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '').replace('−', '-')))
const dayIn = (text: string): string | null => text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 'Mar 2028' or '2028-03' as YYYY-MM.
function monthIn(text: string): string | null {
  const iso = text.match(/\d{4}-\d{2}/)?.[0]
  if (iso) return iso
  const named = text.match(/([A-Z][a-z]{2})\w* (\d{4})/)
  const index = named ? MONTHS.indexOf(named[1] as string) : -1
  return named && index >= 0 ? `${named[2]}-${String(index + 1).padStart(2, '0')}` : null
}

const monthsApart = (a: string, b: string) => (Number(a.slice(0, 4)) - Number(b.slice(0, 4))) * 12 + Number(a.slice(5, 7)) - Number(b.slice(5, 7))
const nextMonth = (month: string) => {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
const percent = (share: number, digits = 1) => `${share >= 0 ? '+' : '−'}${Math.abs(share * 100).toFixed(digits)}%`
const points = (delta: number) => `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} pts`
const signed = (text: string, minor: number) => (minor > 0 ? `+${text}` : text)

function snapshotOf(path: string, asOf: string, rates: readonly Rate[]): { snapshot: Snapshot; walk: Walk } {
  const snapshot = buildSnapshot(JSON.parse(readFileSync(path, 'utf8')), asOf, rates)
  const run = runEngine(snapshot)
  if (!run.ok) fail(`the walk of ${basename(path)} failed at its ${run.stage}: ${JSON.stringify(run.errors)}`)
  return { snapshot: run.world.snapshot, walk: run.walk }
}

// Units of the topped-up account's currency per unit of the funding account's, at the snapshot's rates.
function rateOf(snapshot: Snapshot): { rate: number; quote: string; base: string } {
  const accounts = new Map(snapshot.doc.accounts.map((a) => [a.id, a]))
  const [base, quote] = [accounts.get(config.accounts.funding)?.currency, accounts.get(config.accounts.topped_up)?.currency]
  if (!base || !quote) fail('parity.json names an account the household lacks')
  const perEur = toRatesPerEur(snapshot.rates)
  const rate = (perEur[quote] ?? NaN) / (base === 'EUR' ? 1 : (perEur[base] ?? NaN))
  if (!Number.isFinite(rate)) fail(`no rate between ${base} and ${quote}`)
  return { rate, quote, base }
}

// The old app's rule, on core's walk: the lowest multiple of today's rate at which the topped-up account closes every month from this one through `through` at or above zero.
function monthEndBreakeven(snapshot: Snapshot): { multiplier: number; below_range: boolean } | null {
  const first = monthKey(snapshot.as_of)
  const holds = (m: number): boolean => {
    const run = runEngine(snapshot, { fx_shift_pct: Number((m - 1).toFixed(6)) }, 'metrics')
    if (!run.ok) throw new Error(`the walk at ${m} failed: ${JSON.stringify(run.errors)}`)
    const months = run.walk.figures.get(config.accounts.topped_up)
    if (!months) throw new Error(`the walk has no months for '${config.accounts.topped_up}'`)
    return months.every((f) => f.month < first || f.month > config.through || f.closing_minor >= 0)
  }
  if (!holds(HIGHEST_M)) return null
  if (holds(LOWEST_M)) return { multiplier: LOWEST_M, below_range: true }
  let [lo, hi] = [LOWEST_M, HIGHEST_M]
  while (hi - lo > M_STEP) {
    const mid = (lo + hi) / 2
    if (holds(mid)) hi = mid
    else lo = mid
  }
  return { multiplier: hi, below_range: false }
}

async function dayBreakeven(snapshot: Snapshot) {
  const found = await fxBreakeven(snapshot, { pause: async () => {} })
  if (found === null || !found.ok) return null
  return found
}

// End-of-day balances of one account from as_of through the last day of `through`.
function daysOf(walk: Walk, accountId: string): { day: string; minor: number }[] {
  const balances = walk.balances.get(accountId) ?? fail(`the walk has no days for '${accountId}'`)
  const last = lastDayOfMonth(config.through)
  return walk.days.flatMap((day, i) => (day <= last ? [{ day, minor: balances[i] ?? 0 }] : []))
}

const lowestOf = (days: { day: string; minor: number }[]) => days.reduce((low, d) => (d.minor < low.minor ? d : low))
const milestoneText = (m: Milestone) => (m.month ?? (m.after_horizon ? 'after the horizon' : m.last_owed_month === null ? 'nothing owed' : 'not known'))

function marginRows(prefix: string, snapshot: Snapshot, day: Awaited<ReturnType<typeof dayBreakeven>>, monthEnd: ReturnType<typeof monthEndBreakeven>, old: { margin: number; breakeven: number } | null, source: string): Row[] {
  const { rate, quote } = rateOf(snapshot)
  const money = (r: number) => formatMoney(Math.round(r * 100), quote, snapshot.doc.household.locale)
  const shown = (margin: number, breakeven: number, below = false) => `${below ? '≥ ' : ''}${percent(margin)} at ${money(breakeven)}`
  const oldText = old ? shown(old.margin, old.breakeven) : 'no figure'
  const judge = (margin: number | null): Pick<Row, 'diff' | 'result'> => {
    if (margin === null || old === null) return { diff: '', result: 'fail' }
    const delta = (margin - old.margin) * 100
    return { diff: points(delta), result: Math.abs(delta) <= TOLERANCE.margin_points ? 'pass' : 'fail' }
  }
  const dayMargin = day?.margin ?? null
  return [
    {
      id: `${prefix}fx-day`,
      figure: 'FX margin, no day below zero',
      waypoint: day ? shown(day.margin, rate * day.multiplier, day.below_range) : 'none',
      old: oldText,
      ...judge(dayMargin),
      tolerance: `${TOLERANCE.margin_points} pts`,
      source: `${source} · core fxBreakeven: no cash account ends any day below zero`,
    },
    {
      id: `${prefix}fx-month-end`,
      figure: 'FX margin, old month-end rule',
      waypoint: monthEnd ? shown(1 - monthEnd.multiplier, rate * monthEnd.multiplier, monthEnd.below_range) : 'none',
      old: oldText,
      ...judge(monthEnd ? 1 - monthEnd.multiplier : null),
      tolerance: `${TOLERANCE.margin_points} pts`,
      source: `${source} · on core's walk: ${config.accounts.topped_up} closes every month from ${monthKey(snapshot.as_of)} through ${config.through} at or above zero`,
    },
  ]
}

// The cause whose key is the row's id or a prefix of it, the longest first.
const causeOf = (id: string): [string, Cause] | null =>
  Object.entries(config.causes)
    .filter(([key]) => id === key || id.startsWith(`${key}:`))
    .sort(([a], [b]) => b.length - a.length)[0] ?? null

const readingOf = (r: Row) => `${r.waypoint} · ${r.old}`
// A cause stands for a row only while the row reads as it did when the cause was measured.
const causeStands = (r: Row) => causeOf(r.id)?.[1].rows[r.id] === readingOf(r)

// A pass that a question for Mark names by id: it holds only on a choice he has yet to approve, such as how card rows are dated.
function restsOnQuestion(r: Row) {
  const cause = causeOf(r.id)?.[1]
  return r.result === 'pass' && cause?.needs_mark === true && cause.rows[r.id] !== undefined
}

function noteOf(r: Row) {
  if (!causeOf(r.id) || (r.result === 'pass' && !restsOnQuestion(r))) return ''
  if (r.result === 'needs Mark') return ' (question below)'
  const what = r.result === 'pass' ? 'question below' : 'cause below'
  return causeStands(r) ? ` (${what})` : ` (${what}, re-measure)`
}

// Rows a standing cause marks for Mark become his questions, not failures; a changed reading keeps the row as judged.
function table(rows: Row[]) {
  for (const r of rows) if (r.result !== 'pass' && causeOf(r.id)?.[1].needs_mark && causeStands(r)) r.result = 'needs Mark'
  const widths = { figure: 34, waypoint: 26, old: 26, diff: 14, tolerance: 22 }
  const line = (r: Pick<Row, 'figure' | 'waypoint' | 'old' | 'diff' | 'tolerance'> & { result: string }) =>
    `${r.figure.padEnd(widths.figure)} ${r.waypoint.padEnd(widths.waypoint)} ${r.old.padEnd(widths.old)} ${r.diff.padEnd(widths.diff)} ${r.tolerance.padEnd(widths.tolerance)} ${r.result}`
  print(line({ figure: 'Figure', waypoint: 'Waypoint', old: 'Old app', diff: 'Difference', tolerance: 'Tolerance', result: 'Result' }))
  for (const r of rows) {
    print(line({ ...r, result: `${r.result.toUpperCase()}${noteOf(r)}` }))
    print(`    ${r.source}`)
  }
}

async function main() {
  const path = resolve(householdPath)
  const text = readFileSync(path, 'utf8')
  const doc = JSON.parse(text) as { household: { timezone: string }; accounts: { id: string; kind: string }[]; transactions: { account_id: string; posted_on: string }[] }
  const zone = doc.household.timezone
  const asOf = todayIn(zone, Date.now())
  const cash = new Set(doc.accounts.filter((a) => a.kind === 'cash').map((a) => a.id))
  const ledgerLatest = doc.transactions.filter((t) => cash.has(t.account_id)).reduce((latest, t) => (t.posted_on > latest ? t.posted_on : latest), '')
  const written = statSync(path).mtime
  const writtenAt = `${todayIn(zone, written)} ${new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(written)}`
  const bytes = Buffer.byteLength(text, 'utf8')

  const { url, rates } = await ratesFor()
  const { snapshot, walk } = snapshotOf(path, asOf, rates)
  const names = plainNames(snapshot)
  const locale = snapshot.doc.household.locale
  const accountName = (id: string) => names.account(id)
  const { rate, quote, base } = rateOf(snapshot)

  print(`Waypoint parity report — ${basename(path)}`)
  print(`  export        written ${writtenAt} (${zone}) · ${bytes.toLocaleString('en-US')} bytes of a ${EXPORT_BUDGET_BYTES.toLocaleString('en-US')} budget: ${bytes <= EXPORT_BUDGET_BYTES ? 'PASS' : 'FAIL'}`)
  print(`  old ledger    latest row posted ${ledgerLatest}`)
  print(`  as of         ${asOf}, today in ${zone} · ECB rates of ${snapshot.rates[0]?.day ?? '?'} from ${url} · 1 ${base} = ${rate} ${quote}`)
  print(`  old app       ${config.old_repo}, each script run now, read-only`)
  print()

  const runway = runOld(config.old.runway)
  const daily = runOld(config.old.daily)
  const interestRun = runOld(config.old.interest)
  for (const r of [runway, daily, interestRun]) print(`  ran ${r.command} at ${r.ran_at}${r.error ? ` — FAILED: ${r.error}` : ''}`)
  print()

  const rows: Row[] = []
  const breakevenLine = after(runway.stdout, 'FX breakeven')
  const breakevenNumbers = breakevenLine ? numbersIn(breakevenLine) : []
  const oldFx = breakevenNumbers.length >= 3 ? { breakeven: breakevenNumbers[0] as number, margin: (breakevenNumbers[1] as number) / 100, today: breakevenNumbers[2] as number } : null
  const runwaySource = `${config.old.runway.join(' ')} · 'FX breakeven' line${oldFx ? ` (today ${formatMoney(Math.round(oldFx.today * 100), quote, locale)})` : ''}`
  rows.push(...marginRows('', snapshot, await dayBreakeven(snapshot), monthEndBreakeven(snapshot), oldFx, runwaySource))

  // Interest at cuts after this month through `through`, so neither side counts a cut already printed or a month the other does not walk.
  const from = nextMonth(monthKey(asOf))
  const replays = cardsOf(walk)
  const printed = new Map(snapshot.doc.statements.map((s) => [s.id, s.interest_minor]))
  let interest = 0
  for (const replay of replays?.values() ?? []) {
    for (const s of replay.statements) {
      const month = monthKey(s.cut_date)
      if (month < from || month > config.through) continue
      interest += (s.source === 'entered' ? printed.get(s.id) : null) ?? s.model?.interest_minor ?? 0
    }
  }
  const oldMonths = (interestRun.stdout ?? '').split('\n').flatMap((l) => {
    const m = l.match(/^(\d{4}-\d{2})\s+\D*([\d,]+(?:\.\d+)?)/)
    return m ? [{ month: m[1] as string, minor: Math.round(Number((m[2] as string).replace(/,/g, '')) * 100) }] : []
  })
  const oldInterest = oldMonths.filter((m) => m.month >= from && m.month <= config.through).reduce((sum, m) => sum + m.minor, 0)
  const oldAll = oldMonths.reduce((sum, m) => sum + m.minor, 0)
  const interestLine = after(runway.stdout, 'total interest')
  const oldTotal = interestLine ? Math.round((numbersIn(interestLine)[0] ?? NaN) * 100) : NaN
  const oldFirst = oldMonths[0]?.month ?? '?'
  const share = oldInterest > 0 ? (interest - oldInterest) / oldInterest : NaN
  rows.push({
    id: 'interest',
    figure: `Interest, cuts ${from} to ${config.through}`,
    waypoint: formatMoney(interest, quote, locale),
    old: oldMonths.length ? formatMoney(oldInterest, quote, locale) : 'no figure',
    diff: Number.isFinite(share) ? percent(share) : '',
    tolerance: `${TOLERANCE.interest_share * 100}%`,
    result: Number.isFinite(share) && Math.abs(share) <= TOLERANCE.interest_share ? 'pass' : 'fail',
    source: `${config.old.interest.join(' ')} month rows ${from} to ${config.through}; all its rows sum to ${formatMoney(oldAll, quote, locale)}, ${Math.abs(oldAll - oldTotal) <= oldMonths.length * 50 ? 'matching' : 'NOT matching'} ${config.old.runway.join(' ')}'s 'total interest' ${Number.isFinite(oldTotal) ? formatMoney(oldTotal, quote, locale) : '?'}, which counts every month from ${oldFirst}`,
  })

  const metrics = walkMetrics(snapshot, walk)
  const oldCarryFree = interestLine ? monthIn(interestLine.slice(interestLine.indexOf('carry-free'))) : null
  const cleared = metrics.revolving_cleared.month
  const apart = cleared && oldCarryFree ? monthsApart(cleared, oldCarryFree) : null
  rows.push({
    id: 'revolving',
    figure: 'Revolving cleared',
    waypoint: milestoneText(metrics.revolving_cleared),
    old: oldCarryFree ?? 'no figure',
    diff: apart === null ? '' : `${apart > 0 ? '+' : ''}${apart} months`,
    tolerance: `${TOLERANCE.months} month`,
    result: apart !== null && Math.abs(apart) <= TOLERANCE.months ? 'pass' : 'fail',
    source: `${config.old.runway.join(' ')} · 'carry-free' on the 'total interest' line (first month with no carry)`,
  })

  const funding = daysOf(walk, config.accounts.funding)
  const toppedUp = daysOf(walk, config.accounts.topped_up)
  const fundingCurrency = snapshot.doc.accounts.find((a) => a.id === config.accounts.funding)?.currency ?? base
  const under = funding.filter((d) => d.minor < config.threshold_minor).length
  const traceLine = after(daily.stdout, 'daily trace:')
  const window = traceLine ? `its trace ${[...traceLine.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]).join(' to ')}` : 'its trace'
  const dailySource = (label: string) => `${config.old.daily.join(' ')} · '${label}' line, over ${window}; Waypoint ${asOf} to ${lastDayOfMonth(config.through)} from core's daily balances`
  const daysLine = after(daily.stdout, config.labels.days_under)
  const oldUnder = daysLine ? (numbersIn(daysLine)[0] ?? null) : null
  rows.push({
    id: 'days-under',
    figure: `Days ${accountName(config.accounts.funding)} ends under ${formatMoney(config.threshold_minor, fundingCurrency, locale)}`,
    waypoint: String(under),
    old: oldUnder === null ? 'no figure' : String(oldUnder),
    diff: oldUnder === null ? '' : `${under - oldUnder > 0 ? '+' : ''}${under - oldUnder}`,
    tolerance: `${TOLERANCE.days} days`,
    result: oldUnder !== null && Math.abs(under - oldUnder) <= TOLERANCE.days ? 'pass' : 'fail',
    source: dailySource(config.labels.days_under),
  })

  const lowestRow = (id: string, accountId: string, days: { day: string; minor: number }[], label: string, tolerance: number, toleranceText: string): Row => {
    const currency = snapshot.doc.accounts.find((a) => a.id === accountId)?.currency ?? base
    const low = lowestOf(days)
    const line = after(daily.stdout, label)
    const oldMinor = line ? Math.round((numbersIn(line)[0] ?? NaN) * 100) : NaN
    const oldDay = line ? dayIn(line) : null
    const diff = low.minor - oldMinor
    return {
      id,
      figure: `Lowest ${accountName(accountId)} day`,
      waypoint: `${formatMoney(low.minor, currency, locale)} on ${low.day}`,
      old: Number.isFinite(oldMinor) ? `${formatMoney(oldMinor, currency, locale)} on ${oldDay ?? '?'}` : 'no figure',
      diff: Number.isFinite(diff) ? signed(formatMoney(diff, currency, locale), diff) : '',
      tolerance: toleranceText,
      result: Number.isFinite(diff) && Math.abs(diff) <= tolerance ? 'pass' : 'fail',
      source: `${dailySource(label)}${oldDay !== null && oldDay < asOf ? ' (the old low is a past day)' : ''}`,
    }
  }
  const fundingTolerance = formatMoney(TOLERANCE.lowest_minor, fundingCurrency, locale)
  rows.push(lowestRow('lowest-funding', config.accounts.funding, funding, config.labels.funding_lowest, TOLERANCE.lowest_minor, fundingTolerance))
  // Spec §13 gives a tolerance for the funding account only, so the topped-up account's low is printed and not judged until Mark sets one.
  rows.push({ ...lowestRow('lowest-topped-up', config.accounts.topped_up, toppedUp, config.labels.topped_up_lowest, 0, 'none in spec §13'), result: 'not judged' })

  print('Figures judged against the old app')
  table(rows)
  print()

  // Each card's planned payment per cycle against the old plan's target, by cut month.
  const targets = JSON.parse(readFileSync(join(privateDir, config.payment_targets), 'utf8')) as Targets
  const paymentRows: Row[] = []
  const cards = snapshot.doc.accounts.filter((a) => a.kind === 'credit_card').sort((a, b) => a.sort_order - b.sort_order)
  for (const card of cards) {
    const replay = replays?.get(card.id)
    for (let month = config.cycles.from; month <= config.cycles.to; month = nextMonth(month)) {
      const statement = replay?.statements.find((s) => monthKey(s.cut_date) === month && s.payment !== null)
      const target = targets.cycles.find((t) => t.account_id === card.id && t.cut_month === month)
      const planned = statement?.payment?.planned_gross_minor ?? null
      const diff = planned === null || !target ? null : planned - target.target_minor
      paymentRows.push({
        id: `payment:${card.id}:${month}`,
        figure: `${card.name} ${month}${statement ? ` (cut ${statement.cut_date.slice(8)})` : ''}`,
        waypoint: planned === null ? 'no payment' : formatMoney(planned, card.currency, locale),
        old: target ? formatMoney(target.target_minor, card.currency, locale) : 'no figure',
        diff: diff === null ? '' : signed(formatMoney(diff, card.currency, locale), diff),
        tolerance: formatMoney(TOLERANCE.payment_minor, card.currency, locale),
        result: diff !== null && Math.abs(diff) <= TOLERANCE.payment_minor ? 'pass' : 'fail',
        source: `${config.payment_targets} target_minor (the old engine's applied payment plus the obligations that pay a line on the card) · Waypoint: the cycle's planned payment`,
      })
    }
  }
  print(`Card payment per cycle, ${config.cycles.from} to ${config.cycles.to}`)
  table(paymentRows)
  print()

  const review = reviewList(snapshot, walk)
  const action = nextAction({ snapshot, walk, review })
  print('No old figure, not judged')
  print(`  Debt-free             ${milestoneText(metrics.debt_free)}`)
  print(`  Next action           ${renderCopy(action.title, names)}${action.context.length ? ` — ${renderCopy(action.context, names)}` : ''}`)
  print()

  const beforeRows: Row[] = []
  if (config.before) {
    const before = config.before
    const beforePath = join(privateDir, before.household)
    const fetched = await ratesFor(before.as_of)
    const then = snapshotOf(beforePath, before.as_of, fetched.rates)
    const thenNames = plainNames(then.snapshot)
    const thenAction = nextAction({ snapshot: then.snapshot, walk: then.walk, review: reviewList(then.snapshot, then.walk) })
    const sends = then.walk.lines.filter((l) => l.source === 'top_up' && l.flags.includes('to_send') && l.amount_minor < 0 && monthKey(l.date) === monthKey(before.as_of))
    const briefRows = marginRows('before-', then.snapshot, await dayBreakeven(then.snapshot), monthEndBreakeven(then.snapshot), before.brief, before.brief.source)
    const thenUnder = daysOf(then.walk, config.accounts.funding).filter((d) => d.minor < config.threshold_minor).length
    const thenRate = rateOf(then.snapshot)
    beforeRows.push(...briefRows, {
      id: 'before-days-under',
      figure: `Days ${accountName(config.accounts.funding)} ends under ${formatMoney(config.threshold_minor, fundingCurrency, locale)}`,
      waypoint: String(thenUnder),
      old: String(before.brief.days_under),
      diff: `${thenUnder - before.brief.days_under > 0 ? '+' : ''}${thenUnder - before.brief.days_under}`,
      tolerance: `${TOLERANCE.days} days`,
      result: Math.abs(thenUnder - before.brief.days_under) <= TOLERANCE.days ? 'pass' : 'fail',
      source: `${before.brief.source} · Waypoint ${before.as_of} to ${lastDayOfMonth(config.through)}`,
    })
    print(`As of ${before.as_of}, from ${before.household} (${Buffer.byteLength(readFileSync(beforePath, 'utf8'), 'utf8').toLocaleString('en-US')} bytes) · ECB rates of ${then.snapshot.rates[0]?.day ?? '?'} · 1 ${thenRate.base} = ${thenRate.rate} ${thenRate.quote}`)
    print(`  Today's send          ${thenAction.kind === 'send' ? renderCopy(thenAction.title, thenNames) : `none (next action: ${renderCopy(thenAction.title, thenNames)})`}`)
    print(`  Dated remainder       ${thenAction.context.length ? renderCopy(thenAction.context, thenNames) : 'none'}`)
    for (const l of sends) print(`    to send ${l.date}  ${formatMoney(0 - l.amount_minor, then.snapshot.doc.accounts.find((a) => a.id === l.account_id)?.currency ?? base, locale)} from ${thenNames.account(l.account_id)}`)
    table(beforeRows)
    print()
  }

  // Each PH card's printed statements replayed on its preset: the private calibration test's figures, and the misses a tolerance is set from.
  const calibrationRows: Row[] = []
  const calibration = JSON.parse(readFileSync(join(privateDir, config.calibration), 'utf8')) as CalibrationFile
  for (const card of calibration.cards) {
    const tolerance = INTEREST_TOLERANCE[card.preset]
    const money = (minor: number) => formatMoney(minor, cardPreset(card.preset)?.currency ?? quote, locale)
    for (const fit of calibrate(card)) {
      const creditsDiff = fit.credits.listed - fit.credits.printed
      calibrationRows.push({
        id: `calibration:${card.preset}:credits:${fit.cut_date}`,
        figure: `${card.preset} ${fit.cut_date} credits listed`,
        waypoint: money(fit.credits.listed),
        old: money(fit.credits.printed),
        diff: signed(money(creditsDiff), creditsDiff),
        tolerance: 'exact',
        result: creditsDiff === 0 ? 'pass' : 'fail',
        source: `${config.calibration} printed payments and credits · the card rows the file lists for the cycle, the only credits the replay sees`,
      })
      const minimumDiff = fit.minimum.preset - fit.minimum.printed
      calibrationRows.push({
        id: `calibration:${card.preset}:minimum:${fit.cut_date}`,
        figure: `${card.preset} ${fit.cut_date} minimum`,
        waypoint: money(fit.minimum.preset),
        old: money(fit.minimum.printed),
        diff: signed(money(minimumDiff), minimumDiff),
        tolerance: 'exact',
        result: minimumDiff === 0 ? 'pass' : 'fail',
        source: `${config.calibration} printed minimum · the preset's minimum rule on the printed total`,
      })
      const miss = fit.interest.modelled - fit.interest.printed
      calibrationRows.push({
        id: `calibration:${card.preset}:interest:${fit.cut_date}`,
        figure: `${card.preset} ${fit.cut_date} interest`,
        waypoint: money(fit.interest.modelled),
        old: money(fit.interest.printed),
        diff: signed(money(miss), miss),
        tolerance: tolerance === null || tolerance === undefined ? 'not set yet' : money(tolerance),
        result: tolerance === null || tolerance === undefined ? 'not judged' : Math.abs(miss) <= tolerance ? 'pass' : 'fail',
        source: `${config.calibration} printed interest · the cycle replayed on the preset (payment lag ${cardPreset(card.preset)?.rules.interest.payment_effective_lag_days ?? '?'} days) from the statement before it, the first from its printed previous balance a month before`,
      })
    }
  }
  print('PH presets against the printed statements (packages/core/test/calibration.private.test.ts)')
  print('  The file dates no charges, so the replay holds credits only and cannot test interest on in-cycle purchases.')
  table(calibrationRows)
  print()
  print('Interest misses at each payment lag, modelled minus printed (recorded, not judged; * the preset\'s lag)')
  for (const card of calibration.cards) {
    const money = (minor: number) => formatMoney(minor, cardPreset(card.preset)?.currency ?? quote, locale)
    const own = cardPreset(card.preset)?.rules.interest.payment_effective_lag_days
    for (const l of worstMissByLag(card)) {
      print(`  ${card.preset.padEnd(8)} ${l.lag === own ? '*' : ' '}${l.lag} days  worst ${money(l.worst).padStart(10)}  ${l.misses.map((m) => signed(money(m), m)).join('  ')}`)
    }
  }
  print()

  const all = [...rows, ...paymentRows, ...beforeRows, ...calibrationRows]
  const failed = all.filter((r) => r.result === 'fail')
  const named = failed.filter((r) => causeOf(r.id))
  const standing = named.filter(causeStands).length
  const asked = all.filter((r) => r.result === 'needs Mark')
  print(`Summary: ${all.filter((r) => r.result === 'pass').length} pass (${all.filter(restsOnQuestion).length} resting on a question for Mark), ${failed.length} fail (${standing} with a cause measured on what they read now, ${named.length - standing} whose cause needs re-measuring, ${failed.length - named.length} with none), ${asked.length} needs Mark, ${all.filter((r) => r.result === 'not judged').length} not judged`)
  const causes = new Map<string, { cause: Cause; changed: Row[] }>()
  for (const r of all) {
    const found = r.result === 'pass' && !restsOnQuestion(r) ? null : causeOf(r.id)
    if (!found) continue
    const entry = causes.get(found[0]) ?? { cause: found[1], changed: [] }
    if (!causeStands(r)) entry.changed.push(r)
    causes.set(found[0], entry)
  }
  const printCauses = (title: string, list: [string, { cause: Cause; changed: Row[] }][]) => {
    if (!list.length) return
    print()
    print(title)
    for (const [key, { cause, changed }] of list) {
      print(`  ${key} (measured ${cause.measured_on}): ${cause.text}`)
      for (const r of changed) {
        const was = cause.rows[r.id]
        print(`    RE-MEASURE: ${r.id} now reads '${readingOf(r)}'${was === undefined ? ', not measured then' : `, measured as '${was}'`}; the figures above may no longer hold`)
      }
    }
  }
  printCauses('Needs Mark: questions only he can answer, not failures', [...causes].filter(([, c]) => c.cause.needs_mark))
  printCauses('Causes, each with the day it was measured', [...causes].filter(([, c]) => !c.cause.needs_mark))
  const unnamed = failed.filter((r) => !causeOf(r.id))
  if (unnamed.length) print(`No cause named yet: ${unnamed.map((r) => r.id).join(', ')}`)

  const saved = join(privateDir, `parity-${asOf}.txt`)
  writeFileSync(saved, `${out.join('\n')}\n`)
  console.log(`\nSaved ${saved}`)
}

main().catch((error: unknown) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
