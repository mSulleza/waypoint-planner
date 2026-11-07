import { isAuthError, isAuthRetryableFetchError, type GoTrueClient } from '@supabase/auth-js'
import type { QueryClient } from '@tanstack/react-query'
import { asDataError, DataError } from './errors'
import { HOUSEHOLD_KEY, queryClient } from './query'
import { getSupabase } from './supabase'

// Supabase Auth emails this many digits (otp_length in supabase/config.toml).
export const CODE_LENGTH = 6

export interface AuthDeps {
  auth: () => Pick<GoTrueClient, 'signInWithOtp' | 'verifyOtp' | 'signInWithPassword'>
  queryClient: QueryClient
}

const DEPS: AuthDeps = { auth: () => getSupabase().auth, queryClient }

export function cleanEmail(text: string): string {
  return text.trim()
}

// Only catches typing slips; the server decides what an address is.
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(text))
}

// A pasted '123 456' or '123-456' still reads as the code.
export function codeDigits(text: string): string {
  return text.replace(/\D/g, '').slice(0, CODE_LENGTH)
}

// send_to_account: a code only for an address that already has an account, as the delete page asks.
export type AuthStep = 'send' | 'send_to_account' | 'verify' | 'password'

// The server refuses a code for an unknown address with the same error it gives when sign-ups are off.
const NO_ACCOUNT = 'No Waypoint account uses this address. Check it, or use the address you signed up with.'

// Each refusal in the words a person would use; the server's own words stay in technical.
const MESSAGES: Record<string, string> = {
  otp_expired: 'That code is wrong or has expired. Check the newest email, or send a new code.',
  invalid_credentials: 'That email and password do not match.',
  validation_failed: 'Enter a whole email address, like name@example.com.',
  email_address_invalid: 'Enter a whole email address, like name@example.com.',
  over_email_send_rate_limit: 'Too many codes asked for. Wait a minute, then send a new one.',
  over_request_rate_limit: 'Too many tries. Wait a few minutes, then try again.',
  signup_disabled: 'Waypoint is not taking new accounts yet. Try a sample instead.',
  otp_disabled: 'Waypoint is not taking new accounts yet. Try a sample instead.',
  email_address_not_authorized: 'Waypoint cannot email this address yet. Try a sample instead.',
  user_banned: 'This account is closed.',
  email_not_confirmed: 'This address is not confirmed yet. Sign in with an emailed code instead.',
}

export function authProblem(error: unknown, step: AuthStep): DataError {
  if (isAuthRetryableFetchError(error)) return new DataError('network', 'Waypoint could not reach the server. Check the connection and try again.', { technical: error.message })
  if (!isAuthError(error)) return asDataError(error)
  const code = error.code ?? null
  const technical = `${error.message}${code ? ` (${code}${error.status ? `, HTTP ${error.status}` : ''})` : ''}`
  const unknown = step === 'send_to_account' && (code === 'otp_disabled' || code === 'signup_disabled')
  const message = unknown ? NO_ACCOUNT : ((code && MESSAGES[code]) ?? (step === 'verify' || step === 'password' ? 'Signing in did not work. Try again in a moment.' : 'The code could not be sent. Try again in a moment.'))
  return new DataError('rejected', message, { code, technical })
}

async function run(step: AuthStep, deps: AuthDeps, call: (auth: ReturnType<AuthDeps['auth']>) => Promise<{ error: unknown }>): Promise<DataError | null> {
  try {
    const { error } = await call(deps.auth())
    return error ? authProblem(error, step) : null
  } catch (error) {
    return authProblem(error, step)
  }
}

// One call for new and returning people: a new address gets an account, and both get a code by email.
export function sendCode(email: string, deps: AuthDeps = DEPS): Promise<DataError | null> {
  return run('send', deps, (auth) => auth.signInWithOtp({ email: cleanEmail(email), options: { shouldCreateUser: true } }))
}

// Never makes an account: a person deleting theirs must not get a new one by a typo.
export function sendCodeToAccount(email: string, deps: AuthDeps = DEPS): Promise<DataError | null> {
  return run('send_to_account', deps, (auth) => auth.signInWithOtp({ email: cleanEmail(email), options: { shouldCreateUser: false } }))
}

// The same account signing in again keeps its owner and query, so its household is asked for again here; a load already running is left to finish.
function signedIn(deps: AuthDeps, problem: DataError | null): DataError | null {
  if (!problem) void deps.queryClient.invalidateQueries({ queryKey: HOUSEHOLD_KEY }, { cancelRefetch: false })
  return problem
}

export async function verifyCode(email: string, code: string, deps: AuthDeps = DEPS): Promise<DataError | null> {
  return signedIn(deps, await run('verify', deps, (auth) => auth.verifyOtp({ email: cleanEmail(email), token: codeDigits(code), type: 'email' })))
}

// For the store reviewer and Mark's agent, the only accounts with passwords.
export async function signInWithPassword(email: string, password: string, deps: AuthDeps = DEPS): Promise<DataError | null> {
  return signedIn(deps, await run('password', deps, (auth) => auth.signInWithPassword({ email: cleanEmail(email), password })))
}
