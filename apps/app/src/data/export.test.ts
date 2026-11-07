import { checkInput, importDoc } from '@waypoint/core'
import { describe, expect, it } from 'vitest'
import { DataError } from './errors'
import { exportFileName, exportHousehold } from './export'
import { abroadDoc, fakeClient, ok } from './test-helpers'

// 22:30 UTC on 7 Oct is already 8 Oct in Madrid, the abroad household's zone.
const LATE = new Date('2026-10-07T22:30:00Z')

const NO_MEALS = { settings: null, items: [], purchases: [], recipes: [], recipe_items: [], meals: [], trips: [] }

describe('exportHousehold', () => {
  it('makes one export_household call into a file dated by the household’s day, in the format import_household takes', async () => {
    const doc = abroadDoc()
    const client = fakeClient({ export_household: () => ok(doc), export_meals: () => ok(NO_MEALS) })
    const file = await exportHousehold(client, LATE)
    expect(client.calls).toEqual(['export_household', 'export_meals'])
    expect(file?.name).toBe('waypoint-export-2026-10-08.json')
    expect(file?.text.endsWith('}\n')).toBe(true)
    const parsed: unknown = JSON.parse(file!.text)
    expect(parsed).toEqual(doc)
    expect(checkInput(importDoc, parsed).ok).toBe(true)
  })

  it('writes the export as it came, even when it would not pass the app’s checks, and dates a zone it cannot read in UTC', async () => {
    const odd = { version: 1, household: { timezone: 'Mars/Olympus' }, accounts: [{ id: 'x', name: '' }] }
    const file = await exportHousehold(fakeClient({ export_household: () => ok(odd), export_meals: () => ok(NO_MEALS) }), LATE)
    expect(file?.name).toBe(exportFileName('2026-10-07'))
    expect(JSON.parse(file!.text)).toEqual(odd)
  })

  it('answers null for an account with no household, and a refused or failed read as a DataError', async () => {
    expect(await exportHousehold(fakeClient({ export_household: () => ok(null) }), LATE)).toBeNull()
    const refused = exportHousehold(fakeClient({ export_household: () => ({ data: null, error: { message: 'JWT expired', code: 'PGRST303' }, status: 401 }) }), LATE)
    await expect(refused).rejects.toMatchObject({ kind: 'signed_out', code: 'PGRST303' })
    const offline = exportHousehold(fakeClient({ export_household: () => ({ data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }) }), LATE)
    await expect(offline).rejects.toBeInstanceOf(DataError)
    await expect(offline).rejects.toMatchObject({ kind: 'network' })
  })

  it('carries the meals under their own key when the household has any, so a re-import keeps them', async () => {
    const doc = abroadDoc()
    const meals = { ...NO_MEALS, settings: { category_id: null, currency: 'EUR', shop_weekday: 5, people: 2 }, trips: [{ id: 't1', day: '2026-10-10' }] }
    const file = await exportHousehold(fakeClient({ export_household: () => ok(doc), export_meals: () => ok(meals) }), LATE)
    const parsed: unknown = JSON.parse(file!.text)
    expect(parsed).toEqual({ ...doc, meals })
    expect(checkInput(importDoc, parsed).ok).toBe(true)
  })
})
