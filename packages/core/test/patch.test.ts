import { describe, expect, it } from 'vitest'
import { parsePatch } from '../src/schema/patch'

const ALLOWED = 'allowed keys: fx_shift_pct, items, add, accounts, income_gap'

describe('parsePatch', () => {
  it('rejects an unknown patch key with an error that lists the allowed keys', () => {
    expect(parsePatch({ fx_rate: 75 })).toEqual({ ok: false, errors: [`(root): Unknown key 'fx_rate'; ${ALLOWED}`] })
    expect(parsePatch({ items: { rent: { amount: 120000 } } })).toEqual({
      ok: false,
      errors: ["items.rent: Unknown key 'amount'; allowed keys: amount_minor, day, from_month, ends_on, removed, include_upside"],
    })
  })

  it('returns three errors in one object together', () => {
    expect(parsePatch({ fx_rate: 75, fx_shift_pct: 5, income_gap: { from_month: '2026-11', months: 0 } })).toEqual({
      ok: false,
      errors: ['fx_shift_pct: must be a fraction below 1, such as 0.1 for 10% stronger', 'income_gap.months: must be 1 to 60', `(root): Unknown key 'fx_rate'; ${ALLOWED}`],
    })
  })

  it('returns bad JSON as a named error', () => {
    const result = parsePatch('{"fx_shift_pct": -0.1,')
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.errors).toEqual([expect.stringMatching(/^bad_json: /)])
  })

  it('is lenient on shape, reading JSON text, a patch wrapped in {patch} and no patch at all', () => {
    const patch = { fx_shift_pct: -0.1, items: { rent: { amount_minor: 120000, from_month: '2027-03' } } }
    expect(parsePatch(JSON.stringify(patch))).toEqual({ ok: true, value: patch })
    expect(parsePatch({ patch })).toEqual({ ok: true, value: patch })
    expect(parsePatch(undefined)).toEqual({ ok: true, value: {} })
    expect(parsePatch({}).ok).toBe(true)
    expect(parsePatch([patch])).toEqual({ ok: false, errors: ['(root): Invalid input: expected object, received array'] })
  })

  it('applies amount and day changes from a month, and keeps a missing ends_on apart from an explicit null', () => {
    expect(parsePatch({ items: { salary: { day: 25 } } })).toEqual({ ok: false, errors: ['items.salary.from_month: amount_minor and day apply from a month; add from_month'] })
    expect(parsePatch({ items: { salary: { from_month: '2026-11' } } })).toEqual({ ok: false, errors: ['items.salary.from_month: from_month needs amount_minor or day'] })
    expect(parsePatch({ items: { salary: { day: 25, from_month: '2026-11' } } }).ok).toBe(true)
    const ended = parsePatch({ items: { gym: { ends_on: '2026-12-31' }, loan: { ends_on: null }, phone: { include_upside: true } } })
    expect(ended).toEqual({ ok: true, value: { items: { gym: { ends_on: '2026-12-31' }, loan: { ends_on: null }, phone: { include_upside: true } } } })
    expect(ended.ok && 'ends_on' in (ended.value.items?.phone ?? {})).toBe(false)
  })

  it('takes no other change on a removed item, and no zero amount', () => {
    expect(parsePatch({ items: { gym: { removed: true, ends_on: '2026-12-31' }, rent: { amount_minor: 0, from_month: '2026-11' } } })).toEqual({
      ok: false,
      errors: ['items.gym.removed: a removed item takes no other change', 'items.rent.amount_minor: must not be 0'],
    })
  })

  it('checks added plan items, floor windows and the income gap like rows', () => {
    const extra = { id: 'extra', kind: 'transfer', name: 'Extra for debts', from_account_id: 'main', amount_minor: 30000, starts_on: '2026-11-01' }
    const ok = parsePatch({ add: [extra], accounts: { main: { floor_windows: [{ from_month: '2026-11', to_month: null, amount_minor: 300000 }] } }, income_gap: { from_month: '2026-11', months: 6, item_ids: ['salary'] } })
    expect(ok.ok && ok.value.add?.[0]).toMatchObject({ ...extra, to_account_id: null, every: 'month' })
    expect(parsePatch({ add: [{ ...extra, kind: 'bill', category_id: 'fun' }], accounts: { main: { floor_windows: [{ from_month: '2026-11', amount_minor: -1, to_month: null }] } }, income_gap: { from_month: '2026-11', months: 3, item_ids: [] } })).toEqual({
      ok: false,
      errors: [
        'add[0].category_id: only an allowance takes a category',
        'accounts.main.floor_windows[0].amount_minor: must not be negative',
        'income_gap.item_ids: must name at least one item, or be left out to stop every income item',
      ],
    })
  })

  it('keeps fx_shift_pct a fraction above −1 and below 1', () => {
    expect(parsePatch({ fx_shift_pct: -0.25 }).ok).toBe(true)
    expect(parsePatch({ fx_shift_pct: -1 })).toEqual({ ok: false, errors: ['fx_shift_pct: must be a fraction above −1, such as −0.1 for 10% weaker'] })
  })
})
