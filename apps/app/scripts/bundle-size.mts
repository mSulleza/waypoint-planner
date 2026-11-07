// Exports the web build and gzips the JavaScript its index.html loads; exits 1 above the budget. Run from apps/app: pnpm bundle-size.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Bytes after gzip -9: an estimate of the first load, since hosts pick their own compression.
const BUDGET = 500_000

const app = join(import.meta.dirname, '..')
const out = mkdtempSync(join(tmpdir(), 'waypoint-web-'))
const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`

try {
  // --clear: Metro's transform cache does not key on EXPO_PUBLIC_* values, so a warm cache can ship another build's code.
  execFileSync('pnpm', ['exec', 'expo', 'export', '-p', 'web', '--clear', '--output-dir', out], { cwd: app, stdio: ['ignore', 'ignore', 'inherit'] })
  const html = readFileSync(join(out, 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"|<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? '')
  if (scripts.length === 0) throw new Error('index.html loads no script; the export changed shape')
  let total = 0
  for (const src of scripts) {
    const code = readFileSync(join(out, src.replace(/^\//, '')))
    const gz = gzipSync(code, { level: 9 }).length
    total += gz
    console.log(`${src}  ${kB(code.length)} raw  ${kB(gz)} gzipped`)
  }
  const verdict = total <= BUDGET ? 'within' : 'over'
  console.log(`Web JavaScript loaded by index.html: ${kB(total)} gzipped (estimate), ${verdict} the ${kB(BUDGET)} budget`)
  if (total > BUDGET) process.exitCode = 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
