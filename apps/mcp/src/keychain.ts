import { spawn } from 'node:child_process'

export interface Login {
  email: string
  password: string
}

export interface Keychain {
  read(service: string): Promise<Login | null>
  save(service: string, login: Login): Promise<void>
}

// security's exit code when no item matches.
const NOT_FOUND = 44

interface Ran {
  code: number
  stdout: string
  stderr: string
}

// macOS's own Keychain tool; secrets only ever travel on its stdin and stderr.
function security(args: readonly string[], input = ''): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => reject(new Error(`The macOS security tool did not start: ${error.message}`)))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(input)
  })
}

// The account attribute as security prints it: "acct"<blob>="name@example.com".
export function accountOf(attributes: string): string | null {
  return /^\s*"acct"<blob>="(.*)"\s*$/m.exec(attributes)?.[1] ?? null
}

// The line find-generic-password -g writes to stderr: "0x<HEX>" (then a quoted copy) when any byte is outside space to tilde or is a backslash, else the bytes in quotes.
export function passwordOf(printed: string): string | null {
  const line = /^password: (.*)$/m.exec(printed)?.[1]
  if (line === undefined) return null
  const hex = /^0x((?:[0-9A-F]{2})+)(?: |$)/.exec(line)
  if (hex?.[1]) return Buffer.from(hex[1], 'hex').toString('utf8')
  return /^"(.*)"$/.exec(line)?.[1] ?? null
}

// security -i splits its input on spaces and reads quotes, so the service and address may hold neither; the password goes as hex.
const PLAIN = /^[^\s"'\\]+$/

async function read(service: string): Promise<Login | null> {
  const found = await security(['find-generic-password', '-g', '-s', service])
  if (found.code === NOT_FOUND) return null
  if (found.code !== 0) throw new Error(`The Keychain could not be read: ${found.stderr.replace(/^password: .*$/gm, '').trim()}`)
  const email = accountOf(found.stdout)
  const password = passwordOf(found.stderr)
  if (!email || password === null) throw new Error(`The Keychain item ${service} has no account name or password.`)
  return { email, password }
}

// One login per project: any earlier item for this service goes, then the new one is written through security's stdin.
async function save(service: string, login: Login): Promise<void> {
  if (![service, login.email].every((v) => PLAIN.test(v))) throw new Error('The service or address holds a space or a quote, which the Keychain tool cannot take on its input.')
  for (let n = 0; n < 20; n++) {
    const gone = await security(['delete-generic-password', '-s', service])
    if (gone.code === NOT_FOUND) break
    if (gone.code !== 0) throw new Error(`The earlier Keychain item could not be removed: ${gone.stderr.trim()}`)
  }
  await security(['-i'], `add-generic-password -U -s ${service} -a ${login.email} -X ${Buffer.from(login.password, 'utf8').toString('hex')}\n`)
  const kept = await read(service)
  if (kept?.email !== login.email || kept.password !== login.password) throw new Error(`The Keychain did not keep the password under ${service}.`)
}

export const KEYCHAIN: Keychain = { read, save }
