// The longest main-thread task on the exported web build at 4x CPU slowdown (spec §11); exits 1 when a task runs over 50 ms.
// Run from the repo root: pnpm tsx scripts/perf.ts --scenario scrub [--no-build]
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Browser, type Page } from 'playwright-core'
import { SAMPLES } from '../packages/core/fixtures/samples'
import { addMonths, buildSnapshot, firstOfMonth, monthKey, todayIn } from '../packages/core/src/index'
import { amountLever, dayLever, encodeLevers, fxShiftLever, loanOfferLever, removeLever } from '../packages/core/src/compare'

const BUDGET_MS = 50
const CPU_SLOWDOWN = 4
const VIEWPORT = { width: 390, height: 844 }
const ROOT = join(import.meta.dirname, '..')
const DIST = join(ROOT, 'apps', 'app', 'dist')
// Written after a perf export, so --no-build never measures a build without the perf samples.
const MARK = join(DIST, 'perf-build.json')

interface Task {
  start: number
  duration: number
}

interface Window {
  label: string
  // Tasks the Long Tasks API reported, each over 50 ms by its definition.
  long: Task[]
  // The longest renderer main-thread task in a Chrome trace of the same window, which shows the headroom under the budget.
  longest: number
}

type Measure = (label: string, act: () => Promise<void>) => Promise<void>

interface Scenario {
  about: string
  run: (page: Page, open: (path: string) => Promise<void>, measure: Measure) => Promise<void>
}

const SCENARIOS: Record<string, Scenario> = {
  scrub: {
    about: 'drags across the kitchen chart, there and back, on each of its three spans',
    run: async (page, open, measure) => {
      await open('/dev/kitchen')
      const plot = page.locator('[role="img"][aria-label]').first()
      for (const span of ['12 months', '5 years', 'December']) {
        const label = await plot.getAttribute('aria-label', { timeout: 60_000 })
        await page.locator('[role="radio"]', { hasText: new RegExp(`^${span}$`) }).click()
        if (span !== '12 months') await page.waitForFunction((before) => document.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') !== before, label)
        await plot.scrollIntoViewIfNeeded()
        await page.waitForTimeout(1000)
        const box = await plot.boundingBox()
        if (!box) throw new Error('The kitchen chart has no box on screen')
        const y = box.y + box.height / 2
        await measure(`drag across ${span}`, async () => {
          await page.mouse.move(box.x + 2, y)
          await page.mouse.down()
          await page.mouse.move(box.x + box.width - 2, y, { steps: 60 })
          await page.mouse.move(box.x + 2, y, { steps: 60 })
          await page.mouse.up()
        })
      }
    },
  },
  ledger: {
    about: 'opens the 92-row month of the large household’s main account and wheels its ledger from top to bottom',
    run: async (page, open, measure) => {
      await open('/money/main?sample=mark-size')
      await page.getByText(/^Card spend \d+$/).first().waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1000)
      const { element, box } = await scrollerBox(page)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      const position = () => element.evaluate((e) => ({ top: e.scrollTop, end: e.scrollHeight - e.clientHeight }))
      await measure('wheel the ledger top to bottom', async () => {
        // Rows mount as the list nears them, so the end moves; stop once a few turns of the wheel move nothing.
        for (let still = 0, last = -1; still < 5; ) {
          await page.mouse.wheel(0, 120)
          await page.waitForTimeout(50)
          const { top } = await position()
          still = top === last ? still + 1 : 0
          last = top
        }
      })
      // Newest first, so the month's first row, Card spend 1 on the 1st, is the last one.
      await page.getByText('Card spend 1', { exact: true }).waitFor({ state: 'visible', timeout: 5000 })
    },
  },
  compare: {
    about: 'opens Compare on the abroad sample, then follows its address with 5 levers in the fragment and waits for every row and all together',
    run: async (page, open, measure) => {
      await open('/plan/compare?sample=abroad')
      await page.getByText('Pick a change to try').first().waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1500)
      const link = `${page.url().split('#')[0]}#l=${abroadLevers()}`
      // A fragment changes no document, so the bundle and the sample stay loaded and only Compare's walks run in the window.
      await measure('read 5 levers from the fragment and measure them', async () => {
        await page.goto(link)
        await page.waitForFunction(() => document.body.innerText.includes('All together') && !document.body.innerText.includes('Measuring…'), undefined, { timeout: 60_000 })
      })
      const cards = await page.getByRole('button', { name: /^Remove change: / }).count()
      if (cards !== 5) throw new Error(`Compare shows ${cards} levers, not 5`)
    },
  },
  plan: {
    about: 'opens Plan on the large household from its Money tab and waits while the FX breakeven and the income-gap walk run between frames',
    run: async (page, open, measure) => {
      // Money runs no projection, so every walk Plan needs starts inside the measured window.
      await open('/money?sample=mark-size')
      await page.getByText('Cards and loans').first().waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1500)
      await measure('open Plan while the breakeven runs', async () => {
        await page.locator('a[href^="/plan"]').first().click()
        await page.getByText('Breakeven rate').first().waitFor({ timeout: 60_000 })
        await page.waitForFunction(() => !document.body.innerText.includes('Calculating…'), undefined, { timeout: 60_000 })
      })
      await page.getByText(/^Months the money lasts if income stops$/).first().waitFor({ state: 'visible', timeout: 5000 })
    },
  },
}

// Five levers on the abroad sample as the app builds it today: rent and payday from next month, a weaker euro, a bill removed and a loan offer.
function abroadLevers(): string {
  const entry = SAMPLES.find((s) => s.id === 'abroad')
  if (!entry) throw new Error('No abroad sample')
  const asOf = todayIn(entry.build(todayIn('UTC', new Date())).doc.household.timezone, new Date())
  const { doc, rates } = entry.build(asOf)
  const snapshot = buildSnapshot(doc, asOf, rates)
  const next = monthKey(addMonths(firstOfMonth(asOf), 1))
  return encodeLevers([
    amountLever(snapshot, 'rent', 95000, next),
    dayLever(snapshot, 'salary', 20, next),
    fxShiftLever(snapshot, -0.1),
    removeLever(snapshot, 'mobile'),
    loanOfferLever(snapshot, { amount_minor: 5000000, term_months: 12, monthly_rate: 0.01, draw_month: next, to_account_id: 'pesos', card_id: 'rewards-card' }),
  ])
}

// The page's own scroller: the list a ledger screen draws as its body.
async function scrollerBox(page: Page) {
  const handle = await page.evaluateHandle(() =>
    [...document.querySelectorAll<HTMLElement>('#root *')].find((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 100 && e.clientHeight > 200),
  )
  const element = handle.asElement()
  if (!element) throw new Error('The ledger has no scrolling list on screen')
  const box = await element.boundingBox()
  if (!box) throw new Error('The ledger list has no box on screen')
  return { element, box }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
}

// Serves the export, and index.html for any path that is not a file, as a single-page host does.
function serve(dir: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    let file = normalize(join(dir, path))
    if (file !== dir && !file.startsWith(dir + sep)) {
      res.writeHead(403).end()
      return
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })))
}

interface TraceEvent {
  name: string
  ph: string
  pid: number
  tid: number
  dur?: number
  args?: { name?: string }
}

// The longest task on any renderer main thread in a trace, in ms.
function longestTask(trace: Buffer): number {
  const events = (JSON.parse(trace.toString('utf8')) as { traceEvents: TraceEvent[] }).traceEvents
  const main = new Set(events.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`))
  let longest = 0
  for (const e of events) if (e.name === 'RunTask' && e.ph === 'X' && main.has(`${e.pid}:${e.tid}`)) longest = Math.max(longest, (e.dur ?? 0) / 1000)
  return longest
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true })
  } catch (error) {
    console.error(`perf.ts needs the installed Google Chrome (playwright-core channel 'chrome') and could not start it:\n${(error as Error).message.split('\n')[0]}`)
    console.error('Install Google Chrome, then run this again.')
    process.exit(1)
  }
}

const { values } = parseArgs({ options: { scenario: { type: 'string' }, 'no-build': { type: 'boolean', default: false } } })
const name = values.scenario ?? ''
const scenario = SCENARIOS[name]
if (!scenario) {
  console.error(`Usage: pnpm tsx scripts/perf.ts --scenario <name> [--no-build]\nScenarios:\n${Object.entries(SCENARIOS)
    .map(([n, s]) => `  ${n}: ${s.about}`)
    .join('\n')}`)
  process.exit(2)
}

if (!values['no-build']) {
  // --clear: Metro's transform cache does not key on EXPO_PUBLIC_* values, so a warm cache could ship a build without the perf samples.
  execFileSync('pnpm', ['--filter', 'app', 'exec', 'expo', 'export', '-p', 'web', '--clear'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, EXPO_PUBLIC_PERF_SAMPLES: '1' } })
  writeFileSync(MARK, JSON.stringify({ perfSamples: true, builtAt: new Date().toISOString() }))
} else if (!existsSync(MARK)) {
  console.error('apps/app/dist is not a perf export (no perf-build.json); run without --no-build.')
  process.exit(1)
}

const { server, base } = await serve(DIST)
const browser = await launch()
const windows: Window[] = []
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })
  await context.addInitScript(() => {
    const w = window as unknown as { __longTasks: Task[] }
    w.__longTasks = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push({ start: e.startTime, duration: e.duration })
    }).observe({ type: 'longtask', buffered: true })
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN })
  const open = async (path: string) => {
    await page.goto(base + path, { waitUntil: 'load', timeout: 120_000 })
  }
  const measure: Measure = async (label, act) => {
    const start = await page.evaluate(() => performance.now())
    await browser.startTracing(page, { categories: ['disabled-by-default-devtools.timeline', 'devtools.timeline'] })
    await act()
    // Lets the last frames, the work they queued and the observer's callback run inside the window.
    await page.waitForTimeout(500)
    const trace = await browser.stopTracing()
    const end = await page.evaluate(() => performance.now())
    const long = await page.evaluate(([s, e]) => (window as unknown as { __longTasks: Task[] }).__longTasks.filter((t) => t.start >= s && t.start <= e), [start, end] as const)
    windows.push({ label, long, longest: longestTask(trace) })
  }
  await scenario.run(page, open, measure)
  if (errors.length > 0) throw new Error(`The page threw:\n${errors.join('\n')}`)
} finally {
  await browser.close()
  server.close()
}

const ms = (n: number) => `${n.toFixed(1)} ms`
console.log(`perf ${name}: ${scenario.about}; exported web build, ${CPU_SLOWDOWN}x CPU slowdown, ${VIEWPORT.width} x ${VIEWPORT.height}`)
for (const w of windows) {
  const over = w.long.length === 0 ? 'no task over 50 ms' : `${w.long.length} over 50 ms, the longest ${ms(Math.max(...w.long.map((t) => t.duration)))}`
  console.log(`  ${w.label}: ${over}; longest task ${ms(w.longest)}`)
}
const long = windows.flatMap((w) => w.long)
const longest = Math.max(0, ...windows.map((w) => w.longest))
const max = Math.max(0, ...long.map((t) => t.duration))
console.log(`Long tasks: ${long.length}, max ${long.length === 0 ? 'none' : ms(max)}. Longest task in a trace: ${ms(longest)}. Budget ${BUDGET_MS} ms: ${long.some((t) => t.duration > BUDGET_MS) ? 'over' : 'within'}.`)
if (long.some((t) => t.duration > BUDGET_MS)) process.exitCode = 1
