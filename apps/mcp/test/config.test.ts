import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { configFrom, projectRef, RATES_URL, readEnv } from '../src/config'

describe('the project ref', () => {
  it('is local for a stack on this machine and the ref for a hosted project, so the two logins sit side by side', () => {
    expect(projectRef('http://127.0.0.1:54321')).toBe('local')
    expect(projectRef('http://localhost:54321')).toBe('local')
    expect(projectRef('http://[::1]:54321')).toBe('local')
    expect(projectRef('https://abcdefghijklmnopqrst.supabase.co')).toBe('abcdefghijklmnopqrst')
    expect(projectRef('https://db.example.com:8443')).toBe('db.example.com:8443')
  })
})

describe('the configuration', () => {
  it('names the Keychain item after the project and trims the web address', () => {
    const result = configFrom({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', WAYPOINT_WEB_URL: 'http://localhost:8090/' })
    expect(result).toEqual({
      ok: true,
      value: { url: 'http://127.0.0.1:54321', key: 'sb_publishable_x', web_url: 'http://localhost:8090', rates_url: RATES_URL, ref: 'local', service: 'waypoint-mcp:local' },
    })
  })

  it('says which variables are missing', () => {
    expect(configFrom({ SUPABASE_URL: 'http://127.0.0.1:54321' })).toEqual({ ok: false, problem: expect.stringContaining('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY') })
    expect(configFrom({ SUPABASE_URL: 'not a url', SUPABASE_PUBLISHABLE_KEY: 'k' })).toEqual({ ok: false, problem: 'SUPABASE_URL is not a web address: not a url' })
  })

  it('fills what the process leaves unset from the env file, and an empty variable stays empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waypoint-env-'))
    try {
      const file = join(dir, '.env.local')
      writeFileSync(file, 'SUPABASE_URL=http://127.0.0.1:54321\nSUPABASE_PUBLISHABLE_KEY=from-file\nWAYPOINT_WEB_URL=http://localhost:8090\n')
      const env = readEnv({ SUPABASE_PUBLISHABLE_KEY: 'from-process', WAYPOINT_WEB_URL: '' }, pathToFileURL(file))
      expect(env).toMatchObject({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'from-process', WAYPOINT_WEB_URL: '' })
      expect(readEnv({}, pathToFileURL(join(dir, 'missing')))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
