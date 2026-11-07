import { buildSnapshot, householdRow, type Snapshot } from '@waypoint/core'
import { abroad, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import {
  accountSections,
  addCategory,
  appearanceControl,
  archiveCategory,
  budgetLink,
  budgetOf,
  canonicalLocale,
  categoryLines,
  householdDraft,
  localeChoices,
  localeName,
  localeSample,
  LOCALE_TAGS,
  newAccountLink,
  PAYOFF_WORDS,
  readCategoryName,
  readHousehold,
  renameCategory,
  saveHousehold,
  zoneSample,
} from './settings.model'

const AS_OF = '2026-10-07'

function snapshotOf(edit?: (doc: SampleDoc) => void): Snapshot {
  const sample = abroad(AS_OF)
  edit?.(sample.doc)
  return buildSnapshot(sample.doc, AS_OF, sample.rates)
}

describe('settings model', () => {
  it('reads the household settings with the zone and locale as Intl spells them, and saves only what changed', () => {
    const household = snapshotOf().doc.household
    const draft = { ...householdDraft(household), timezone: 'europe/madrid', locale: 'en-gb', currency: 'gbp', payoff_order: 'list' as const }
    const { input, errors } = readHousehold(draft, household)
    expect(errors).toEqual({})
    const row = householdRow.parse(input)
    expect(row).toEqual({ base_currency: 'GBP', timezone: 'Europe/Madrid', locale: 'en-GB', payoff_order: 'list', track_from: household.track_from })
    expect(saveHousehold('h1', household, row)).toEqual({
      kind: 'edit_household',
      id: 'h1',
      before: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-PH', payoff_order: 'avalanche' },
      after: { base_currency: 'GBP', locale: 'en-GB', payoff_order: 'list' },
    })
    expect(saveHousehold('h1', household, household)).toBeNull()
    expect(readHousehold({ ...draft, timezone: 'Mars/Olympus', locale: '', currency: 'EU' }, household).errors).toEqual({
      base_currency: 'Enter a three-letter currency code, such as EUR or USD.',
      timezone: 'Type a time zone such as Europe/Madrid.',
      locale: 'Pick a language and region.',
    })
  })

  it('shows what a locale and a zone do in words with no currency, so the mask has nothing to hide', () => {
    expect(localeSample('es-ES', AS_OF)).toBe('Dates read miércoles, 7 de octubre de 2026; numbers read 1234,5.')
    expect(localeSample('not a tag', AS_OF)).toBeNull()
    expect(canonicalLocale(' EN-ph ')).toBe('en-PH')
    expect(zoneSample('Asia/Manila', 'en-GB', new Date('2026-10-07T20:30:00Z'))).toBe('Today there is Thursday 8 October.')
    expect(zoneSample('nowhere', 'en-GB', new Date())).toBeNull()
  })

  it('offers languages and regions by name in their own language, never as a tag to type, keeping the household’s own', () => {
    expect([localeName('en-US'), localeName('es-ES'), localeName('fil-PH')]).toEqual(['English (United States)', 'Español (España)', 'Filipino (Pilipinas)'])
    const choices = localeChoices('en-IE', AS_OF)
    expect(choices.map((c) => c.value)).toEqual([...LOCALE_TAGS])
    expect(choices.find((c) => c.value === 'en-IE')).toEqual({ value: 'en-IE', title: 'English (Ireland)', detail: localeSample('en-IE', AS_OF) })
    expect(localeChoices('de-AT', AS_OF)[0]).toMatchObject({ value: 'de-AT', title: 'Deutsch (Österreich)' })
  })

  it('names the payoff orders by what happens, not by a method', () => {
    const words = JSON.stringify(Object.values(PAYOFF_WORDS)).toLowerCase()
    expect([PAYOFF_WORDS.avalanche.title, PAYOFF_WORDS.list.title]).toEqual(['Highest rate first', 'My order'])
    expect(/avalanche|snowball|recommend|best/.test(words)).toBe(false)
  })

  it('lists cash accounts, then cards and loans in account order, closed ones last, each with who pays it', () => {
    const snapshot = snapshotOf((doc) => {
      const tax = doc.accounts.find((a) => a.id === 'tax')
      if (tax) Object.assign(tax, { archived_at: '2026-10-01T00:00:00Z' })
    })
    expect(accountSections(snapshot)).toEqual([
      {
        title: 'Cash accounts',
        accounts: [
          { id: 'main', name: 'Main', detail: 'EUR', archived: false },
          { id: 'pesos', name: 'Pesos', detail: 'PHP · Tops up from Main', archived: false },
          { id: 'tax', name: 'Tax', detail: 'EUR · Archived', archived: true },
        ],
      },
      {
        title: 'Cards and loans',
        accounts: [
          { id: 'rewards-card', name: 'Rewards card', detail: 'Credit card · PHP · Paid from Pesos', archived: false },
          { id: 'shopping-card', name: 'Shopping card', detail: 'Credit card · PHP · Paid from Pesos', archived: false },
        ],
      },
    ])
  })

  it('gives each category its running monthly budget, never a one-off credit, and links a new one to the plan item editor', () => {
    const snapshot = snapshotOf()
    expect(categoryLines(snapshot)).toEqual([
      { id: 'cat-dining', name: 'Dining', archived: false, budget: null },
      { id: 'cat-groceries', name: 'Groceries', archived: false, budget: { item_id: 'groceries', amount_minor: 40000, currency: 'EUR', from: 'Main' } },
      { id: 'cat-home', name: 'Home', archived: false, budget: null },
    ])
    // An ended budget is not shown; the one that starts later is.
    const split = snapshotOf((doc) => {
      const groceries = doc.plan_items.find((p) => p.id === 'groceries')
      if (groceries) Object.assign(groceries, { ends_on: '2026-09-30' })
      doc.plan_items.push({ id: 'groceries-later', kind: 'allowance', name: 'Groceries', from_account_id: 'main', category_id: 'cat-groceries', amount_minor: 45000, starts_on: '2026-12-01' } as never)
    })
    expect(budgetOf(split, 'cat-groceries')?.id).toBe('groceries-later')
    expect(budgetLink('cat-home')).toEqual({ pathname: '/plan/item/[id]', params: { id: 'new', kind: 'allowance', category: 'cat-home' } })
    expect(newAccountLink('credit_card')).toEqual({ pathname: '/settings/account/[id]', params: { id: 'new', kind: 'credit_card' } })
  })

  it('reads a category name trimmed and unique ignoring case, and renames or archives with a guard on what was loaded', () => {
    const snapshot = snapshotOf()
    expect(readCategoryName(snapshot, '  Transport ', null)).toEqual({ name: 'Transport' })
    expect(readCategoryName(snapshot, 'groceries', null)).toEqual({ error: 'A category with this name exists.', existing: { id: 'cat-groceries', name: 'Groceries', archived_at: null } })
    expect(readCategoryName(snapshot, 'GROCERIES', 'cat-groceries')).toEqual({ name: 'GROCERIES' })
    expect(readCategoryName(snapshot, ' ', null)).toEqual({ error: 'Type a name.' })
    expect(readCategoryName(snapshot, 'x'.repeat(41), null)).toEqual({ error: 'Use at most 40 characters.' })
    expect(addCategory('cat-new', 'Transport', 'household-1')).toEqual({ kind: 'add_category', row: { id: 'cat-new', name: 'Transport', archived_at: null, household_id: 'household-1' } })
    const dining = snapshot.doc.categories[0]!
    expect(renameCategory(dining, 'Dining')).toBeNull()
    expect(renameCategory(dining, 'Eating out')).toEqual({ kind: 'edit_category', id: 'cat-dining', before: { name: 'Dining', archived_at: null }, after: { name: 'Eating out' } })
    expect(archiveCategory(dining, '2026-10-07T10:00:00.000Z')).toEqual({ kind: 'edit_category', id: 'cat-dining', before: { name: 'Dining', archived_at: null }, after: { archived_at: '2026-10-07T10:00:00.000Z' } })
  })

  it('offers System, Light and Dark for this device, with the one in use selected', () => {
    const options = [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ]
    expect(appearanceControl('system')).toEqual({ options, value: 'system' })
    expect(appearanceControl('dark')).toEqual({ options, value: 'dark' })
    expect(appearanceControl('light').value).toBe('light')
  })
})
