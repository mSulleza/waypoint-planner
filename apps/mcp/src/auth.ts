import { createClient, isAuthError, isAuthRetryableFetchError } from '@supabase/supabase-js'
import type { Config } from './config'
import { AgentError } from './errors'
import type { Keychain } from './keychain'
import type { Prompt } from './prompt'

export const LOGIN_COMMAND = 'pnpm --filter @waypoint/mcp exec tsx src/cli.ts login'

type Step = 'login' | 'saved'

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password do not match. Use the password the account already has; login never sets one.',
  email_not_confirmed: 'This address is not confirmed yet. Confirm it from the sign-up email, then log in here.',
  validation_failed: 'Enter a whole email address, like name@example.com.',
  email_address_invalid: 'Enter a whole email address, like name@example.com.',
  over_request_rate_limit: 'Too many tries. Wait a few minutes, then try again.',
  user_banned: 'This account is closed.',
}

const FALLBACK: Record<Step, string> = {
  login: 'Signing in with that email and password did not work.',
  saved: 'Signing in with the saved password did not work.',
}

// The server's own words stay in brackets after the plain ones, without any token or password.
export function authProblem(error: unknown, step: Step, url: string): string {
  if (isAuthRetryableFetchError(error)) return `Could not reach ${url}. Check that it is running and reachable, then try again.`
  if (!isAuthError(error)) return `${FALLBACK[step]} (${error instanceof Error ? error.message : String(error)})`
  const code = error.code ?? null
  return `${(code && MESSAGES[code]) ?? FALLBACK[step]} (${error.message}${code ? `, ${code}` : ''})`
}

// Waypoint's tables and functions are in their own schema, so it can share a project whose public schema has other tables (spec §14).
const DB_SCHEMA = 'waypoint'

export function supabaseFor(config: Config, autoRefreshToken: boolean) {
  return createClient(config.url, config.key, { db: { schema: DB_SCHEMA }, auth: { autoRefreshToken, persistSession: false, detectSessionInUrl: false } })
}

// supabase-js typed for that schema; its plain SupabaseClient type names public.
export type Db = ReturnType<typeof supabaseFor>

export const cleanEmail = (text: string) => text.trim().toLowerCase()
export const looksLikeEmail = (text: string) => /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]+$/.test(text)

export interface LoginDeps {
  client(config: Config): Db
  keychain: Keychain
}

// The account's existing password in, the same password out to the Keychain: login only signs in, so another app sharing these users keeps working.
export async function login(config: Config, prompt: Prompt, deps: LoginDeps): Promise<string> {
  const db = deps.client(config)
  prompt.say(`Logging the agent in to ${config.ref === 'local' ? 'the local Supabase' : `project ${config.ref}`} at ${config.url} with the account's existing password. It never changes the password.`)
  const email = cleanEmail(await prompt.ask('Email: '))
  if (!looksLikeEmail(email)) throw new AgentError('Enter a whole email address, like name@example.com.')
  const password = await prompt.secret('Password: ')
  if (password === '') throw new AgentError('Enter the account’s password.')
  const { error } = await db.auth.signInWithPassword({ email, password })
  if (error) throw new AgentError(authProblem(error, 'login', config.url))
  try {
    await deps.keychain.save(config.service, { email, password })
  } finally {
    // This session only proved the password: each server signs in on its own.
    await db.auth.signOut({ scope: 'local' })
  }
  prompt.say(`Logged in as ${email}. The password is in the Keychain under ${config.service}. Start a new Claude Code session to use it.`)
  return email
}

export interface SessionDeps {
  client(config: Config): Db
  keychain: Keychain
  log(line: string): void
}

// One signed-in client per server process, so every Claude Code session refreshes its own tokens and never another's.
export class Session {
  private pending: Promise<Db> | null = null
  private current: Db | null = null

  constructor(
    readonly config: Config,
    private readonly deps: SessionDeps,
  ) {}

  client(): Promise<Db> {
    if (!this.pending) {
      const attempt = this.signIn()
      this.pending = attempt
      // A failed sign-in is tried again on the next call.
      attempt.catch(() => {
        if (this.pending === attempt) this.pending = null
      })
    }
    return this.pending
  }

  // The server refused this client's session: the next call signs in again with the saved password.
  drop(db: Db): void {
    if (this.current !== db) return
    this.current = null
    this.pending = null
    void db.auth.stopAutoRefresh()
  }

  private async signIn(): Promise<Db> {
    const saved = await this.deps.keychain.read(this.config.service)
    if (!saved) throw new AgentError(`The agent is not logged in to ${this.config.ref}: the Keychain has no ${this.config.service} item. Run, from the waypoint repo: ${LOGIN_COMMAND}`)
    const db = this.deps.client(this.config)
    const { error } = await db.auth.signInWithPassword(saved)
    if (error) {
      void db.auth.stopAutoRefresh()
      const changed = isAuthError(error) && error.code === 'invalid_credentials'
      throw new AgentError(changed ? `The saved password no longer signs in: the account's password changed after the login. Run login again with the current password: ${LOGIN_COMMAND} (${error.message}, invalid_credentials)` : authProblem(error, 'saved', this.config.url))
    }
    db.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED') this.deps.log('session refreshed')
      if (event === 'SIGNED_OUT') this.drop(db)
    })
    this.current = db
    this.deps.log(`signed in to ${this.config.ref}`)
    return db
  }
}
