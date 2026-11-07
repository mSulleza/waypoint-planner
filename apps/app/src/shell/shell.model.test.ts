import { buildSnapshot, parseRates } from '@waypoint/core'
import { abroad, usCardsCar } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import ecb from '../../../../packages/core/test/fixtures/frankfurter-2026-10-07.json'
import { AS_OF } from '../data/test-helpers'
import { chrome, fxPairs, householdCurrencies, lastAccountId, SIDEBAR_MIN_WIDTH, followRoute, landedHere, NO_LANDING, parentOf } from './shell.model'

const ECB = parseRates(ecb)

describe('chrome', () => {
  it('puts Settings in the header of every tab and page below 1,024 px, and in the sidebar from there on the tabs', () => {
    for (const width of [320, 360, 390, 640, 1023]) {
      expect(chrome('tab', width)).toEqual({ sidebar: false, back: false, add: true, settings: true, fx: true })
      expect(chrome('page', width)).toEqual({ sidebar: false, back: true, add: false, settings: true, fx: false })
    }
    for (const width of [SIDEBAR_MIN_WIDTH, 1100, 1280]) {
      expect(chrome('tab', width)).toEqual({ sidebar: true, back: false, add: true, settings: false, fx: false })
      // Pages have no sidebar, so their header keeps Settings at any width.
      expect(chrome('page', width).settings).toBe(true)
    }
  })

  it('leaves Settings out only on the settings pages themselves', () => {
    expect(chrome('page', 390, true).settings).toBe(false)
    expect(chrome('page', 1280, true).settings).toBe(false)
  })

  it('gives onboarding only the eye at any width: the tabs, Settings and Back are closed to it', () => {
    for (const width of [320, 390, 1280]) expect(chrome('flow', width)).toEqual({ sidebar: false, back: false, add: false, settings: false, fx: false })
  })
})

describe('fxPairs', () => {
  it('reads the ECB day as one euro in pesos for a household with EUR and PHP', () => {
    expect(fxPairs('EUR', ['EUR', 'PHP'], ECB)).toEqual([{ from: 'EUR', to: 'PHP', unit_minor: 100, quote_minor: 7020 }])
  })

  it('puts the stronger currency first whichever is the base, so the rate reads above 1', () => {
    expect(fxPairs('PHP', ['PHP', 'EUR'], ECB)).toEqual([{ from: 'EUR', to: 'PHP', unit_minor: 100, quote_minor: 7020 }])
    expect(fxPairs('USD', ['USD', 'EUR'], ECB)).toEqual([{ from: 'EUR', to: 'USD', unit_minor: 100, quote_minor: 112 }])
    expect(fxPairs('GBP', ['GBP', 'EUR'], ECB)).toEqual([{ from: 'GBP', to: 'EUR', unit_minor: 100, quote_minor: 118 }])
    expect(fxPairs('JPY', ['JPY', 'EUR'], ECB)).toEqual([{ from: 'EUR', to: 'JPY', unit_minor: 100, quote_minor: 177 }])
  })

  it('lists each other currency against the base, and nothing for one currency or a currency with no rate', () => {
    expect(fxPairs('EUR', ['EUR', 'USD', 'PHP'], ECB).map((p) => `${p.from}>${p.to}`)).toEqual(['EUR>PHP', 'EUR>USD'])
    expect(fxPairs('USD', ['USD'], ECB)).toEqual([])
    expect(fxPairs('EUR', ['EUR', 'PHP'], ECB.filter((r) => r.quote !== 'PHP'))).toEqual([])
  })

  it('takes the base and the open accounts as the household currencies', () => {
    const sample = abroad(AS_OF)
    const snapshot = buildSnapshot(sample.doc, AS_OF, sample.rates)
    expect(householdCurrencies(snapshot.doc)).toEqual(['EUR', 'PHP'])
    expect(fxPairs('EUR', householdCurrencies(snapshot.doc), snapshot.rates)).toEqual([{ from: 'EUR', to: 'PHP', unit_minor: 100, quote_minor: 7000 }])
    const us = usCardsCar(AS_OF)
    expect(householdCurrencies(buildSnapshot(us.doc, AS_OF, us.rates).doc)).toEqual(['USD'])
  })
})

describe('lastAccountId', () => {
  const sample = abroad(AS_OF)
  const doc = buildSnapshot(sample.doc, AS_OF, sample.rates).doc

  it('opens the Add sheet on the account money last went out of', () => {
    expect(lastAccountId(doc)).toBe('main')
  })

  it('skips archived accounts and falls back to the first open cash account', () => {
    const archived = { ...doc, accounts: doc.accounts.map((a) => (a.id === 'main' ? { ...a, archived_at: '2026-10-01T00:00:00+00:00' } : a)) }
    expect(lastAccountId(archived)).toBe('rewards-card')
    expect(lastAccountId({ ...doc, transactions: [] })).toBe('main')
    expect(lastAccountId({ ...doc, accounts: [], transactions: [] })).toBeNull()
  })
})

describe('Back from a page the app opened on', () => {
  it('names each page’s list, and none for the tabs, Settings and pages with no list', () => {
    const paths = ['/money/main', '/debts/rewards-card', '/plan/item/rent', '/plan/compare', '/settings/account/new', '/import', '/settings', '/', '/money', '/delete-account', '/plan/item/rent/extra']
    expect(paths.map(parentOf)).toEqual(['/money', '/debts', '/plan', '/plan', '/settings', '/settings', null, null, null, null, null])
  })

  it('counts a page as landed on only until the person moves, even back to it', () => {
    let landing = followRoute(NO_LANDING, '/money/main')
    expect(landedHere(landing, '/money/main')).toBe(true)
    landing = followRoute(landing, '/money/main')
    expect(landedHere(landing, '/money/main')).toBe(true)
    landing = followRoute(landing, '/money')
    landing = followRoute(landing, '/money/main')
    expect([landedHere(landing, '/money/main'), landing.moved]).toEqual([false, true])
    expect(landedHere(followRoute(NO_LANDING, '/'), '/money/main')).toBe(false)
  })
})
