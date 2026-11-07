import { householdRow, todayIn, type Account, type Category, type Household, type PlanItem, type Snapshot } from '@waypoint/core'
import { CATEGORY_VALUES, HOUSEHOLD_VALUES, type CategoryValues, type Edit, type HouseholdValues } from '../../data/edits'
import { NEW_ACCOUNT_ID, NEW_ITEM_ID } from '../../shell/url.model'
import { APPEARANCES, type Appearance } from '../../ui/appearance'
import type { FieldErrors } from '../../ui/useZodForm'
import { readCurrency, readTimeZone } from '../onboarding/onboarding.model'
import { KIND_WORDS } from './account.model'

// Spec §7 Settings: the household's settings, its accounts and categories, what this device does when the app opens, and the account itself.

export type PayoffOrder = Household['payoff_order']

// Named by what happens, never by a method's name, and neither is recommended.
export const PAYOFF_WORDS: Record<PayoffOrder, { title: string; detail: string }> = {
  avalanche: { title: 'Highest rate first', detail: 'Extra for debts goes to the debt with the highest interest rate, then the next.' },
  list: { title: 'My order', detail: 'Extra for debts goes to the debts in the order of your accounts below.' },
}

export const PAYOFF_ORDER: readonly PayoffOrder[] = ['avalanche', 'list']

export interface HouseholdDraft {
  currency: string
  timezone: string
  locale: string
  payoff_order: PayoffOrder
}

export type HouseholdField = (typeof HOUSEHOLD_VALUES)[number]

export const householdDraft = (h: Household): HouseholdDraft => ({ currency: h.base_currency, timezone: h.timezone, locale: h.locale, payoff_order: h.payoff_order })

// The draft as householdRow's input; a zone is saved under the name Intl gives it, so 'europe/madrid' is Europe/Madrid.
export function readHousehold(draft: HouseholdDraft, loaded: Household): { input: unknown; errors: FieldErrors<HouseholdField> } {
  const errors: FieldErrors<HouseholdField> = {}
  const currency = readCurrency(draft.currency)
  if ('error' in currency) errors.base_currency = currency.error
  const zone = readTimeZone(draft.timezone)
  if (zone === null) errors.timezone = 'Type a time zone such as Europe/Madrid.'
  const locale = canonicalLocale(draft.locale)
  if (locale === null) errors.locale = 'Pick a language and region.'
  return {
    input: {
      base_currency: 'code' in currency ? currency.code : draft.currency.trim(),
      timezone: zone ?? draft.timezone.trim(),
      locale: locale ?? draft.locale.trim(),
      payoff_order: draft.payoff_order,
      track_from: loaded.track_from,
    },
    errors,
  }
}

// A BCP 47 tag as Intl spells it ('en-gb' is en-GB), or null when Intl cannot read it.
export function canonicalLocale(text: string): string | null {
  const tag = text.trim()
  if (tag === '') return null
  try {
    const [canonical] = Intl.getCanonicalLocales(tag)
    return canonical ?? null
  } catch {
    return null
  }
}

export const HOUSEHOLD_SCHEMA = householdRow

// Save: the settings that changed, guarded on the household as loaded; null when nothing did.
export function saveHousehold(id: string, loaded: Household, row: Household): Edit | null {
  const changed = HOUSEHOLD_VALUES.filter((c) => loaded[c] !== row[c])
  if (changed.length === 0) return null
  const before = Object.fromEntries(HOUSEHOLD_VALUES.map((c) => [c, loaded[c]])) as HouseholdValues
  return { kind: 'edit_household', id, before, after: Object.fromEntries(changed.map((c) => [c, row[c]])) as Partial<HouseholdValues> }
}

// Languages and regions offered, so nobody types a BCP 47 tag; they only shape how dates and numbers are written.
export const LOCALE_TAGS = ['en-US', 'en-GB', 'en-IE', 'en-AU', 'en-CA', 'en-NZ', 'en-IN', 'en-PH', 'en-SG', 'en-ZA', 'fil-PH', 'es-ES', 'es-MX', 'es-US', 'pt-PT', 'pt-BR', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'nl-NL', 'sv-SE', 'pl-PL', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW'] as const

// A tag's name in its own language, such as 'Español (España)'; the tag itself where Intl has no names (Hermes).
export function localeName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language', languageDisplay: 'standard' }).of(tag)
    return name ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : tag
  } catch {
    return tag
  }
}

// The picker's rows: each name with what it does to a date and a number, the household's own tag first when it is not on the list.
export function localeChoices(current: string, asOf: string): { value: string; title: string; detail: string }[] {
  const own = canonicalLocale(current)
  const tags: string[] = [...LOCALE_TAGS]
  if (own !== null && !tags.includes(own)) tags.unshift(own)
  return tags.map((tag) => ({ value: tag, title: localeName(tag), detail: localeSample(tag, asOf) ?? tag }))
}

// What a locale does to dates and numbers, shown under the field; no currency, so the mask has nothing to hide.
export function localeSample(locale: string, asOf: string): string | null {
  const tag = canonicalLocale(locale)
  if (tag === null) return null
  try {
    const day = new Intl.DateTimeFormat(tag, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${asOf}T00:00:00Z`))
    return `Dates read ${day}; numbers read ${new Intl.NumberFormat(tag).format(1234.5)}.`
  } catch {
    return null
  }
}

// Today in a zone as typed, so a person sees which day the plan counts from.
export function zoneSample(zone: string, locale: string, now: Date): string | null {
  const name = readTimeZone(zone)
  if (name === null) return null
  const today = todayIn(name, now)
  return `Today there is ${new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${today}T00:00:00Z`))}.`
}

export interface AccountLine {
  id: string
  name: string
  detail: string
  archived: boolean
}

export interface AccountSection {
  title: string
  accounts: AccountLine[]
}

const bySortOrder = (a: Account, b: Account) => Number(a.archived_at !== null) - Number(b.archived_at !== null) || a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Cash accounts, then cards and loans, each in account order (the order 'My order' pays debts in), closed ones last.
export function accountSections(snapshot: Snapshot): AccountSection[] {
  const names = new Map(snapshot.doc.accounts.map((a) => [a.id, a.name]))
  const line = (a: Account): AccountLine => {
    const payer = a.funded_from_account_id === null ? null : (names.get(a.funded_from_account_id) ?? null)
    const parts = a.kind === 'cash' ? [a.currency, payer ? `Tops up from ${payer}` : null] : [KIND_WORDS[a.kind].title, a.currency, payer ? `Paid from ${payer}` : null]
    if (a.archived_at !== null) parts.push('Archived')
    return { id: a.id, name: a.name, detail: parts.filter((p) => p !== null).join(' · '), archived: a.archived_at !== null }
  }
  const sorted = [...snapshot.doc.accounts].sort(bySortOrder)
  return [
    { title: 'Cash accounts', accounts: sorted.filter((a) => a.kind === 'cash').map(line) },
    { title: 'Cards and loans', accounts: sorted.filter((a) => a.kind !== 'cash').map(line) },
  ].filter((s) => s.accounts.length > 0)
}

export interface CategoryLine {
  id: string
  name: string
  archived: boolean
  // The monthly budget running now or next, if any.
  budget: { item_id: string; amount_minor: number; currency: string; from: string } | null
}

// A category's monthly budget: the allowance that covers this month, else the next to start; one-off credits are not budgets.
export function budgetOf(snapshot: Snapshot, categoryId: string): PlanItem | null {
  const month = snapshot.as_of.slice(0, 7)
  const live = snapshot.doc.plan_items
    .filter((p) => p.kind === 'allowance' && p.category_id === categoryId && p.every !== 'once' && (p.ends_on === null || p.ends_on.slice(0, 7) >= month))
    .sort((a, b) => (a.starts_on < b.starts_on ? -1 : a.starts_on > b.starts_on ? 1 : 0))
  return live.filter((p) => p.starts_on.slice(0, 7) <= month).at(-1) ?? live[0] ?? null
}

export function categoryLines(snapshot: Snapshot): CategoryLine[] {
  const accounts = new Map(snapshot.doc.accounts.map((a) => [a.id, a]))
  return [...snapshot.doc.categories]
    .sort((a, b) => Number(a.archived_at !== null) - Number(b.archived_at !== null) || a.name.localeCompare(b.name))
    .map((c) => {
      const item = budgetOf(snapshot, c.id)
      const from = item?.from_account_id ? accounts.get(item.from_account_id) : undefined
      return { id: c.id, name: c.name, archived: c.archived_at !== null, budget: item && from ? { item_id: item.id, amount_minor: item.amount_minor, currency: from.currency, from: from.name } : null }
    })
}

// A category name as saved: trimmed, at most 40 characters, and unique ignoring case (categories_household_id_name_key); a name in use names that category.
export function readCategoryName(snapshot: Snapshot, text: string, id: string | null): { name: string } | { error: string; existing?: Category } {
  const name = text.trim()
  if (name === '') return { error: 'Type a name.' }
  if (name.length > 40) return { error: 'Use at most 40 characters.' }
  const existing = snapshot.doc.categories.find((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())
  if (existing) return { error: 'A category with this name exists.', existing }
  return { name }
}

// A new category on its own id, so a retry of one Add never adds two.
export const addCategory = (id: string, name: string, household: string): Edit => ({ kind: 'add_category', row: { id, name, archived_at: null, household_id: household } })

const categoryValues = (c: Category): CategoryValues => Object.fromEntries(CATEGORY_VALUES.map((k) => [k, c[k]])) as CategoryValues

export const renameCategory = (loaded: Category, name: string): Edit | null => (name === loaded.name ? null : { kind: 'edit_category', id: loaded.id, before: categoryValues(loaded), after: { name } })

export const archiveCategory = (loaded: Category, at: string | null): Edit => ({ kind: 'edit_category', id: loaded.id, before: categoryValues(loaded), after: { archived_at: at } })

// The plan item editor on a new monthly budget in the category, with a from-account picker; saving it there is the second save.
export const budgetLink = (categoryId: string) => ({ pathname: '/plan/item/[id]', params: { id: NEW_ITEM_ID, kind: 'allowance', category: categoryId } }) as const

export const itemLink = (itemId: string) => ({ pathname: '/plan/item/[id]', params: { id: itemId } }) as const

export const accountLink = (id: string) => ({ pathname: '/settings/account/[id]', params: { id } }) as const

// The account editor on a new account of a kind: Settings' Add an account, Debts' Add a debt.
export const newAccountLink = (kind: Account['kind']) => ({ pathname: '/settings/account/[id]', params: { id: NEW_ACCOUNT_ID, kind } }) as const

export const APPEARANCE_WORDS: Record<Appearance, string> = { system: 'System', light: 'Light', dark: 'Dark' }

// This device's Appearance control: System, Light and Dark, with the one in use selected.
export function appearanceControl(current: Appearance): { options: { value: Appearance; label: string }[]; value: Appearance } {
  return { options: APPEARANCES.map((value) => ({ value, label: APPEARANCE_WORDS[value] })), value: current }
}
