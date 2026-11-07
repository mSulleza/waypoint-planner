import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FakeItem {
  service: string
  account: string
  password: string
}

export interface FakeKeychain {
  // Environment that puts the fake `security` first on PATH, for this process or a child.
  env: { PATH: string; FAKE_KEYCHAIN: string }
  items(): FakeItem[]
  // Every argument list the fake was started with.
  argv(): string[][]
  put(items: FakeItem[]): void
  remove(): void
}

const SCRIPT = fileURLToPath(new URL('./fake-security.mjs', import.meta.url))

export function fakeKeychain(): FakeKeychain {
  const dir = mkdtempSync(join(tmpdir(), 'waypoint-keychain-'))
  const file = join(dir, 'items.json')
  const bin = join(dir, 'security')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" "$@"\n`)
  chmodSync(bin, 0o755)
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  return {
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_KEYCHAIN: file },
    items: () => JSON.parse(read(file) || '[]') as FakeItem[],
    argv: () =>
      read(`${file}.argv`)
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    put: (items) => writeFileSync(file, JSON.stringify(items)),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
}
