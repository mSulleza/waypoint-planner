import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export const RATES_URL = 'https://api.frankfurter.dev/v2/rates?base=EUR&providers=ECB'
export const SERVICE_PREFIX = 'waypoint-mcp:'

// Values the process does not set come from this ignored file, so the repo's .mcp.json needs no secrets.
export const ENV_FILE = new URL('../.env.local', import.meta.url)

export interface Config {
  url: string
  key: string
  // The web app's address, for links to the screen a tool answers from; null when unset.
  web_url: string | null
  rates_url: string
  // 'local' for a stack on this machine, the project ref for a hosted project, else the host.
  ref: string
  // The Keychain item that holds this project's login.
  service: string
}

export type ConfigResult = { ok: true; value: Config } | { ok: false; problem: string }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

// Names the project so local and cloud logins each keep their own Keychain item.
export function projectRef(url: string): string {
  const { hostname, host } = new URL(url)
  if (LOOPBACK.has(hostname)) return 'local'
  const hosted = /^([a-z0-9]{20})\.supabase\.co$/.exec(hostname)
  return hosted?.[1] ?? host
}

// Variables the process sets win; an empty one stays empty, so a test can unset what the file holds.
export function readEnv(env: NodeJS.ProcessEnv = process.env, file: URL = ENV_FILE): Record<string, string | undefined> {
  const saved = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  return { ...saved, ...env }
}

export function configFrom(env: Record<string, string | undefined>): ConfigResult {
  const url = env.SUPABASE_URL?.trim() ?? ''
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
  if (!url || !key) {
    return { ok: false, problem: 'The Waypoint agent server needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, from its environment or apps/mcp/.env.local.' }
  }
  let ref: string
  try {
    ref = projectRef(url)
  } catch {
    return { ok: false, problem: `SUPABASE_URL is not a web address: ${url}` }
  }
  const web = env.WAYPOINT_WEB_URL?.trim().replace(/\/+$/, '') || null
  return { ok: true, value: { url, key, web_url: web, rates_url: env.WAYPOINT_RATES_URL?.trim() || RATES_URL, ref, service: `${SERVICE_PREFIX}${ref}` } }
}

export const readConfig = (): ConfigResult => configFrom(readEnv())
