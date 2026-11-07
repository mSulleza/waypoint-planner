import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountOf, KEYCHAIN, passwordOf } from '../src/keychain'
import { fakeKeychain, type FakeKeychain } from './fake-keychain'

const SERVICE = 'waypoint-mcp:local'
let fake: FakeKeychain

beforeEach(() => {
  fake = fakeKeychain()
  vi.stubEnv('PATH', fake.env.PATH)
  vi.stubEnv('FAKE_KEYCHAIN', fake.env.FAKE_KEYCHAIN)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fake.remove()
})

describe('the Keychain login', () => {
  it('reads the account from the attributes security prints', () => {
    const printed = 'keychain: "/Users/x/Library/Keychains/login.keychain-db"\nattributes:\n    0x00000007 <blob>="waypoint-mcp:local"\n    "acct"<blob>="agent@example.test"\n    "svce"<blob>="waypoint-mcp:local"\n'
    expect(accountOf(printed)).toBe('agent@example.test')
    expect(accountOf('attributes:\n    "acct"<blob>=<NULL>\n')).toBeNull()
  })

  it('reads the password from the line find-generic-password -g prints, in each of print_buffer’s forms', () => {
    expect(passwordOf('password: "Q2x-9fK_c1"\n')).toBe('Q2x-9fK_c1')
    expect(passwordOf('password: "pw with "quotes" and spaces "\n')).toBe('pw with "quotes" and spaces ')
    // A backslash or a byte outside space to tilde turns on the hex form, with the printable bytes quoted after it.
    expect(passwordOf('password: 0x615C62  "a\\134b"\n')).toBe('a\\b')
    expect(passwordOf('password: 0x70C3A9  "p\\303\\251"\n')).toBe('pé')
    expect(passwordOf('password: 0xC3A9 \n')).toBe('é')
    // Quoted text that looks like hex stays text.
    expect(passwordOf('password: "0x41"\n')).toBe('0x41')
    expect(passwordOf('keychain: "/x"\n')).toBeNull()
  })

  it('is null before any login for the project', async () => {
    expect(await KEYCHAIN.read(SERVICE)).toBeNull()
  })

  it('writes the password as hex only on the tool’s input and reads back exactly what was saved', async () => {
    for (const password of ['Q2x-9fK_c1', 'Existing pw "1" \\ é', "it's", '12345678', '0x41', 'plain-ascii~']) {
      const login = { email: 'agent@example.test', password }
      await KEYCHAIN.save(SERVICE, login)
      expect(await KEYCHAIN.read(SERVICE)).toEqual(login)
      expect(fake.items()).toEqual([{ service: SERVICE, account: login.email, password }])
      const hex = Buffer.from(password, 'utf8').toString('hex')
      expect(fake.argv().flat().some((arg) => arg.includes(password) || arg.includes(hex))).toBe(false)
    }
    expect(fake.argv()).toContainEqual(['-i'])
  })

  it('keeps one login per project and leaves other projects alone', async () => {
    fake.put([
      { service: SERVICE, account: 'old@example.test', password: 'old-Pw1' },
      { service: 'waypoint-mcp:abcdefghijklmnopqrst', account: 'cloud@example.test', password: 'cloud-Pw1' },
    ])
    await KEYCHAIN.save(SERVICE, { email: 'new@example.test', password: 'new-Pw1' })
    expect(fake.items()).toEqual([
      { service: 'waypoint-mcp:abcdefghijklmnopqrst', account: 'cloud@example.test', password: 'cloud-Pw1' },
      { service: SERVICE, account: 'new@example.test', password: 'new-Pw1' },
    ])
    expect(await KEYCHAIN.read('waypoint-mcp:abcdefghijklmnopqrst')).toEqual({ email: 'cloud@example.test', password: 'cloud-Pw1' })
  })

  it('refuses an address the tool’s input would split', async () => {
    await expect(KEYCHAIN.save(SERVICE, { email: 'a b@example.test', password: 'x-Pw1' })).rejects.toThrow('The service or address holds a space or a quote')
    expect(fake.items()).toEqual([])
  })
})
