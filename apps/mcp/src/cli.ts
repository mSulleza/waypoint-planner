import { login, Session, supabaseFor } from './auth'
import { readConfig } from './config'
import { messageOf } from './errors'
import { KEYCHAIN } from './keychain'
import { PRICES_USAGE, parsePricesArgs, refreshPrices } from './prices'
import { linePrompt } from './prompt'
import { parseWeeklyArgs, weeklyRun, WEEKLY_USAGE } from './weekly'

async function main(command: string | undefined, args: readonly string[]): Promise<number> {
  if (command === 'prices') return prices(args)
  if (command === 'weekly') return weekly(args)
  if (command !== 'login') {
    process.stderr.write(`Usage: tsx src/cli.ts login\nSigns the agent in with the account's existing email and password and keeps them in the macOS Keychain under waypoint-mcp:<project ref>. It never changes the password.\n\n${PRICES_USAGE}\nReads the current Mercadona price of each item linked to a Mercadona product, one every 2 seconds, and saves it with today's date.\n\n${WEEKLY_USAGE}\nThe Friday run: the prices, then new recipes from the web app's meals helper.\n`)
    return 2
  }
  const config = readConfig()
  if (!config.ok) {
    process.stderr.write(`${config.problem}\n`)
    return 1
  }
  const prompt = linePrompt(process.stdin, process.stdout)
  try {
    await login(config.value, prompt, { client: (c) => supabaseFor(c, false), keychain: KEYCHAIN })
    return 0
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`)
    return 1
  } finally {
    prompt.close()
  }
}

// The Mercadona refresh, signed in with the agent's saved login.
async function prices(args: readonly string[]): Promise<number> {
  const config = readConfig()
  if (!config.ok) {
    process.stderr.write(`${config.problem}\n`)
    return 1
  }
  const session = new Session(config.value, { client: (c) => supabaseFor(c, false), keychain: KEYCHAIN, log: () => undefined })
  try {
    const options = parsePricesArgs(args)
    const db = await session.client()
    const say = (line: string) => void process.stdout.write(`${line}\n`)
    const result = await refreshPrices({ db, fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date(), say }, options)
    await db.auth.signOut({ scope: 'local' })
    return result.failed > 0 ? 1 : 0
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`)
    return 1
  }
}

// The Friday run, signed in with the agent's saved login.
async function weekly(args: readonly string[]): Promise<number> {
  const config = readConfig()
  if (!config.ok) {
    process.stderr.write(`${config.problem}\n`)
    return 1
  }
  const session = new Session(config.value, { client: (c) => supabaseFor(c, false), keychain: KEYCHAIN, log: () => undefined })
  try {
    const options = parseWeeklyArgs(args)
    const db = await session.client()
    const say = (line: string) => void process.stdout.write(`${new Date().toISOString().slice(0, 16)} ${line}\n`)
    const result = await weeklyRun({ db, fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date(), say }, options, config.value.web_url)
    await db.auth.signOut({ scope: 'local' })
    return result.failed > 0 ? 1 : 0
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`)
    return 1
  }
}

process.exit(await main(process.argv[2], process.argv.slice(3)))
