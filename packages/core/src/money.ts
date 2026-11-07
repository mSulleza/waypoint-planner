import { toRatesPerEur, type Rate, type RatesPerEur } from './rates'

export interface Money {
  minor: number
  currency: string
}

export type Total = Money & ({ approx: false } | { approx: true; day: string })

export interface FormatOptions {
  mask?: boolean
  compact?: boolean
}

export const MASK = '•••'

const digitsCache = new Map<string, number>()

export function minorDigits(currency: string): number {
  let digits = digitsCache.get(currency)
  if (digits === undefined) {
    if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError(`Not an ISO 4217 code: ${currency}`)
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
    if (digits === undefined) throw new RangeError(`Intl gave no decimals for ${currency}`)
    digitsCache.set(currency, digits)
  }
  return digits
}

function checkMinor(minor: number): number {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`Not an integer amount in minor units: ${minor}`)
  return minor
}

interface LocaleNumbers {
  group: string
  decimal: string
  signPrefix: string
  primary: number
  secondary: number
  digits: Map<string, string>
}

const BIDI = /[\u200e\u200f\u061c]/g
const localeCache = new Map<string, LocaleNumbers>()

function localeNumbers(locale: string): LocaleNumbers {
  let found = localeCache.get(locale)
  if (!found) {
    const parts = new Intl.NumberFormat(locale).formatToParts(-123456789.5)
    const value = (type: Intl.NumberFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
    const groups = parts.filter((p) => p.type === 'integer').map((p) => p.value.length)
    const native = [...new Intl.NumberFormat(locale, { useGrouping: false }).format(9876543210).replace(BIDI, '')]
    found = {
      group: value('group'),
      decimal: value('decimal'),
      // A true minus sign, as wide as '+' in tabular figures, where the locale writes a hyphen.
      signPrefix: parts.slice(0, parts.findIndex((p) => p.type === 'integer')).map((p) => p.value).join('').replace('-', '\u2212'),
      primary: groups.at(-1) ?? 3,
      secondary: groups.length > 2 ? (groups[1] ?? 3) : (groups.at(-1) ?? 3),
      digits: new Map(native.map((ch, i) => [ch, String(9 - i)])),
    }
    localeCache.set(locale, found)
  }
  return found
}

const formatCache = new Map<string, Intl.NumberFormat>()

function moneyFormat(locale: string, currency: string, compact: boolean, display: 'symbol' | 'narrowSymbol' | 'code' = 'symbol'): Intl.NumberFormat {
  const key = `${locale}|${currency}|${compact}|${display}`
  let fmt = formatCache.get(key)
  if (!fmt) {
    const digits = minorDigits(currency)
    fmt = compact
      ? new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: display, notation: 'compact' })
      : new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: display, minimumFractionDigits: digits, maximumFractionDigits: digits })
    formatCache.set(key, fmt)
  }
  return fmt
}

// Compact is for chart axes only; every other figure shows the currency's full decimals.
export function formatMoney(minor: number, currency: string, locale: string, options: FormatOptions = {}): string {
  checkMinor(minor)
  if (options.mask) return MASK
  const body = moneyFormat(locale, currency, options.compact === true).format(Math.abs(minor) / 10 ** minorDigits(currency))
  return minor < 0 ? localeNumbers(locale).signPrefix + body : body
}

function currencyTokens(locale: string, currency: string): string[] {
  const displays = ['symbol', 'narrowSymbol', 'code'] as const
  const tokens = displays.map((d) => moneyFormat(locale, currency, false, d).formatToParts(1).find((p) => p.type === 'currency')?.value ?? currency)
  return [...new Set(tokens.map((t) => t.replace(BIDI, '').trim()))].filter(Boolean).sort((a, b) => b.length - a.length)
}

const SIGNS = new Set(['+', '-', '\u2212'])

// The only text-to-number boundary: returns integer minor units, or null for blank or unreadable text.
export function parseAmount(text: string, locale: string, currency: string): number | null {
  const digits = minorDigits(currency)
  const { group, decimal, primary, secondary, digits: native } = localeNumbers(locale)
  let s = [...text.replace(BIDI, '')].map((ch) => native.get(ch) ?? ch).join('')
  const token = currencyTokens(locale, currency).find((t) => s.includes(t))
  if (token) s = s.replace(token, ' ')
  s = s.trim()
  const sign = s[0] ?? ''
  const negative = SIGNS.has(sign) && sign !== '+'
  if (SIGNS.has(sign)) s = s.slice(1).trimStart()
  if (/\s/.test(group)) s = s.replace(/\s/g, group)
  else if (group === "'" || group === '\u2019') s = s.replace(/['\u2019]/g, group)
  const at = s.indexOf(decimal)
  const whole = at < 0 ? s : s.slice(0, at)
  const fraction = at < 0 ? '' : s.slice(at + decimal.length)
  if (whole + fraction === '' || !/^\d*$/.test(fraction)) return null
  const groups = whole === '' ? [] : group ? whole.split(group) : [whole]
  if (!groups.every((g) => /^\d+$/.test(g))) return null
  if (groups.length > 1) {
    const [first = '', ...rest] = groups
    const last = rest.pop() ?? ''
    if (first.length > secondary || last.length !== primary || rest.some((g) => g.length !== secondary)) return null
  }
  if (/[1-9]/.test(fraction.slice(digits))) return null
  const minor = BigInt(groups.join('') || '0') * 10n ** BigInt(digits) + BigInt(fraction.slice(0, digits).padEnd(digits, '0') || '0')
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null
  if (minor === 0n) return 0
  return negative ? -Number(minor) : Number(minor)
}

interface Ratio {
  n: bigint
  d: bigint
}

// A walk converts at a few rates thousands of times, so each number's decimal is read once; the memo empties past RATIO_MEMO numbers.
const RATIO_MEMO = 256
const ratios = new Map<number, Ratio>()

// The exact decimal a number was written as (70.203 is 70203/1000), so rates multiply without float error.
function ratio(x: number): Ratio {
  const known = ratios.get(x)
  if (known) return known
  if (!Number.isFinite(x)) throw new RangeError(`Not a finite number: ${x}`)
  const [mantissa = '0', exponent = '0'] = String(x).toLowerCase().split('e')
  const negative = mantissa.startsWith('-')
  const [whole = '0', fraction = ''] = mantissa.replace('-', '').split('.')
  const scale = fraction.length - Number(exponent)
  const n = BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale))
  const read = Object.freeze({ n: negative ? -n : n, d: 10n ** BigInt(Math.max(0, scale)) })
  if (ratios.size >= RATIO_MEMO) ratios.clear()
  ratios.set(x, read)
  return read
}

// Rounds num/den to an integer once, a tie going to the even neighbour.
function roundHalfEven(num: bigint, den: bigint): number {
  const negative = num < 0n !== den < 0n
  const [a, b] = [num < 0n ? -num : num, den < 0n ? -den : den]
  let q = a / b
  const twice = (a % b) * 2n
  if (twice > b || (twice === b && q % 2n === 1n)) q += 1n
  const out = Number(negative ? -q : q)
  if (!Number.isSafeInteger(out)) throw new RangeError('Amount beyond 2^53 minor units')
  return out
}

export type Rounding = 'half_up' | 'ceil'

// minor × factor ÷ divisor, rounded once to whole minor units; card interest and minimums use it, so it takes no negative amount.
export function scaleMinor(minor: number, factor: number, rounding: Rounding, divisor = 1): number {
  if (checkMinor(minor) < 0) throw new RangeError(`Cannot scale a negative amount: ${minor}`)
  if (!(factor >= 0)) throw new RangeError(`Factor must not be negative: ${factor}`)
  if (!(Number.isSafeInteger(divisor) && divisor > 0)) throw new RangeError(`Divisor must be a whole number above 0: ${divisor}`)
  const f = ratio(factor)
  const num = BigInt(minor) * f.n
  const den = f.d * BigInt(divisor)
  const q = rounding === 'ceil' ? (num + den - 1n) / den : (2n * num + den) / (2n * den)
  return checkMinor(Number(q))
}

// a > factor × b, exactly: the factor is read as the decimal it was written as, so a boundary case never flips on float error.
export function exceedsScaled(a: number, factor: number, b: number): boolean {
  if (!(factor >= 0)) throw new RangeError(`Factor must not be negative: ${factor}`)
  const f = ratio(factor)
  return BigInt(checkMinor(a)) * f.d > f.n * BigInt(checkMinor(b))
}

// The add-on EMI a bank quotes for a loan: principal × (1 + monthly rate × months) ÷ months, rounded half up once.
export function addOnInstallment(principal: number, monthlyRate: number, months: number): number {
  if (checkMinor(principal) <= 0) throw new RangeError(`A loan needs an amount above 0: ${principal}`)
  if (!(monthlyRate >= 0 && monthlyRate < 1)) throw new RangeError(`A monthly rate is a fraction from 0 to below 1, such as 0.01 for 1%: ${monthlyRate}`)
  if (!(Number.isSafeInteger(months) && months > 0)) throw new RangeError(`A loan term is a whole number of months above 0: ${months}`)
  const r = ratio(monthlyRate)
  const num = BigInt(principal) * (r.d + r.n * BigInt(months))
  const den = r.d * BigInt(months)
  return checkMinor(Number((2n * num + den) / (2n * den)))
}

function perEur(currency: string, rates: RatesPerEur): number | null {
  minorDigits(currency)
  if (currency === 'EUR') return 1
  const rate = rates[currency]
  if (rate === undefined) return null
  if (!(Number.isFinite(rate) && rate > 0)) throw new RangeError(`Bad rate for ${currency}: ${rate}`)
  return rate
}

// B per 1 A = rate[B] ÷ rate[A], scaled by 10^(target digits − source digits); null when either currency has no rate.
export function convert(minor: number, from: string, to: string, ratesPerEur: RatesPerEur): number | null {
  checkMinor(minor)
  if (from === to) return minor
  const [a, b] = [perEur(from, ratesPerEur), perEur(to, ratesPerEur)]
  if (a === null || b === null) return null
  const [ra, rb] = [ratio(a), ratio(b)]
  const shift = minorDigits(to) - minorDigits(from)
  const num = BigInt(minor) * rb.n * ra.d * 10n ** BigInt(Math.max(0, shift))
  const den = rb.d * ra.n * 10n ** BigInt(Math.max(0, -shift))
  return roundHalfEven(num, den)
}

// The minor-unit rate and fee for money leaving `from` into `to`; the same currency moves at rate 1 with no fee.
export function fxTerms(from: string, to: string, ratesPerEur: RatesPerEur, feePct: number): { rate: number; feePct: number } | null {
  if (from === to) return { rate: 1, feePct: 0 }
  const [a, b] = [perEur(from, ratesPerEur), perEur(to, ratesPerEur)]
  if (a === null || b === null) return null
  return { rate: (b / a) * 10 ** (minorDigits(to) - minorDigits(from)), feePct }
}

function feeAndRate(rate: number, feePct: number): Ratio {
  if (!(Number.isFinite(rate) && rate > 0)) throw new RangeError(`Rate must be above 0: ${rate}`)
  if (!(feePct >= 0 && feePct < 1)) throw new RangeError(`Fee must be a fraction from 0 to below 1: ${feePct}`)
  const [r, f] = [ratio(rate), ratio(feePct)]
  return { n: (f.d - f.n) * r.n, d: f.d * r.d }
}

// net = gross × (1 − fee) × rate in minor units, rounded once, half to even. There is no fixed fee.
export function netOf(gross: number, rate: number, feePct: number): number {
  if (rate === 1 && feePct === 0) return checkMinor(gross)
  const k = feeAndRate(rate, feePct)
  return roundHalfEven(BigInt(checkMinor(gross)) * k.n, k.d)
}

// The smallest gross whose net reaches `net`: the first gross at or past net − ½, exactly, so one gross less always falls short.
export function grossFor(net: number, rate: number, feePct: number): number {
  if (checkMinor(net) < 0) throw new RangeError(`A wanted net cannot be negative: ${net}`)
  if (rate === 1 && feePct === 0) return net
  const k = feeAndRate(rate, feePct)
  const num = (2n * BigInt(net) - 1n) * k.d
  const den = 2n * k.n
  const gross = num <= 0n ? 0 : Number((num + den - 1n) / den)
  // Landing exactly on net − ½ rounds down to the even neighbour when net is odd, so that gross needs one more unit.
  return netOf(gross, rate, feePct) >= net ? gross : gross + 1
}

export function netsByCurrency(amounts: readonly Money[]): Money[] {
  const nets = new Map<string, number>()
  for (const { minor, currency } of amounts) {
    minorDigits(currency)
    nets.set(currency, checkMinor((nets.get(currency) ?? 0) + checkMinor(minor)))
  }
  return [...nets].map(([currency, minor]) => ({ currency, minor }))
}

// One figure in the base currency; any conversion makes it approximate and dated by the oldest rate it used.
export function approxTotal(amounts: readonly Money[], base: string, rates: readonly Rate[]): Total | null {
  const perEurRates = toRatesPerEur(rates)
  const days = new Map(rates.map((r) => [r.quote, r.day]))
  let minor = 0
  let day: string | undefined
  for (const net of netsByCurrency(amounts)) {
    const converted = convert(net.minor, net.currency, base, perEurRates)
    if (converted === null) return null
    minor = checkMinor(minor + converted)
    if (net.currency === base) continue
    for (const used of [days.get(net.currency), days.get(base)]) if (used !== undefined && (day === undefined || used < day)) day = used
  }
  return day === undefined ? { minor, currency: base, approx: false } : { minor, currency: base, approx: true, day }
}
