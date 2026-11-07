import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeDigits, looksLikeEmail, sendCode, sendCodeToAccount, signInWithPassword, verifyCode, type AuthDeps } from './auth'
import { SUPABASE_KEY } from './query'
import { createWaypointClient, storedUserId } from './supabase'
import { memoryStorage, SESSION } from './test-helpers'

const URL_BASE = 'http://127.0.0.1:54321'
const KEY = 'sb_publishable_test-key'

interface Sent {
  path: string
  body: Record<string, unknown>
}

type Reply = { status: number; body: unknown } | 'offline'

// Bodies as the local Supabase Auth server answered curl on 8 Oct 2026; the wait in TOO_SOON is the hosted 60 s, not the local 1 s.
const WRONG_CODE = { status: 403, body: { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' } }
const WRONG_PASSWORD = { status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }
const SIGNUPS_OFF = { status: 422, body: { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' } }
const TOO_SOON = { status: 429, body: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 59 seconds.' } }

// Stands in for the auth endpoints: one reply per path, and a record of what was sent.
function server(replies: Record<string, Reply>) {
  const sent: Sent[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname.replace('/auth/v1/', '')
    sent.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const reply = replies[path]
    if (reply === 'offline') throw new TypeError('Failed to fetch')
    if (!reply) return Response.json({}, { status: 404 })
    return Response.json(reply.body, { status: reply.status })
  }
  return { sent, fetchImpl }
}

function deps(replies: Record<string, Reply>) {
  const { sent, fetchImpl } = server(replies)
  const client = createWaypointClient(URL_BASE, KEY, { storage: globalThis.localStorage, fetch: fetchImpl })
  const queryClient = new QueryClient()
  // A household query already in the cache, as the gate's useSnapshot leaves it.
  queryClient.setQueryData([...SUPABASE_KEY, 0], { kind: 'signed_out' })
  const d: AuthDeps = { auth: () => client.auth, queryClient }
  const invalidated = () => queryClient.getQueryState([...SUPABASE_KEY, 0])?.isInvalidated ?? false
  return { d, sent, invalidated }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendCode', () => {
  it('asks for a code that also creates the account, for the address as typed less its spaces', async () => {
    const { d, sent } = deps({ otp: { status: 200, body: {} } })
    expect(await sendCode('  new@example.test ', d)).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.path).toBe('otp')
    expect(sent[0]!.body).toMatchObject({ email: 'new@example.test', create_user: true })
    expect(storedUserId()).toBeNull()
  })

  it('says plainly when sign-ups are off, when codes come too fast, and when the server is out of reach', async () => {
    const off = await sendCode('new@example.test', deps({ otp: SIGNUPS_OFF }).d)
    expect([off?.kind, off?.code, off?.message]).toEqual(['rejected', 'otp_disabled', 'Waypoint is not taking new accounts yet. Try a sample instead.'])
    const soon = await sendCode('a@example.test', deps({ otp: TOO_SOON }).d)
    expect([soon?.code, soon?.message]).toEqual(['over_email_send_rate_limit', 'Too many codes asked for. Wait a minute, then send a new one.'])
    expect(soon?.technical).toBe('For security purposes, you can only request this after 59 seconds. (over_email_send_rate_limit, HTTP 429)')
    const offline = await sendCode('a@example.test', deps({ otp: 'offline' }).d)
    expect([offline?.kind, offline?.message]).toEqual(['network', 'Waypoint could not reach the server. Check the connection and try again.'])
  })
})

describe('sendCodeToAccount', () => {
  it('asks for a code that never creates an account, and names an unknown address as such', async () => {
    const { d, sent } = deps({ otp: { status: 200, body: {} } })
    expect(await sendCodeToAccount(' a@example.test', d)).toBeNull()
    expect(sent[0]!.body).toMatchObject({ email: 'a@example.test', create_user: false })
    // The local server's answer for an address with no account, with create_user false.
    const unknown = await sendCodeToAccount('nobody@example.test', deps({ otp: SIGNUPS_OFF }).d)
    expect([unknown?.kind, unknown?.code, unknown?.message]).toEqual(['rejected', 'otp_disabled', 'No Waypoint account uses this address. Check it, or use the address you signed up with.'])
    const soon = await sendCodeToAccount('a@example.test', deps({ otp: TOO_SOON }).d)
    expect(soon?.message).toBe('Too many codes asked for. Wait a minute, then send a new one.')
  })
})

describe('verifyCode', () => {
  it('signs in with the emailed code as type email, keeps the session on the device and reloads the household', async () => {
    const { d, sent, invalidated } = deps({ verify: { status: 200, body: SESSION } })
    expect(await verifyCode('a@example.test', '123 456', d)).toBeNull()
    expect(sent.map((s) => [s.path, s.body.email, s.body.token, s.body.type])).toEqual([['verify', 'a@example.test', '123456', 'email']])
    expect(storedUserId()).toBe('user-a')
    expect(invalidated()).toBe(true)
  })

  it('reads a wrong or expired code as one plain sentence, signs nobody in and leaves the household alone', async () => {
    const { d, invalidated } = deps({ verify: WRONG_CODE })
    const problem = await verifyCode('a@example.test', '000000', d)
    expect([problem?.kind, problem?.code, problem?.message]).toEqual(['rejected', 'otp_expired', 'That code is wrong or has expired. Check the newest email, or send a new code.'])
    expect(problem?.technical).toBe('Token has expired or is invalid (otp_expired, HTTP 403)')
    expect(storedUserId()).toBeNull()
    expect(invalidated()).toBe(false)
  })
})

describe('signInWithPassword', () => {
  it('signs a reviewer in with a password', async () => {
    const { d, sent } = deps({ token: { status: 200, body: SESSION } })
    expect(await signInWithPassword('a@example.test', 'reviewer-password', d)).toBeNull()
    expect(sent[0]!.body).toMatchObject({ email: 'a@example.test', password: 'reviewer-password' })
    expect(storedUserId()).toBe('user-a')
  })

  it('names a wrong password without saying which half was wrong', async () => {
    const problem = await signInWithPassword('a@example.test', 'nope', deps({ token: WRONG_PASSWORD }).d)
    expect([problem?.code, problem?.message]).toEqual(['invalid_credentials', 'That email and password do not match.'])
    expect(storedUserId()).toBeNull()
  })
})

describe('typing', () => {
  it('takes the six digits out of whatever was pasted', () => {
    expect(codeDigits('123 456')).toBe('123456')
    expect(codeDigits('Your code: 123-456')).toBe('123456')
    expect(codeDigits('1234567')).toBe('123456')
    expect(codeDigits('12a')).toBe('12')
  })

  it('catches an address with no @ or no domain before asking the server', () => {
    expect(looksLikeEmail(' name@example.com ')).toBe(true)
    for (const bad of ['', 'name', 'name@', 'name@example', '@example.com', 'na me@example.com']) expect(looksLikeEmail(bad), bad).toBe(false)
  })
})
