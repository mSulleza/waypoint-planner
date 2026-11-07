import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Session, supabaseFor } from './auth'
import { readConfig } from './config'
import { DailyRates, fetchRates, Household } from './data'
import { AgentError } from './errors'
import { KEYCHAIN } from './keychain'
import { createServer, type ServerDeps } from './server'

// stdout carries MCP frames only; logs go to stderr.
const log = (line: string) => process.stderr.write(`waypoint-mcp: ${line}\n`)

function deps(): ServerDeps {
  const config = readConfig()
  if (!config.ok) {
    log(config.problem)
    const missing = () => Promise.reject(new AgentError(config.problem))
    return { world: missing, send: missing }
  }
  const session = new Session(config.value, { client: (c) => supabaseFor(c, true), keychain: KEYCHAIN, log })
  // Signing in starts with the server; a failure is reported by the first tool call, which tries again.
  session.client().catch((error: unknown) => log(error instanceof Error ? error.message : String(error)))
  const household = new Household(session, new DailyRates(fetchRates(config.value.rates_url)), config.value.web_url)
  return { world: () => household.load(), send: (request) => household.send(request) }
}

await createServer(deps()).connect(new StdioServerTransport())
// Claude Code closing the pipe ends the server, so no orphan keeps refreshing tokens.
process.stdin.on('end', () => process.exit(0))
log('ready')
