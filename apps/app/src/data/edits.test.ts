import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendEdit, type AccountValues, type Edit, type ItemValues, type Rewrite, type SavedAccount, type SavedItem, type SavedStatement } from './edits'
import { createWaypointClient } from './supabase'
import { memoryStorage } from './test-helpers'

const URL_BASE = 'http://127.0.0.1:54321'
const KEY = 'sb_publishable_test-key'

interface Sent {
  method: string
  url: URL
  body: unknown
  prefer: string | null
}

// A card payment's two legs moved two days later, from 1,000 to 1,250; and a lone expense with a new note.
const LEG_OUT: Rewrite = { id: 'r1', household_id: 'h1', account_id: 'a1', kind: 'transfer', transfer_id: 't1', before: { posted_on: '2026-10-05', amount_minor: -1000, description: 'Card payment, Oct (paid)' }, after: { posted_on: '2026-10-07', amount_minor: -1250, description: 'Card payment, Oct (paid)' } }
const LEG_IN: Rewrite = { id: 'r2', household_id: 'h1', account_id: 'a2', kind: 'transfer', transfer_id: 't1', before: { posted_on: '2026-10-06', amount_minor: 1000, description: 'Card payment, Oct (paid)' }, after: { posted_on: '2026-10-08', amount_minor: 1250, description: 'Card payment, Oct (paid)' } }
const EXPENSE: Rewrite = { id: 'r3', household_id: 'h1', account_id: 'a1', kind: 'expense', transfer_id: null, before: { posted_on: '2026-10-05', amount_minor: -400, description: '' }, after: { posted_on: '2026-10-05', amount_minor: -400, description: 'Coffee' } }
// What the table holds for each row as loaded.
const held = (r: Rewrite) => ({ id: r.id, ...r.before })

// Stands in for PostgREST: records each request and answers with the rows it changed.
function server(reply: (method: string) => Response = () => Response.json([{ id: 'row' }])) {
  const sent: Sent[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    sent.push({ method: init?.method ?? 'GET', url: new URL(href), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, prefer: new Headers(init?.headers).get('prefer') })
    return reply(init?.method ?? 'GET')
  }
  return { sent, client: createWaypointClient(URL_BASE, KEY, { storage: globalThis.localStorage, fetch: fetchImpl }) }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const filters = (url: URL) => [...url.searchParams.entries()]

describe('sendEdit', () => {
  it('sends each mark as one REST request on its table', async () => {
    const { sent, client } = server()
    const edits: Edit[] = [
      { kind: 'link', row_id: 'r1', plan_item_id: 'p1', period: '2026-10-01' },
      { kind: 'unlink', row_id: 'r1', plan_item_id: 'p1', period: '2026-10-01' },
      { kind: 'skips', plan_item_id: 'p1', before: ['2026-09-01'], after: ['2026-09-01', '2026-10-01'] },
      { kind: 'delete', row_id: 'r1', transfer_id: 't1' },
      { kind: 'rewrite', rows: [EXPENSE] },
    ]
    for (const edit of edits) await sendEdit(client, edit)
    expect(sent.map((s) => [s.method, s.url.pathname, filters(s.url), s.body])).toEqual([
      ['PATCH', '/rest/v1/transactions', [['id', 'eq.r1'], ['plan_item_id', 'is.null'], ['select', 'id']], { plan_item_id: 'p1', period: '2026-10-01' }],
      ['PATCH', '/rest/v1/transactions', [['id', 'eq.r1'], ['plan_item_id', 'eq.p1'], ['period', 'eq.2026-10-01'], ['select', 'id']], { plan_item_id: null, period: null }],
      ['PATCH', '/rest/v1/plan_items', [['id', 'eq.p1'], ['skip_periods', 'eq.{2026-09-01}'], ['select', 'id']], { skip_periods: ['2026-09-01', '2026-10-01'] }],
      ['DELETE', '/rest/v1/transactions', [['or', '(id.in.(r1),transfer_id.in.(t1))'], ['select', 'id']], null],
      // One row: only its day, amount and note, and only while it reads as loaded, so a row deleted elsewhere matches nothing.
      ['PATCH', '/rest/v1/transactions', [['id', 'eq.r3'], ['posted_on', 'eq.2026-10-05'], ['amount_minor', 'eq.-400'], ['description', 'eq.'], ['select', 'id']], { posted_on: '2026-10-05', amount_minor: -400, description: 'Coffee' }],
    ])
  })

  it('reads both legs of a transfer first, then moves them in one upsert of the edited columns only', async () => {
    const { sent, client } = server((method) => Response.json(method === 'GET' ? [held(LEG_IN), held(LEG_OUT)] : [{ id: 'r1' }, { id: 'r2' }]))
    await sendEdit(client, { kind: 'rewrite', rows: [LEG_OUT, LEG_IN] })
    const columns = ['id', 'household_id', 'account_id', 'kind', 'transfer_id', 'posted_on', 'amount_minor', 'description']
    expect(sent.map((s) => [s.method, filters(s.url), s.body])).toEqual([
      ['GET', [['select', 'id,posted_on,amount_minor,description'], ['id', 'in.(r1,r2)']], null],
      [
        'POST',
        [['on_conflict', 'id'], ['columns', columns.map((c) => `"${c}"`).join(',')], ['select', 'id']],
        [
          { id: 'r1', household_id: 'h1', account_id: 'a1', kind: 'transfer', transfer_id: 't1', posted_on: '2026-10-07', amount_minor: -1250, description: 'Card payment, Oct (paid)' },
          { id: 'r2', household_id: 'h1', account_id: 'a2', kind: 'transfer', transfer_id: 't1', posted_on: '2026-10-08', amount_minor: 1250, description: 'Card payment, Oct (paid)' },
        ],
      ],
    ])
    // A merge on id, which sets only the columns sent: the plan link, category and batch stay as the table holds them.
    expect(sent[1]?.prefer).toContain('resolution=merge-duplicates')
  })

  it('sends no upsert when a leg is gone or reads otherwise than loaded, so nothing deleted or changed elsewhere is written back', async () => {
    for (const found of [[held(LEG_OUT)], [], [held(LEG_OUT), { ...held(LEG_IN), amount_minor: 900 }], [held(LEG_OUT), { ...held(LEG_IN), posted_on: '2026-10-07' }], [held(LEG_OUT), { ...held(LEG_IN), description: 'Paid' }]]) {
      const { sent, client } = server(() => Response.json(found))
      await expect(sendEdit(client, { kind: 'rewrite', rows: [LEG_OUT, LEG_IN] })).rejects.toMatchObject({ kind: 'rejected', code: 'stale', message: 'This changed elsewhere since Waypoint loaded it, so nothing was saved. Check the latest and try again.' })
      expect(sent.map((s) => s.method)).toEqual(['GET'])
    }
  })

  it('reads a request that changed no row as a stale screen, and a refusal in plain words', async () => {
    const empty = server(() => Response.json([]))
    await expect(sendEdit(empty.client, { kind: 'delete', row_id: 'r1', transfer_id: null })).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
    expect(filters(empty.sent[0]!.url)).toEqual([
      ['or', '(id.in.(r1))'],
      ['select', 'id'],
    ])
    const refused = server(() => Response.json({ code: '42501', message: 'permission denied for table transactions', details: null, hint: null }, { status: 403 }))
    await expect(sendEdit(refused.client, { kind: 'link', row_id: 'r1', plan_item_id: 'p1', period: '2026-10-01' })).rejects.toMatchObject({ kind: 'not_allowed' })
    const checked = server(() => Response.json({ code: '23514', message: 'check_link: transaction r1: an expense links only to a bill', details: null, hint: null }, { status: 400 }))
    await expect(sendEdit(checked.client, { kind: 'link', row_id: 'r1', plan_item_id: 'p1', period: '2026-10-01' })).rejects.toMatchObject({ kind: 'rejected', code: '23514' })
  })
})

// A checked statement and the same one entered as Total only.
const CHECKED: SavedStatement = {
  id: 's1',
  household_id: 'h1',
  account_id: 'c1',
  cut_date: '2026-10-20',
  due_date: '2026-11-16',
  previous_balance_minor: 7000000,
  payments_and_credits_minor: 2500000,
  charges_minor: 200000,
  installments_minor: 500000,
  interest_minor: 152500,
  fees_minor: 0,
  total_due_minor: 5352500,
  minimum_due_minor: 160575,
  available_credit_minor: null,
}
const TOTAL_ONLY: SavedStatement = { ...CHECKED, previous_balance_minor: null, payments_and_credits_minor: null, charges_minor: null, installments_minor: null, interest_minor: null, fees_minor: null }

describe('statements', () => {
  it('adds a statement as one insert on its id, so a retry from the same sheet adds no second row', async () => {
    const { sent, client } = server()
    await sendEdit(client, { kind: 'add_statement', row: CHECKED })
    expect(sent.map((s) => [s.method, s.url.pathname, filters(s.url), s.body])).toEqual([['POST', '/rest/v1/statements', [['on_conflict', 'id'], ['select', 'id']], CHECKED]])
    expect(sent[0]?.prefer).toContain('resolution=merge-duplicates')
  })

  it('edits a statement only while every printed figure reads as loaded, an empty part included', async () => {
    const { sent, client } = server()
    await sendEdit(client, { kind: 'edit_statement', before: TOTAL_ONLY, after: CHECKED })
    const values = Object.fromEntries(Object.entries(CHECKED).filter(([column]) => !['id', 'household_id', 'account_id'].includes(column)))
    expect(sent.map((s) => [s.method, s.url.pathname, filters(s.url), s.body])).toEqual([
      [
        'PATCH',
        '/rest/v1/statements',
        [
          ['id', 'eq.s1'],
          ['cut_date', 'eq.2026-10-20'],
          ['due_date', 'eq.2026-11-16'],
          ['previous_balance_minor', 'is.null'],
          ['payments_and_credits_minor', 'is.null'],
          ['charges_minor', 'is.null'],
          ['installments_minor', 'is.null'],
          ['interest_minor', 'is.null'],
          ['fees_minor', 'is.null'],
          ['total_due_minor', 'eq.5352500'],
          ['minimum_due_minor', 'eq.160575'],
          ['available_credit_minor', 'is.null'],
          ['select', 'id'],
        ],
        values,
      ],
    ])
    const gone = server(() => Response.json([]))
    await expect(sendEdit(gone.client, { kind: 'edit_statement', before: CHECKED, after: TOTAL_ONLY })).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
  })

  it('names a second statement for the same cut, and leaves other refusals to the plain words', async () => {
    const twice = server(() => Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "statements_account_id_cut_date_key"', details: 'Key (account_id, cut_date)=(c1, 2026-10-20) already exists.', hint: null }, { status: 409 }))
    await expect(sendEdit(twice.client, { kind: 'add_statement', row: CHECKED })).rejects.toMatchObject({ kind: 'rejected', code: 'statement_exists', message: 'A statement for this date exists.' })
    const unbalanced = server(() => Response.json({ code: '23514', message: 'new row for relation "statements" violates check constraint "statements_balance_check"', details: null, hint: null }, { status: 400 }))
    await expect(sendEdit(unbalanced.client, { kind: 'add_statement', row: CHECKED })).rejects.toMatchObject({ kind: 'rejected', code: '23514' })
  })
})

const ITEM: SavedItem = {
  id: 'p1',
  household_id: 'h1',
  kind: 'bill',
  name: 'Rent',
  from_account_id: 'a1',
  to_account_id: null,
  category_id: null,
  amount_minor: 90000,
  every: 'month',
  starts_on: '2026-09-01',
  ends_on: null,
  roll: 'following',
  confidence: 'committed',
  stops_with_income: false,
  skip_periods: [],
}
const LOADED: ItemValues = { kind: 'bill', name: 'Rent', from_account_id: 'a1', to_account_id: null, category_id: null, amount_minor: 90000, every: 'month', starts_on: '2026-09-01', ends_on: null, roll: 'following', confidence: 'committed', stops_with_income: false }

describe('plan items', () => {
  it('adds an item on its id, saves one only while it reads as loaded, splits it by the database function and deletes it by id', async () => {
    const { sent, client } = server((method) => (method === 'POST' ? Response.json([{ id: 'p1' }]) : Response.json([{ id: 'p1' }])))
    await sendEdit(client, { kind: 'add_item', row: ITEM })
    await sendEdit(client, { kind: 'edit_item', id: 'p1', before: LOADED, after: { amount_minor: 95000 } })
    await sendEdit(client, { kind: 'delete_item', id: 'p1' })
    expect(sent.map((s) => [s.method, s.url.pathname, filters(s.url), s.body])).toEqual([
      ['POST', '/rest/v1/plan_items', [['on_conflict', 'id'], ['select', 'id']], ITEM],
      [
        'PATCH',
        '/rest/v1/plan_items',
        [
          ['id', 'eq.p1'],
          ['kind', 'eq.bill'],
          ['name', 'eq.Rent'],
          ['from_account_id', 'eq.a1'],
          ['to_account_id', 'is.null'],
          ['category_id', 'is.null'],
          ['amount_minor', 'eq.90000'],
          ['every', 'eq.month'],
          ['starts_on', 'eq.2026-09-01'],
          ['ends_on', 'is.null'],
          ['roll', 'eq.following'],
          ['confidence', 'eq.committed'],
          ['stops_with_income', 'eq.false'],
          ['select', 'id'],
        ],
        // skip_periods is never sent, so a Skip made elsewhere survives.
        { amount_minor: 95000 },
      ],
      ['DELETE', '/rest/v1/plan_items', [['id', 'eq.p1'], ['select', 'id']], null],
    ])
    expect(sent[0]?.prefer).toContain('resolution=merge-duplicates')
    const split = server(() => Response.json('6f1c0000-0000-4000-8000-000000000001'))
    await sendEdit(split.client, { kind: 'split_item', id: 'p1', from: '2026-11-01', patch: { amount_minor: 95000 } })
    expect(split.sent.map((s) => [s.method, s.url.pathname, s.body])).toEqual([['POST', '/rest/v1/rpc/split_plan_item', { p_id: 'p1', p_from: '2026-11-01', p_patch: { amount_minor: 95000 } }]])
    const gone = server(() => Response.json([]))
    await expect(sendEdit(gone.client, { kind: 'edit_item', id: 'p1', before: LOADED, after: { ends_on: '2026-10-31' } })).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
  })

  it('names what refused a plan item change, with its own words as detail', async () => {
    const linked = server(() => Response.json({ code: '23503', message: 'update or delete on table "plan_items" violates foreign key constraint "transactions_plan_item_fkey" on table "transactions"', details: null, hint: null }, { status: 409 }))
    await expect(sendEdit(linked.client, { kind: 'delete_item', id: 'p1' })).rejects.toMatchObject({ kind: 'rejected', code: 'linked', message: 'Payments are linked to this item, so it cannot be deleted. End it instead.' })
    const routed = server(() => Response.json({ code: '23514', message: 'check_plan_item: plan item p1: its linked transactions fix its kind and accounts; split_plan_item changes the accounts from a later period', details: null, hint: null }, { status: 400 }))
    await expect(sendEdit(routed.client, { kind: 'edit_item', id: 'p1', before: LOADED, after: { from_account_id: 'a2' } })).rejects.toMatchObject({
      kind: 'rejected',
      code: 'check_plan_item',
      detail: 'its linked transactions fix its kind and accounts; split_plan_item changes the accounts from a later period',
    })
    const split = server(() => Response.json({ code: 'P0001', message: 'bad_split: the occurrence 2026-12-01 is linked or skipped, and the new row has no occurrence to take it; unlink or unskip it first', details: null, hint: null }, { status: 400 }))
    await expect(sendEdit(split.client, { kind: 'split_item', id: 'p1', from: '2026-11-01', patch: { every: 'week' } })).rejects.toMatchObject({
      kind: 'rejected',
      code: 'bad_split',
      detail: 'the occurrence 2026-12-01 is linked or skipped, and the new row has no occurrence to take it; unlink or unskip it first',
    })
  })
})

// A card as loaded, with its terms and floor windows as the JSON columns hold them.
const TERMS = { cut_day: 5, due: { day_of_month: 28 }, due_roll: 'none', interest: { method: 'average_daily_balance', rate: 0.24, period: 'year', day_count: 365, payment_effective_lag_days: 0 }, minimum: { pct: 0.01, add_installments: false, add_interest: true, add_fees: true, floor_minor: 3500, rounding: 'half_up' }, pay: { mode: 'minimum', on: 'due_date' }, preset: 'US-generic' } as const
const CARD: SavedAccount = { id: 'c1', household_id: 'h1', name: 'Travel card', kind: 'credit_card', currency: 'USD', opening_balance_minor: -125000, opening_date: '2026-10-09', terms: TERMS, funded_from_account_id: 'a1', floor_windows: [], fx_fee_pct: null, csv_mapping: null, sort_order: 5, archived_at: null }
const CARD_VALUES: AccountValues = { name: 'Travel card', kind: 'credit_card', currency: 'USD', opening_balance_minor: -125000, opening_date: '2026-10-09', terms: TERMS, funded_from_account_id: 'a1', floor_windows: [], fx_fee_pct: null, archived_at: null }

describe('settings', () => {
  it('saves the household, an account and a category each as one guarded request, matching JSON columns by value', async () => {
    const { sent, client } = server()
    await sendEdit(client, { kind: 'edit_household', id: 'h1', before: { base_currency: 'EUR', timezone: 'Europe/Madrid', locale: 'en-PH', payoff_order: 'avalanche' }, after: { payoff_order: 'list' } })
    await sendEdit(client, { kind: 'add_account', row: CARD })
    await sendEdit(client, { kind: 'edit_account', id: 'c1', before: CARD_VALUES, after: { funded_from_account_id: 'a2' } })
    await sendEdit(client, { kind: 'add_category', row: { id: 'k1', household_id: 'h1', name: 'Transport', archived_at: null } })
    await sendEdit(client, { kind: 'edit_category', id: 'k1', before: { name: 'Transport', archived_at: null }, after: { archived_at: '2026-10-09T10:00:00.000Z' } })
    expect(sent.map((s) => [s.method, s.url.pathname, filters(s.url), s.body])).toEqual([
      ['PATCH', '/rest/v1/households', [['id', 'eq.h1'], ['base_currency', 'eq.EUR'], ['timezone', 'eq.Europe/Madrid'], ['locale', 'eq.en-PH'], ['payoff_order', 'eq.avalanche'], ['select', 'id']], { payoff_order: 'list' }],
      ['POST', '/rest/v1/accounts', [['on_conflict', 'id'], ['select', 'id']], CARD],
      [
        'PATCH',
        '/rest/v1/accounts',
        [
          ['id', 'eq.c1'],
          ['name', 'eq.Travel card'],
          ['kind', 'eq.credit_card'],
          ['currency', 'eq.USD'],
          ['opening_balance_minor', 'eq.-125000'],
          ['opening_date', 'eq.2026-10-09'],
          ['terms', `eq.${JSON.stringify(TERMS)}`],
          ['funded_from_account_id', 'eq.a1'],
          ['floor_windows', 'eq.[]'],
          ['fx_fee_pct', 'is.null'],
          ['archived_at', 'is.null'],
          ['select', 'id'],
        ],
        // csv_mapping and sort_order are never sent, so a mapping an import saved elsewhere survives.
        { funded_from_account_id: 'a2' },
      ],
      ['POST', '/rest/v1/categories', [['on_conflict', 'id'], ['select', 'id']], { id: 'k1', household_id: 'h1', name: 'Transport', archived_at: null }],
      ['PATCH', '/rest/v1/categories', [['id', 'eq.k1'], ['name', 'eq.Transport'], ['archived_at', 'is.null'], ['select', 'id']], { archived_at: '2026-10-09T10:00:00.000Z' }],
    ])
    expect(sent[1]?.prefer).toContain('resolution=merge-duplicates')
    const gone = server(() => Response.json([]))
    await expect(sendEdit(gone.client, { kind: 'edit_account', id: 'c1', before: CARD_VALUES, after: { name: 'Card' } })).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
  })

  it('names a second category of the same name, ignoring case', async () => {
    const twice = server(() => Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "categories_household_id_name_key"', details: null, hint: null }, { status: 409 }))
    await expect(sendEdit(twice.client, { kind: 'add_category', row: { id: 'k2', household_id: 'h1', name: 'transport', archived_at: null } })).rejects.toMatchObject({ kind: 'rejected', code: 'category_exists', message: 'A category with this name exists.' })
  })
})

describe('imports', () => {
  it('remembers an account’s CSV columns in that column alone, and undoes an import by its batch id', async () => {
    const { sent, client } = server()
    const mapping = { date: 'Date', date_order: 'dmy', amount: { column: 'Amount' }, decimal: '.', description: 'Description', reference: 'TransferWise ID' } as const
    await sendEdit(client, { kind: 'csv_mapping', account_id: 'a1', mapping })
    await sendEdit(client, { kind: 'delete_batch', batch_id: 'b1' })
    expect(sent.map((s) => [s.method, s.url.pathname, filters(s.url), s.body])).toEqual([
      ['PATCH', '/rest/v1/accounts', [['id', 'eq.a1'], ['select', 'id']], { csv_mapping: mapping }],
      ['DELETE', '/rest/v1/transactions', [['batch_id', 'eq.b1'], ['select', 'id']], null],
    ])
    // Undone already, on another device: nothing left to delete.
    const gone = server(() => Response.json([]))
    await expect(sendEdit(gone.client, { kind: 'delete_batch', batch_id: 'b1' })).rejects.toMatchObject({ kind: 'rejected', code: 'stale' })
  })
})
