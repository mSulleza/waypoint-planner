import {
  addDays,
  addMonths,
  buildSnapshot,
  CARD_BEHAVIOURS,
  CARD_PRESETS,
  cardPreset,
  checkInput,
  daysInMonth,
  firstOfMonth,
  importDoc,
  minorDigits,
  monthKey,
  parseAmount,
  SCHEMA_VERSION,
  SnapshotError,
  termsFromPreset,
  todayIn,
  type CardBehaviour,
  type ImportDocInput,
} from '@waypoint/core'

// Spec §7: five questions, one per step, then one import_household call.
export type Every = 'month' | '2weeks' | 'week'
export type DebtKind = 'none' | 'card' | 'loan'
// What the person pays on the card each month; '' until they say.
export type Pays = '' | 'minimum' | 'full' | 'extra'

// Everything as the person typed it; readDraft parses each amount once, in the household locale.
export interface Draft {
  currency: string
  timezone: string
  name: string
  account_currency: string
  balance: string
  floor: string
  income: string
  every: Every
  // A monthly payday as a day of the month; a weekly or fortnightly one as the date picked.
  payday_day: string
  payday_date: string
  living: string
  debt: DebtKind
  preset: string
  owed: string
  cut_day: string
  due_day: string
  pays: Pays
  // On top of the minimum, each month, in the card's currency.
  extra: string
  loan_balance: string
  payment: string
  rate: string
  payment_day: string
}

export type ErrorKey = 'currency' | 'timezone' | 'name' | 'account_currency' | 'balance' | 'floor' | 'income' | 'payday' | 'living' | 'preset' | 'owed' | 'cut_day' | 'due_day' | 'pays' | 'extra' | 'loan_balance' | 'payment' | 'rate' | 'payment_day' | 'doc'

export type Errors = Partial<Record<ErrorKey, string>>

export const STEP_COUNT = 5

// The step each answer is asked on; 'doc' is a check of the whole household, shown on the last step.
export const STEP_OF: Record<ErrorKey, number> = {
  currency: 0,
  timezone: 0,
  name: 1,
  account_currency: 1,
  balance: 1,
  floor: 1,
  income: 2,
  payday: 2,
  living: 3,
  preset: 4,
  owed: 4,
  cut_day: 4,
  due_day: 4,
  pays: 4,
  extra: 4,
  loan_balance: 4,
  payment: 4,
  rate: 4,
  payment_day: 4,
  doc: 4,
}

// Document ids; import_household gives each a fresh uuid.
export const IDS = { main: 'main', card: 'card', loan: 'loan', living: 'living', pay: 'pay', livingCosts: 'living-costs', cardExtra: 'card-extra' } as const

export const DEFAULT_PRESET = 'generic-in-full'

// Regions whose currency code does not start with the region code; every other region is found in OWN_CURRENCY.
const SHARED_CURRENCY =
  'EUR:AD AT AX BE BG BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM TF VA XK YT|USD:AS BQ EC FM GU IO MH MP PR PW SV TC TL UM VG VI|GBP:GG IM JE|CHF:LI|AUD:CC CX HM KI NF NR TV|NZD:CK NU PN TK|DKK:FO GL|NOK:BV SJ|XOF:BF BJ CI GW ML NE SN TG|XAF:CF CG CM GA GQ TD|XCD:AG AI DM GD KN LC MS VC|XPF:NC PF WF|MAD:EH|ILS:PS'

// ISO 4217 codes that begin with their region's code (PHP for PH).
const OWN_CURRENCY =
  'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST YER ZAR ZMW'

let shared: Map<string, string> | null = null

// The currency a region uses, or '' when Waypoint does not know it.
export function currencyOfRegion(region: string): string {
  if (!/^[A-Z]{2}$/.test(region)) return ''
  if (!shared) {
    shared = new Map()
    for (const group of SHARED_CURRENCY.split('|')) {
      const [code = '', regions = ''] = group.split(':')
      for (const r of regions.split(' ')) shared.set(r, code)
    }
  }
  return shared.get(region) ?? OWN_CURRENCY.split(' ').find((c) => c.startsWith(region)) ?? ''
}

// The region of a locale tag ('en-PH' is PH); a tag with none takes Intl's likeliest one when the engine knows it.
export function regionOf(locale: string): string {
  try {
    if (typeof Intl.Locale === 'function') return new Intl.Locale(locale).maximize().region ?? ''
  } catch {
    // An unreadable tag falls through to the plain reading.
  }
  return /[-_]([A-Z]{2})(?:[-_]|$)/.exec(locale)?.[1] ?? ''
}

export function initialDraft(locale: string, timeZone: string): Draft {
  const currency = currencyOfRegion(regionOf(locale))
  return {
    currency,
    timezone: timeZone,
    name: 'Main account',
    account_currency: currency,
    balance: '',
    // Blank reads as 0, so typing a floor never starts after a 0.
    floor: '',
    income: '',
    every: 'month',
    payday_day: '',
    payday_date: '',
    living: '',
    debt: 'none',
    preset: DEFAULT_PRESET,
    owed: '',
    cut_day: '',
    due_day: '',
    pays: '',
    extra: '',
    loan_balance: '',
    payment: '',
    rate: '',
    payment_day: '',
  }
}

// A three-letter ISO 4217 code, upper-cased; the engine checks it against Intl's list when it has one.
export function readCurrency(text: string): { code: string } | { error: string } {
  const code = text.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return { error: 'Enter a three-letter currency code, such as EUR or USD.' }
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : null
  if (known && !known.includes(code)) return { error: `Waypoint does not know the currency ${code}. Check the code.` }
  return { code }
}

// The IANA name Intl uses for a zone, so 'europe/madrid' is saved as Europe/Madrid.
export function readTimeZone(text: string): string | null {
  const zone = text.trim()
  if (zone === '') return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

function readDay(text: string): number | null {
  const match = /^\s*(\d{1,2})\s*$/.exec(text)
  const day = match ? Number(match[1]) : NaN
  return day >= 1 && day <= 31 ? day : null
}

// A yearly rate typed in percent ('6.9' or '6,9') as the fraction it stands for, written as that exact decimal.
export function readPercent(text: string): number | null {
  const match = /^\s*(\d{1,2})(?:[.,](\d{1,4}))?\s*%?\s*$/.exec(text)
  if (!match) return null
  const whole = (match[1] ?? '').padStart(2, '0')
  return Number(`0.${whole}${match[2] ?? ''}`)
}

// 1250.50 written the way this locale and currency write it: '1250,50' in es-ES, '1250' in yen.
function example(locale: string, currency: string): string {
  const digits = minorDigits(currency)
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.'
  return digits === 0 ? '1250' : `1250${decimal}${'5'.padEnd(digits, '0')}`
}

const dayOf = (month: string, day: number) => `${monthKey(month)}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`

// The first payday after today on day `day` (the month's last day when it is shorter), and the start that keeps a 31st on every month's last day.
export function monthlyPayday(today: string, day: number): { next: string; starts_on: string } {
  let month = firstOfMonth(today)
  if (dayOf(month, day) <= today) month = addMonths(month, 1)
  let anchor = month
  while (daysInMonth(anchor) < day) anchor = addMonths(anchor, -1)
  return { next: dayOf(month, day), starts_on: dayOf(anchor, day) }
}

// A weekly or fortnightly payday is one of the next 7 or 14 days; pay that arrived today is already in the balance.
export function paydayChoices(today: string, every: Exclude<Every, 'month'>): string[] {
  return Array.from({ length: every === 'week' ? 7 : 14 }, (_, i) => addDays(today, i + 1))
}

export interface PresetOption {
  id: string
  title: string
  // The card's currency (a preset fitted to one bank sets it) and its interest rate.
  detail: string
  currency: string | null
}

// What each behaviour does, as a person reads it over the list of cards.
export const BEHAVIOUR_TITLES: Record<CardBehaviour, string> = {
  'Pays in full each month': 'Interest only if you do not pay in full',
  'Revolving, interest on the average daily balance': 'Interest on the average balance you carry',
  'Revolving, interest daily on the unpaid statement balance': 'Interest every day on what you leave unpaid',
}

// Spec §7: listed by behaviour first, each with its bank variants under it, by their plain titles.
export function presetGroups(locale: string): { behaviour: CardBehaviour; heading: string; options: PresetOption[] }[] {
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 })
  return CARD_BEHAVIOURS.map((behaviour) => ({
    behaviour,
    heading: BEHAVIOUR_TITLES[behaviour],
    options: CARD_PRESETS.filter((p) => p.behaviour === behaviour).map((p) => ({
      id: p.id,
      title: p.title,
      detail: `${p.currency ?? 'Any currency'} · ${percent.format(p.rules.interest.rate)} a ${p.rules.interest.period}`,
      currency: p.currency,
    })),
  }))
}

// A preset fitted to one bank carries that bank's currency; a generic card takes the main account's.
export function cardCurrency(presetId: string, mainCurrency: string): string {
  return cardPreset(presetId)?.currency ?? mainCurrency
}

export interface Reading {
  // Today in the chosen time zone; null until the zone reads.
  today: string | null
  errors: Errors
  // The whole household, checked by core; null while any answer has an error.
  doc: ImportDocInput | null
}

export function firstStepWithError(errors: Errors): number | null {
  const steps = (Object.keys(errors) as ErrorKey[]).map((k) => STEP_OF[k])
  return steps.length === 0 ? null : Math.min(...steps)
}

export function stepErrors(errors: Errors, step: number): Errors {
  return Object.fromEntries(Object.entries(errors).filter(([k]) => STEP_OF[k as ErrorKey] === step))
}

// Every answer read at once: amounts through core parseAmount in the household locale and the account's currency, then one document core accepts.
export function readDraft(draft: Draft, locale: string, now: Date): Reading {
  const errors: Errors = {}
  const fail = (key: ErrorKey, message: string) => {
    errors[key] ??= message
    return null
  }
  const base = readCurrency(draft.currency)
  if ('error' in base) fail('currency', base.error)
  const timezone = readTimeZone(draft.timezone)
  if (timezone === null) fail('timezone', 'Enter a time zone such as Europe/Madrid.')
  const today = timezone === null ? null : todayIn(timezone, now)

  const name = draft.name.trim()
  if (name === '') fail('name', 'Name this account.')
  else if (name.length > 40) fail('name', 'Use at most 40 characters.')
  const main = readCurrency(draft.account_currency)
  if ('error' in main) fail('account_currency', main.error)
  const mainCode = 'code' in main ? main.code : null

  // parseAmount needs the currency for its decimals, so an amount is read only once its currency reads.
  const amount = (key: ErrorKey, text: string, currency: string | null, rule: 'any' | 'zero_or_more' | 'more_than_zero', blank: number | null = null): number | null => {
    if (currency === null) return null
    if (text.trim() === '' && blank !== null) return blank
    const minor = parseAmount(text, locale, currency)
    if (minor === null) return fail(key, text.trim() === '' ? 'Enter an amount.' : `Enter an amount in figures, such as ${example(locale, currency)}.`)
    if (rule === 'zero_or_more' && minor < 0) return fail(key, 'Enter 0 or more.')
    if (rule === 'more_than_zero' && minor <= 0) return fail(key, 'Enter more than 0.')
    return minor
  }
  const balance = amount('balance', draft.balance, mainCode, 'any')
  const floor = amount('floor', draft.floor, mainCode, 'zero_or_more', 0)
  const income = amount('income', draft.income, mainCode, 'more_than_zero')
  const living = amount('living', draft.living, mainCode, 'more_than_zero')

  let startsOn: string | null = null
  if (today !== null) {
    if (draft.every === 'month') {
      const day = readDay(draft.payday_day)
      if (day === null) fail('payday', 'Enter the day of the month you are paid, 1 to 31.')
      else startsOn = monthlyPayday(today, day).starts_on
    } else if (paydayChoices(today, draft.every).includes(draft.payday_date)) startsOn = draft.payday_date
    else fail('payday', 'Pick the day of your next payday.')
  }

  const debts: NonNullable<ImportDocInput['accounts']> = []
  let cardExtra: NonNullable<ImportDocInput['plan_items']>[number] | null = null
  if (draft.debt === 'card' && mainCode !== null && today !== null) {
    if (!cardPreset(draft.preset)) fail('preset', 'Pick how the card works.')
    const currency = cardCurrency(draft.preset, mainCode)
    const owed = amount('owed', draft.owed, currency, 'zero_or_more')
    const cut = readDay(draft.cut_day) ?? fail('cut_day', 'Enter a day, 1 to 31.')
    const due = readDay(draft.due_day) ?? fail('due_day', 'Enter a day, 1 to 31.')
    if (draft.pays === '') fail('pays', 'Pick what you pay each month.')
    const extra = draft.pays === 'extra' ? amount('extra', draft.extra, currency, 'more_than_zero') : null
    const preset = cardPreset(draft.preset)
    if (owed !== null && cut !== null && due !== null && preset && draft.pays !== '' && (draft.pays !== 'extra' || extra !== null)) {
      const terms = termsFromPreset(draft.preset, { cut_day: cut, due: { day_of_month: due }, due_roll: 'none' })
      // The full statement pays in full; the minimum keeps the preset's own minimum (with installments where it adds them).
      const mode = draft.pays === 'full' ? 'in_full' : preset.rules.pay.mode === 'in_full' ? 'minimum' : preset.rules.pay.mode
      if (extra !== null) {
        // A transfer into the card sizes each cycle's payment on top of its base (spec §6.4), from the account that pays it.
        cardExtra = { id: IDS.cardExtra, kind: 'transfer', name: 'Extra card payment', to_account_id: IDS.card, amount_minor: extra, every: 'month', starts_on: today }
      }
      debts.push({
        id: IDS.card,
        name: 'Credit card',
        kind: 'credit_card',
        currency,
        // Owed is a negative card balance; the opening balance acts as a statement cut today (spec §6.4).
        opening_balance_minor: owed === 0 ? 0 : -owed,
        opening_date: today,
        terms: { ...terms, pay: { ...terms.pay, mode } },
        funded_from_account_id: IDS.main,
        sort_order: 1,
      })
    }
  }
  if (draft.debt === 'loan' && mainCode !== null && today !== null) {
    const owed = amount('loan_balance', draft.loan_balance, mainCode, 'more_than_zero')
    const payment = amount('payment', draft.payment, mainCode, 'more_than_zero')
    const rate = readPercent(draft.rate) ?? fail('rate', 'Enter the yearly rate in percent, such as 6.9.')
    const day = readDay(draft.payment_day) ?? fail('payment_day', 'Enter a day, 1 to 31.')
    if (owed !== null && payment !== null && rate !== null && day !== null) {
      debts.push({
        id: IDS.loan,
        name: 'Loan',
        kind: 'loan',
        currency: mainCode,
        opening_balance_minor: -owed,
        opening_date: today,
        terms: { annual_rate: rate, payment_minor: payment, payment_day: day },
        funded_from_account_id: IDS.main,
        sort_order: 1,
      })
    }
  }

  if (Object.keys(errors).length > 0 || today === null || !('code' in base) || timezone === null || mainCode === null) return { today, errors, doc: null }
  if (balance === null || floor === null || income === null || living === null || startsOn === null) return { today, errors, doc: null }

  const doc: ImportDocInput = {
    version: SCHEMA_VERSION,
    household: { base_currency: base.code, timezone, locale, payoff_order: 'avalanche', track_from: today },
    accounts: [
      {
        id: IDS.main,
        name,
        kind: 'cash',
        currency: mainCode,
        opening_balance_minor: balance,
        opening_date: today,
        floor_windows: [{ from_month: monthKey(today), to_month: null, amount_minor: floor }],
        sort_order: 0,
      },
      ...debts,
    ],
    categories: [{ id: IDS.living, name: 'Living' }],
    plan_items: [
      { id: IDS.pay, kind: 'income', name: 'Pay', to_account_id: IDS.main, amount_minor: income, every: draft.every, starts_on: startsOn },
      // This month's allowance counts in full and is spread over the days left.
      { id: IDS.livingCosts, kind: 'allowance', name: 'Living costs', from_account_id: IDS.main, category_id: IDS.living, amount_minor: living, every: 'month', starts_on: firstOfMonth(today) },
      ...(cardExtra ? [cardExtra] : []),
    ],
    statements: [],
    transactions: [],
  }
  // The server makes the same checks; failing here means the document never leaves the device.
  const checked = checkInput(importDoc, doc)
  if (!checked.ok) return { today, errors: { doc: checked.errors.join('; ') }, doc: null }
  try {
    buildSnapshot(doc, today, [])
  } catch (error) {
    if (!(error instanceof SnapshotError)) throw error
    return { today, errors: { doc: error.issues.join('; ') }, doc: null }
  }
  return { today, errors, doc }
}
