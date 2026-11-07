// A stand-in for macOS's security tool, for tests: the generic-password commands the agent uses, kept in a JSON file.
// FAKE_KEYCHAIN names the file; every call's arguments are appended to <file>.argv, so a test can check no secret was passed there.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const file = process.env.FAKE_KEYCHAIN
if (!file) {
  process.stderr.write('FAKE_KEYCHAIN is not set\n')
  process.exit(1)
}
appendFileSync(`${file}.argv`, `${JSON.stringify(process.argv.slice(2))}\n`)

const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [])
const store = (items) => writeFileSync(file, JSON.stringify(items))
const NOT_FOUND = 44

// -g is a flag; -s, -a and -X (the password as hex) take a value, as getopt reads them.
function flags(args) {
  const out = { U: false, g: false, s: undefined, a: undefined, X: undefined }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-U' || arg === '-g') out[arg[1]] = true
    else if (arg === '-s' || arg === '-a' || arg === '-X') out[arg[1]] = args[++i]
  }
  return out
}

// security's print_buffer: the bytes as upper-case hex after 0x when any is outside space to tilde or is a backslash, then the plain ones in quotes with the rest as octal escapes.
function printBuffer(bytes) {
  const plain = (b) => b >= 0x20 && b <= 0x7e && b !== 0x5c
  const hex = bytes.some((b) => !plain(b))
  const ascii = bytes.some(plain)
  let out = ''
  if (hex) out += `0x${Buffer.from(bytes).toString('hex').toUpperCase()}${ascii ? ' ' : ''} `
  if (ascii) out += `"${bytes.map((b) => (plain(b) ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`)).join('')}"`
  return out
}

const matches = (item, f) => item.service === f.s && (f.a === undefined || item.account === f.a)

function run(command, args) {
  const f = flags(args)
  const items = load()
  if (command === 'find-generic-password') {
    const item = items.find((i) => matches(i, f))
    if (!item) {
      process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n')
      return NOT_FOUND
    }
    process.stdout.write(`keychain: "/fake.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="${item.account}"\n    "svce"<blob>="${item.service}"\n`)
    if (f.g) process.stderr.write(`password: ${printBuffer([...Buffer.from(item.password, 'utf8')])}\n`)
    return 0
  }
  if (command === 'delete-generic-password') {
    const at = items.findIndex((i) => matches(i, f))
    if (at < 0) return NOT_FOUND
    items.splice(at, 1)
    store(items)
    return 0
  }
  if (command === 'add-generic-password') {
    const at = items.findIndex((i) => i.service === f.s && i.account === f.a)
    if (at >= 0 && !f.U) return 45
    const item = { service: f.s, account: f.a, password: Buffer.from(f.X ?? '', 'hex').toString('utf8') }
    if (at >= 0) items[at] = item
    else items.push(item)
    store(items)
    return 0
  }
  process.stderr.write(`fake security: unknown command ${command}\n`)
  return 1
}

const [first, ...rest] = process.argv.slice(2)
if (first === '-i') {
  // Interactive mode: one command per line on stdin, as the real tool reads them.
  const input = readFileSync(0, 'utf8')
  for (const line of input.split('\n')) {
    const words = line.trim().split(/\s+/).filter(Boolean)
    if (words.length > 0) run(words[0], words.slice(1))
  }
  process.exit(0)
}
process.exit(run(first, rest))
