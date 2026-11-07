import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { LOGIN_COMMAND, login, Session, supabaseFor, type Db } from '../src/auth'
import { configFrom, type Config } from '../src/config'
import { AgentError } from '../src/errors'
import type { Keychain, Login } from '../src/keychain'
import type { Prompt } from '../src/prompt'

const config = (configFrom({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }) as { ok: true; value: Config }).value
const EMAIL = 'agent@example.test'
// An existing password with the characters security -i would split on.
const PASSWORD = 'Existing pw "1" \\ é'

function memoryKeychain(start: Record<string, Login> = {}, fail = false): Keychain & { items: Record<string, Login> } {
  const items = { ...start }
  return {
    items,
    read: async (s) => items[s] ?? null,
    save: async (s, l) => {
      if (fail) throw new Error('The Keychain did not keep the password under waypoint-mcp:local.')
      items[s] = l
    },
  }
}

// Answers in order; records each question with the method that asked it.
function scripted(answers: string[]): Prompt & { shown: string[] } {
  const shown: string[] = []
  const answer = async (q: string) => {
    shown.push(q)
    const next = answers.shift()
    if (next === undefined) throw new Error('The input ended before an answer was given.')
    return next
  }
  return { shown, ask: (q) => answer(`ask ${q}`), secret: (q) => answer(`secret ${q}`), say: (line) => void shown.push(line) }
}

type Answers = Record<string, (args: unknown) => unknown>

// Every auth method any code calls is recorded, including ones the test never named, such as updateUser.
function recordingClient(answers: Answers = {}) {
  const calls: { fn: string; args: unknown }[] = []
  const auth = new Proxy(
    {},
    {
      get: (_target, fn: string) => (args: unknown) => {
        calls.push({ fn, args })
        return answers[fn] ? answers[fn](args) : Promise.resolve({ data: {}, error: null })
      },
    },
  )
  return { calls, fns: () => calls.map((c) => c.fn), client: { auth } as unknown as Db }
}

const refusing = (error: Error): Answers => ({ signInWithPassword: async () => ({ data: { user: null, session: null }, error }) })
const wrongPassword = () => new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')

describe('login', () => {
  it('signs in with the existing password, keeps that same password in the project’s Keychain item and never sets one', async () => {
    const server = recordingClient()
    const keychain = memoryKeychain()
    const prompt = scripted(['  Agent@Example.test ', PASSWORD])
    expect(await login(config, prompt, { client: () => server.client, keychain })).toBe(EMAIL)
    expect(server.calls).toEqual([
      { fn: 'signInWithPassword', args: { email: EMAIL, password: PASSWORD } },
      { fn: 'signOut', args: { scope: 'local' } },
    ])
    expect(keychain.items).toEqual({ 'waypoint-mcp:local': { email: EMAIL, password: PASSWORD } })
    expect(prompt.shown.filter((line) => line.startsWith('ask ') || line.startsWith('secret '))).toEqual(['ask Email: ', 'secret Password: '])
    expect(prompt.shown.some((line) => line.includes(PASSWORD))).toBe(false)
    expect(prompt.shown[0]).toContain('It never changes the password.')
    expect(prompt.shown.at(-1)).toBe(`Logged in as ${EMAIL}. The password is in the Keychain under waypoint-mcp:local. Start a new Claude Code session to use it.`)
  })

  it('refuses a wrong password in plain words and keeps nothing', async () => {
    const server = recordingClient(refusing(wrongPassword()))
    const keychain = memoryKeychain()
    await expect(login(config, scripted([EMAIL, 'not-it']), { client: () => server.client, keychain })).rejects.toThrow(
      new AgentError('That email and password do not match. Use the password the account already has; login never sets one. (Invalid login credentials, invalid_credentials)'),
    )
    expect(server.fns()).toEqual(['signInWithPassword'])
    expect(keychain.items).toEqual({})
  })

  it('signs the proving session out even when the Keychain refuses the password', async () => {
    const server = recordingClient()
    await expect(login(config, scripted([EMAIL, PASSWORD]), { client: () => server.client, keychain: memoryKeychain({}, true) })).rejects.toThrow('The Keychain did not keep the password')
    expect(server.fns()).toEqual(['signInWithPassword', 'signOut'])
  })

  it('names an unreachable server', async () => {
    const server = recordingClient(refusing(new AuthRetryableFetchError('fetch failed', 0)))
    await expect(login(config, scripted([EMAIL, PASSWORD]), { client: () => server.client, keychain: memoryKeychain() })).rejects.toThrow(
      'Could not reach http://127.0.0.1:54321. Check that it is running and reachable, then try again.',
    )
  })

  it('asks the server nothing for a broken address, an empty password or input that ends', async () => {
    for (const [answers, message] of [
      [['agent'], 'Enter a whole email address, like name@example.com.'],
      [[EMAIL, ''], 'Enter the account’s password.'],
      [[EMAIL], 'The input ended before an answer was given.'],
    ] as const) {
      const server = recordingClient()
      await expect(login(config, scripted([...answers]), { client: () => server.client, keychain: memoryKeychain() })).rejects.toThrow(message)
      expect(server.calls).toEqual([])
    }
  })

  it('never calls updateUser on any path, so another app sharing the account keeps its password', async () => {
    const paths: { answers: string[]; server: Answers; keychainFails?: boolean }[] = [
      { answers: [EMAIL, PASSWORD], server: {} },
      { answers: [EMAIL, 'not-it'], server: refusing(wrongPassword()) },
      { answers: [EMAIL, PASSWORD], server: refusing(new AuthApiError('Email not confirmed', 400, 'email_not_confirmed')) },
      { answers: [EMAIL, PASSWORD], server: {}, keychainFails: true },
      { answers: [EMAIL, PASSWORD], server: refusing(new AuthRetryableFetchError('fetch failed', 0)) },
      { answers: ['agent'], server: {} },
      { answers: [EMAIL, ''], server: {} },
    ]
    const seen = new Set<string>()
    for (const path of paths) {
      const server = recordingClient(path.server)
      await login(config, scripted([...path.answers]), { client: () => server.client, keychain: memoryKeychain({}, path.keychainFails) }).catch(() => null)
      for (const fn of server.fns()) seen.add(fn)
    }
    expect([...seen].sort()).toEqual(['signInWithPassword', 'signOut'])
  })
})

// The calls a server's session makes, with its auth-state listener kept so the test can fire events.
function passwordServer(refuse = false) {
  const made: ReturnType<typeof recordingClient>[] = []
  let listener: ((event: string) => void) | null = null
  const make = () => {
    const client = recordingClient({
      signInWithPassword: async () => ({ data: {}, error: refuse ? wrongPassword() : null }),
      onAuthStateChange: (fn) => ((listener = fn as (event: string) => void), { data: { subscription: { unsubscribe() {} } } }),
    })
    made.push(client)
    return client.client
  }
  const calls = () => made.flatMap((m) => m.calls)
  return {
    make,
    emit: (event: string) => listener?.(event),
    signIns: () => calls().filter((c) => c.fn === 'signInWithPassword').map((c) => c.args),
    fns: () => calls().map((c) => c.fn),
  }
}

describe('a server’s session', () => {
  const saved = { email: EMAIL, password: PASSWORD }

  it('asks for a login when the Keychain has none for the project', async () => {
    const server = passwordServer()
    const session = new Session(config, { client: server.make, keychain: memoryKeychain(), log: () => {} })
    await expect(session.client()).rejects.toThrow(`The agent is not logged in to local: the Keychain has no waypoint-mcp:local item. Run, from the waypoint repo: ${LOGIN_COMMAND}`)
    expect(server.fns()).toEqual([])
  })

  it('signs in once with the saved password and again only after the session ends, never changing it', async () => {
    const server = passwordServer()
    const logged: string[] = []
    const session = new Session(config, { client: server.make, keychain: memoryKeychain({ 'waypoint-mcp:local': saved }), log: (l) => void logged.push(l) })
    const first = await session.client()
    expect(await session.client()).toBe(first)
    server.emit('TOKEN_REFRESHED')
    server.emit('SIGNED_OUT')
    const second = await session.client()
    expect(second).not.toBe(first)
    expect(server.signIns()).toEqual([saved, saved])
    expect(server.fns()).toEqual(['signInWithPassword', 'onAuthStateChange', 'stopAutoRefresh', 'signInWithPassword', 'onAuthStateChange'])
    expect(logged).toEqual(['signed in to local', 'session refreshed', 'signed in to local'])
  })

  it('says the account’s password changed when the saved one is refused, and tries again on the next call', async () => {
    const server = passwordServer(true)
    const session = new Session(config, { client: server.make, keychain: memoryKeychain({ 'waypoint-mcp:local': saved }), log: () => {} })
    await expect(session.client()).rejects.toThrow(
      new AgentError(`The saved password no longer signs in: the account's password changed after the login. Run login again with the current password: ${LOGIN_COMMAND} (Invalid login credentials, invalid_credentials)`),
    )
    await expect(session.client()).rejects.toThrow('invalid_credentials')
    expect(server.fns()).toEqual(['signInWithPassword', 'stopAutoRefresh', 'signInWithPassword', 'stopAutoRefresh'])
  })
})

describe('supabaseFor', () => {
  it('sends database functions and table requests to the waypoint schema', async () => {
    const sent: Headers[] = []
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers))
      return Response.json([])
    })
    try {
      const db = supabaseFor(config, false)
      await db.rpc('export_household')
      await db.from('households').select('id')
      expect(sent.map((h) => [h.get('content-profile'), h.get('accept-profile')])).toEqual([
        ['waypoint', null],
        [null, 'waypoint'],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
