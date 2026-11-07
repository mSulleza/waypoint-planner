// Reads one PDF the way Fill from PDF does, to try a bank's statement or a shop's receipt by hand:
//   pnpm exec tsx apps/app/scripts/pdf-read-try.mts statement <file.pdf> [currency] [password]
//   pnpm exec tsx apps/app/scripts/pdf-read-try.mts receipt <file.pdf> [currency] [password]
// Without DEEPSEEK_API_KEY in the environment it stops before DeepSeek and prints what would be sent, in counts only, never the text.
import { readFileSync } from 'node:fs'
import { promptText, readPdf } from '../src/ai/pdf-read'
import { pdfText } from '../src/ai/pdf-text'

const [task, file, currency, password] = process.argv.slice(2)
if ((task !== 'statement' && task !== 'receipt') || !file) {
  console.error('Usage: pdf-read-try.mts statement|receipt <file.pdf> [currency] [password]')
  process.exit(2)
}
const bytes = new Uint8Array(readFileSync(file))
const text = await pdfText(bytes, password ?? null)
if (!text.ok) {
  console.log(`${file}: ${text.error}`)
  process.exit(1)
}
const { text: sent, clipped } = promptText(text.pages)
const masked = sent.match(/••••\d{4}/g)?.length ?? 0
const longRuns = sent.match(/\d(?:[ -]?\d){9,}/g)?.length ?? 0
console.log(`${file}: ${text.pages.length} pages read${text.more ? ', more left unread' : ''}; ${sent.length} characters for DeepSeek${clipped ? ', cut' : ''}; ${masked} numbers masked, ${longRuns} long digit runs left`)

const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.log('No DEEPSEEK_API_KEY, so nothing was sent.')
  process.exit(0)
}
const env = { supabase_url: undefined, supabase_key: undefined, deepseek_key: key, model: process.env.DEEPSEEK_MODEL, users: undefined }
const pdf = Buffer.from(bytes).toString('base64')
const out = await readPdf({ task, pdf, password: password ?? null, currency: currency ?? (task === 'statement' ? 'PHP' : 'EUR'), categories: [] }, env, fetch, pdfText)
console.log(JSON.stringify(out, null, 2))
