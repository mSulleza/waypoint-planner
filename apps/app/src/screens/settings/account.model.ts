import {
  accountRow,
  cardPreset,
  fundingOrder,
  missingRates,
  monthKey,
  parseAmount,
  snapshotIndex,
  type Account,
  type AccountKind,
  type CardRules,
  type CardTerms,
  type FloorWindow,
  type Snapshot,
} from '@waypoint/core'
import { ACCOUNT_VALUES, type AccountValues, type Edit } from '../../data/edits'
import { amountText, isDay } from '../../data/field-text'
import type { FieldErrors, FieldNames, FormSchema } from '../../ui/useZodForm'
import { readRate, readWhole } from '../compare/compare.model'
import { DEFAULT_PRESET, readCurrency } from '../onboarding/onboarding.model'

// Spec §7 Settings and editors and §4 accounts: one editor for every kind. A debt's terms are copied from a preset named by behaviour and stay editable; a cash account holds its floor windows, its top-up source and its FX fee.

export type Method = CardRules['interest']['method']
export type Period = CardRules['interest']['period']
export type DayCount = CardRules['interest']['day_count']
export type Rounding = CardRules['minimum']['rounding']
export type PayMode = CardRules['pay']['mode']
export type Roll = CardTerms['due_roll']
export type DueKind = 'day_of_month' | 'days_after_cut'
export type PayOn = 'due_date' | 'days_after_cut'

// One floor window as typed; key keeps a row's fields together while rows are added and removed.
export interface FloorDraft {
  key: string
  from_month: string
  // No end month: the window runs on.
  open: boolean
  to_month: string
  amount: string
}

export interface AccountDraft {
  kind: AccountKind
  name: string
  currency: string
  // As typed. On a card or loan it is what is owed, saved below zero.
  balance: string
  opening_date: string
  funded_from: string | null
  // Card terms, each as typed; preset names the rules they were copied from.
  preset: string
  cut_day: string
  due_kind: DueKind
  due: string
  due_roll: Roll
  method: Method
  rate: string
  period: Period
  day_count: DayCount
  // From the preset; the editor shows no field for it, so an edit keeps it.
  payment_lag: number
  min_pct: string
  add_installments: boolean
  add_interest: boolean
  add_fees: boolean
  min_floor: string
  rounding: Rounding
  pay_mode: PayMode
  pay_on: PayOn
  pay_days: string
  // Loan terms.
  loan_rate: string
  payment: string
  payment_day: string
  // Cash only.
  floors: FloorDraft[]
  // Empty for no fee.
  fx_fee: string
}

export const KIND_ORDER: readonly AccountKind[] = ['cash', 'credit_card', 'loan']

export const KIND_WORDS: Record<AccountKind, { title: string; detail: string }> = {
  cash: { title: 'Cash account', detail: 'A bank account, an e-wallet or cash in hand.' },
  credit_card: { title: 'Credit card', detail: 'Billed by statement each month.' },
  loan: { title: 'Loan', detail: 'Paid back by a fixed payment each month.' },
}

export const DUE_WORDS: Record<DueKind, string> = { day_of_month: 'A day of the month', days_after_cut: 'Days after the cut' }

export const ROLL_WORDS: Record<Roll, string> = { none: 'Keep the date', following: 'Monday after', preceding: 'Friday before' }

export const METHOD_WORDS: Record<Method, string> = { average_daily_balance: 'On the average daily balance', daily_on_unpaid: 'Daily on the unpaid statement balance' }

export const PERIOD_WORDS: Record<Period, string> = { month: 'A month', year: 'A year' }

export const DAY_COUNTS: readonly DayCount[] = [30, 360, 365]

export const ROUNDING_WORDS: Record<Rounding, string> = { half_up: 'To the nearest', ceil: 'Up' }

export const PAY_WORDS: Record<PayMode, { title: string; detail: string }> = {
  in_full: { title: 'The statement total', detail: 'Pays the card off each cycle.' },
  minimum: { title: 'The minimum', detail: 'The rest carries to the next statement, with interest.' },
  installments_plus: { title: 'At least the installments', detail: 'The minimum, or the cycle’s installments when they are more.' },
}

export const PAY_ON_WORDS: Record<PayOn, string> = { due_date: 'On the due date', days_after_cut: 'Days after the cut' }

// The line spec §7 puts above the windows: a month's floor is its smallest covering window and its target its largest (spec §4).
export const FLOOR_LINE = 'The lowest covering amount is the floor; a higher one is a target that is only watched.'

// How a schema sentence names another field.
export const FIELD_NAMES: FieldNames<string> = { from_month: 'the from month', to_month: 'the to month', cut_day: 'the cut day', funded_from_account_id: 'the account that pays it' }

const bySortOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// A fraction as the percent a person types: 0.035 reads '3.5', 0.00736 reads '0.736'.
export function percentText(fraction: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 6, useGrouping: false }).format(Math.round(fraction * 1e8) / 1e6)
}

// The FX fee column keeps 5 decimals of a fraction, so a percent takes at most 3.
export function readFee(text: string): number | null {
  const t = text.trim().replace(/\s*%$/, '')
  return /^\d{1,2}([.,]\d{1,3})?$/.test(t) ? readRate(t) : null
}

const dayText = (day: string, locale: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))

// Anything that names the account: a transaction, a statement, a plan item or another account it funds. Its kind and currency then stay.
export function inUse(snapshot: Snapshot, id: string): boolean {
  const { doc } = snapshot
  return (
    doc.transactions.some((t) => t.account_id === id) ||
    doc.statements.some((s) => s.account_id === id) ||
    doc.plan_items.some((p) => p.from_account_id === id || p.to_account_id === id) ||
    doc.accounts.some((a) => a.funded_from_account_id === id)
  )
}

// The accounts that may pay this one: open cash accounts, the one already chosen, and for a cash account none that it tops up itself, directly or through another.
export function funderChoices(snapshot: Snapshot, id: string, chosen: string | null): Account[] {
  const funds = (a: Account): boolean => {
    let at: Account | undefined = a
    const seen = new Set<string>()
    while (at && at.funded_from_account_id !== null && !seen.has(at.id)) {
      if (at.funded_from_account_id === id) return true
      seen.add(at.id)
      at = snapshotIndex(snapshot).accounts.get(at.funded_from_account_id)
    }
    return false
  }
  return snapshot.doc.accounts.filter((a) => a.kind === 'cash' && a.id !== id && (a.id === chosen || (a.archived_at === null && !funds(a)))).sort(bySortOrder)
}

const nextSortOrder = (snapshot: Snapshot) => Math.max(-1, ...snapshot.doc.accounts.map((a) => a.sort_order)) + 1

let floorKeys = 0
const floorKey = () => `floor-${++floorKeys}`

export const newFloor = (month: string): FloorDraft => ({ key: floorKey(), from_month: month, open: true, to_month: month, amount: '' })

const floorDraft = (w: FloorWindow, currency: string, locale: string): FloorDraft => ({ key: floorKey(), from_month: w.from_month, open: w.to_month === null, to_month: w.to_month ?? w.from_month, amount: amountText(w.amount_minor, currency, locale) })

// The preset's rules into the draft's fields, keeping the card's own cut day and due rule. On a card whose currency may still change, a preset fitted to one bank brings that bank's currency.
export function withPreset(draft: AccountDraft, presetId: string, locale: string, keepCurrency = false): AccountDraft {
  const preset = cardPreset(presetId)
  if (!preset) return draft
  const currency = keepCurrency ? draft.currency : (preset.currency ?? draft.currency)
  return { ...draft, preset: presetId, currency, ...rulesDraft(preset.rules, currency, locale) }
}

function rulesDraft(rules: CardRules, currency: string, locale: string) {
  const { interest, minimum, pay } = rules
  return {
    method: interest.method,
    rate: percentText(interest.rate, locale),
    period: interest.period,
    day_count: interest.day_count,
    payment_lag: interest.payment_effective_lag_days,
    min_pct: percentText(minimum.pct, locale),
    add_installments: minimum.add_installments,
    add_interest: minimum.add_interest,
    add_fees: minimum.add_fees,
    min_floor: amountText(minimum.floor_minor, currency, locale),
    rounding: minimum.rounding,
    pay_mode: pay.mode,
    pay_on: pay.on === 'due_date' ? ('due_date' as const) : ('days_after_cut' as const),
    pay_days: pay.on === 'due_date' ? '' : String(pay.on.days_after_cut),
  }
}

export interface NewAccountParams {
  kind?: string
}

// A new account from Settings' Add an account, or Debts' Add a debt with ?kind=credit_card.
export function newAccountDraft(snapshot: Snapshot, params: NewAccountParams, locale: string): AccountDraft {
  const kind = KIND_ORDER.find((k) => k === params.kind) ?? 'cash'
  const blank: AccountDraft = {
    kind: 'cash',
    name: '',
    currency: snapshot.doc.household.base_currency,
    balance: '0',
    opening_date: snapshot.as_of,
    funded_from: null,
    preset: DEFAULT_PRESET,
    cut_day: '',
    due_kind: 'day_of_month',
    due: '',
    due_roll: 'none',
    method: 'average_daily_balance',
    rate: '',
    period: 'year',
    day_count: 365,
    payment_lag: 0,
    min_pct: '',
    add_installments: false,
    add_interest: false,
    add_fees: false,
    min_floor: '',
    rounding: 'half_up',
    pay_mode: 'in_full',
    pay_on: 'due_date',
    pay_days: '',
    loan_rate: '',
    payment: '',
    payment_day: '',
    floors: [],
    fx_fee: '',
  }
  return withKind(snapshot, withPreset(blank, DEFAULT_PRESET, locale), kind, null)
}

// A debt needs the account that pays it, so the first cash account is picked; a new debt takes that account's currency unless its preset has one.
export function withKind(snapshot: Snapshot, draft: AccountDraft, kind: AccountKind, id: string | null): AccountDraft {
  if (kind === 'cash') return { ...draft, kind, funded_from: null, balance: draft.kind === 'loan' && draft.balance === '' ? '0' : draft.balance }
  const payer = draft.funded_from ?? funderChoices(snapshot, id ?? '', null)[0]?.id ?? null
  const payerCurrency = payer === null ? undefined : snapshotIndex(snapshot).accounts.get(payer)?.currency
  const currency = kind === 'credit_card' ? (cardPreset(draft.preset)?.currency ?? payerCurrency ?? draft.currency) : (payerCurrency ?? draft.currency)
  return { ...draft, kind, funded_from: payer, currency, balance: kind === 'loan' && draft.balance === '0' ? '' : draft.balance }
}

export function draftOfAccount(snapshot: Snapshot, account: Account, locale: string): AccountDraft {
  const money = (minor: number) => amountText(minor, account.currency, locale)
  const base = newAccountDraft(snapshot, { kind: 'cash' }, locale)
  const common = {
    ...base,
    kind: account.kind,
    name: account.name,
    currency: account.currency,
    balance: money(account.kind === 'cash' ? account.opening_balance_minor : -account.opening_balance_minor),
    opening_date: account.opening_date,
    funded_from: account.funded_from_account_id,
  }
  if (account.kind === 'cash') {
    return { ...common, floors: account.floor_windows.map((w) => floorDraft(w, account.currency, locale)), fx_fee: account.fx_fee_pct === null ? '' : percentText(account.fx_fee_pct, locale) }
  }
  if (account.kind === 'loan') {
    const t = account.terms
    return { ...common, loan_rate: percentText(t.annual_rate, locale), payment: money(t.payment_minor), payment_day: String(t.payment_day) }
  }
  const t = account.terms
  return {
    ...common,
    preset: t.preset,
    cut_day: String(t.cut_day),
    due_kind: 'day_of_month' in t.due ? 'day_of_month' : 'days_after_cut',
    due: String('day_of_month' in t.due ? t.due.day_of_month : t.due.days_after_cut),
    due_roll: t.due_roll,
    ...rulesDraft(t, account.currency, locale),
  }
}

export type Opened = { kind: 'new'; draft: AccountDraft } | { kind: 'edit'; account: Account; draft: AccountDraft } | { kind: 'missing' }

export function openAccount(snapshot: Snapshot, id: string, newId: string, params: NewAccountParams, locale: string): Opened {
  const account = snapshotIndex(snapshot).accounts.get(id)
  if (account) return { kind: 'edit', account, draft: draftOfAccount(snapshot, account, locale) }
  return id === newId ? { kind: 'new', draft: newAccountDraft(snapshot, params, locale) } : { kind: 'missing' }
}

export interface ReadContext {
  id: string
  locale: string
  // The row as saved, for the columns the editor leaves alone; null for a new account.
  loaded: Account | null
}

type Rule = 'any' | 'zero_or_more' | 'more_than_zero'

// The draft as accountRow's input: each typed value parsed once, in the household locale and the account's currency, and only the fields its kind uses.
export function readAccount(snapshot: Snapshot, draft: AccountDraft, { id, locale, loaded }: ReadContext): { input: unknown; errors: FieldErrors<string> } {
  const errors: FieldErrors<string> = {}
  const fail = (field: string, message: string) => {
    errors[field] ??= message
    return null
  }
  const name = draft.name.trim()
  if (name === '') fail('name', 'Type a name.')
  const read = readCurrency(draft.currency)
  if ('error' in read) fail('currency', read.error)
  const currency = 'code' in read ? read.code : draft.currency.trim().toUpperCase()
  // parseAmount needs the currency's decimals, so an amount is read only once its currency reads.
  const amount = (field: string, text: string, rule: Rule): number | null => {
    if ('error' in read) return null
    const minor = parseAmount(text, locale, currency)
    if (minor === null) return fail(field, text.trim() === '' ? 'Type an amount.' : `Type an amount such as ${amountText(125050, currency, locale)}.`)
    if (rule === 'zero_or_more' && minor < 0) return fail(field, 'Type 0 or more.')
    if (rule === 'more_than_zero' && minor <= 0) return fail(field, 'Type more than 0.')
    return minor
  }
  const whole = (field: string, text: string, min: number, max: number, message: string) => readWhole(text, min, max) ?? fail(field, message)
  const percent = (field: string, text: string) => readRate(text) ?? fail(field, 'Type a percent such as 3.5.')

  const debt = draft.kind !== 'cash'
  const balance = amount('opening_balance_minor', draft.balance, draft.kind === 'loan' ? 'more_than_zero' : 'any')
  const opening = draft.opening_date.trim()
  if (!isDay(opening)) fail('opening_date', 'Pick a date.')
  if (debt && draft.funded_from === null) fail('funded_from_account_id', 'Pick the account that pays it.')

  let terms: unknown = null
  if (draft.kind === 'credit_card') {
    const afterCut = 'Type a number of days, 1 to 60.'
    const cut = whole('cut_day', draft.cut_day, 1, 31, 'Type a day of the month, 1 to 31.')
    const due = draft.due_kind === 'day_of_month' ? whole('due', draft.due, 1, 31, 'Type a day of the month, 1 to 31.') : whole('due', draft.due, 1, 60, afterCut)
    const rate = percent('interest.rate', draft.rate)
    const pct = percent('minimum.pct', draft.min_pct)
    const floor = amount('minimum.floor_minor', draft.min_floor, 'zero_or_more')
    const payDays = draft.pay_on === 'days_after_cut' ? whole('pay.on', draft.pay_days, 1, 60, afterCut) : null
    terms = {
      cut_day: cut ?? 1,
      due: draft.due_kind === 'day_of_month' ? { day_of_month: due ?? 1 } : { days_after_cut: due ?? 1 },
      due_roll: draft.due_roll,
      interest: { method: draft.method, rate: rate ?? 0, period: draft.period, day_count: draft.day_count, payment_effective_lag_days: draft.payment_lag },
      minimum: { pct: pct ?? 0, add_installments: draft.add_installments, add_interest: draft.add_interest, add_fees: draft.add_fees, floor_minor: floor ?? 0, rounding: draft.rounding },
      pay: { mode: draft.pay_mode, on: draft.pay_on === 'due_date' ? 'due_date' : { days_after_cut: payDays ?? 1 } },
      preset: draft.preset,
    }
  } else if (draft.kind === 'loan') {
    const rate = percent('annual_rate', draft.loan_rate)
    const payment = amount('payment_minor', draft.payment, 'more_than_zero')
    const day = whole('payment_day', draft.payment_day, 1, 31, 'Type a day of the month, 1 to 31.')
    terms = { annual_rate: rate ?? 0, payment_minor: payment ?? 1, payment_day: day ?? 1 }
  }

  const windows = draft.kind === 'cash' ? draft.floors.map((f, i) => readFloor(f, i, amount, fail)) : []
  const fee = draft.kind === 'cash' && draft.fx_fee.trim() !== '' ? (readFee(draft.fx_fee) ?? fail('fx_fee_pct', 'Type a percent with at most 3 decimals, such as 0.736.')) : null
  return {
    input: {
      id,
      name,
      kind: draft.kind,
      currency,
      opening_balance_minor: balance === null ? 0 : debt ? -balance || 0 : balance,
      opening_date: opening,
      terms,
      funded_from_account_id: draft.funded_from,
      floor_windows: windows,
      fx_fee_pct: fee,
      csv_mapping: loaded?.csv_mapping ?? null,
      sort_order: loaded?.sort_order ?? nextSortOrder(snapshot),
      archived_at: loaded?.archived_at ?? null,
    },
    errors,
  }
}

function readFloor(f: FloorDraft, i: number, amount: (field: string, text: string, rule: Rule) => number | null, fail: (field: string, message: string) => null): FloorWindow {
  const minor = amount(`floor_windows.${i}.amount_minor`, f.amount, 'zero_or_more')
  if (!f.open && f.to_month < f.from_month) fail(`floor_windows.${i}.to_month`, 'Ends before it starts. Pick a later month, or no end.')
  return { from_month: f.from_month, to_month: f.open ? null : f.to_month, amount_minor: minor ?? 0 }
}

// The currency amounts show in while the person types one: the typed code once it reads, else the fallback.
export function shownCurrency(text: string, fallback: string): string {
  const read = readCurrency(text)
  return 'code' in read ? read.code : fallback
}

// The windows that read, for the floor sentence under them while the person types.
export function readableFloors(draft: AccountDraft, currency: string, locale: string): FloorWindow[] {
  return draft.floors.flatMap((f) => {
    const minor = parseAmount(f.amount, locale, currency)
    return minor === null || minor < 0 || (!f.open && f.to_month < f.from_month) ? [] : [{ from_month: f.from_month, to_month: f.open ? null : f.to_month, amount_minor: minor }]
  })
}

// Where a schema issue shows: the terms' groups by their field ('interest.rate'), a floor window by its row and field.
export function fieldOf(path: readonly PropertyKey[]): string {
  const [head, a, b] = path.map(String)
  if (head === 'terms') return a === 'interest' || a === 'minimum' || a === 'pay' ? `${a}.${b ?? ''}` : (a ?? 'preset')
  if (head === 'floor_windows' && a !== undefined && b !== undefined) return `floor_windows.${a}.${b}`
  return head ?? 'name'
}

// accountRow, with each issue keyed by fieldOf so it shows beside its own field.
export const ACCOUNT_SCHEMA: FormSchema<Account> = {
  safeParse(input) {
    const parsed = accountRow.safeParse(input)
    return parsed.success ? { success: true, data: parsed.data } : { success: false, error: { issues: parsed.error.issues.map((i) => ({ path: [fieldOf(i.path)], message: i.message })) } }
  },
}

// What the database cannot see and the engine would refuse for the whole household (spec §4): a funding circle, a payer with no rate, a row before the opening date; and a kind or currency changed under its rows.
export function accountChecks(snapshot: Snapshot, row: Account, loaded: Account | null, locale: string): FieldErrors<string> {
  const errors: FieldErrors<string> = {}
  const accounts = snapshotIndex(snapshot).accounts
  const payer = row.funded_from_account_id === null ? undefined : accounts.get(row.funded_from_account_id)
  if (row.funded_from_account_id !== null) {
    const others = snapshot.doc.accounts.filter((a) => a.id !== row.id)
    if (!payer) errors.funded_from_account_id = 'That account is no longer in your household. Pick another.'
    else if (payer.kind !== 'cash') errors.funded_from_account_id = 'Pick a cash account.'
    else if (fundingOrder([...others, row]).errors.some((e) => e.code === 'funding_cycle')) errors.funded_from_account_id = `${payer.name} is topped up from this account, so it cannot top this one up.`
    else if (payer.currency !== row.currency) {
      const missing = missingRates([payer.currency, row.currency], snapshot.rates)
      if (missing.length > 0) errors.funded_from_account_id = `No reference rate for ${missing.join(' or ')}, so money cannot move from ${payer.name} to this account.`
    }
  }
  const first = snapshot.doc.transactions.filter((t) => t.account_id === row.id).reduce<string | null>((min, t) => (min === null || t.posted_on < min ? t.posted_on : min), null)
  if (first !== null && row.opening_date > first) errors.opening_date = `Its first transaction is on ${dayText(first, locale)}, so it must open on or before then.`
  if (loaded && inUse(snapshot, loaded.id)) {
    if (row.kind !== loaded.kind) errors.kind = 'It has transactions or plan items, so its kind stays.'
    if (row.currency !== loaded.currency) errors.currency = `It has transactions or plan items in ${loaded.currency}, so its currency stays.`
  }
  return errors
}

// Plain JSON compared by value, as Postgres compares jsonb: key order does not matter.
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const valuesOf = (a: Account): AccountValues => Object.fromEntries(ACCOUNT_VALUES.map((c) => [c, a[c]])) as AccountValues

// Save on a saved account: the columns that changed, guarded on the row as loaded; null when nothing did.
export function saveAccount(loaded: Account, row: Account): Edit | null {
  const changed = ACCOUNT_VALUES.filter((c) => !sameValue(loaded[c], row[c]))
  if (changed.length === 0) return null
  return { kind: 'edit_account', id: loaded.id, before: valuesOf(loaded), after: Object.fromEntries(changed.map((c) => [c, row[c]])) as Partial<AccountValues> }
}

// Archive and unarchive write only archived_at; history stays either way.
export function archiveAccount(loaded: Account, at: string | null): Edit {
  return { kind: 'edit_account', id: loaded.id, before: valuesOf(loaded), after: { archived_at: at } }
}

export function changedElsewhere(loaded: Account, current: Account | undefined): boolean {
  return current !== undefined && current !== loaded && ACCOUNT_VALUES.some((c) => !sameValue(current[c], loaded[c]))
}

// Whether the typed rules still read as the preset's, for the line under the preset picker.
export function matchesPreset(row: Account | null): boolean | null {
  if (!row || row.kind !== 'credit_card') return null
  const preset = cardPreset(row.terms.preset)
  if (!preset) return false
  const { interest, minimum, pay } = row.terms
  return sameValue({ interest, minimum, pay }, preset.rules)
}

// This month, for a new floor window's first month.
export const thisMonth = (snapshot: Snapshot) => monthKey(snapshot.as_of)
