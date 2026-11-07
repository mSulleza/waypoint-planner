import { accountRow, buildSnapshot, termsFromPreset, type Account, type Snapshot } from '@waypoint/core'
import { abroad, markSize, mortgage, usCardsCar, type Sample, type SampleDoc } from '@waypoint/core/fixtures'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_SCHEMA,
  accountChecks,
  archiveAccount,
  changedElsewhere,
  draftOfAccount,
  fieldOf,
  funderChoices,
  inUse,
  matchesPreset,
  newAccountDraft,
  newFloor,
  percentText,
  readableFloors,
  readAccount,
  readFee,
  saveAccount,
  shownCurrency,
  withKind,
  withPreset,
  type AccountDraft,
} from './account.model'

const AS_OF = '2026-10-07'
const LOCALE = 'en-PH'

function snapshotOf(build: (asOf: string) => Sample = abroad, edit?: (doc: SampleDoc) => void): Snapshot {
  const sample = build(AS_OF)
  edit?.(sample.doc)
  return buildSnapshot(sample.doc, AS_OF, sample.rates)
}

const account = (snapshot: Snapshot, id: string): Account => {
  const found = snapshot.doc.accounts.find((a) => a.id === id)
  if (!found) throw new Error(`no account ${id}`)
  return found
}

// What the editor saves: the draft read, then checked by the schema the database mirrors.
function rowOf(snapshot: Snapshot, draft: AccountDraft, id: string, loaded: Account | null): { row: Account | null; errors: Record<string, string | undefined> } {
  const { input, errors } = readAccount(snapshot, draft, { id, locale: LOCALE, loaded })
  const parsed = ACCOUNT_SCHEMA.safeParse(input)
  if (Object.keys(errors).length > 0) return { row: null, errors }
  if (!parsed.success) return { row: null, errors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) }
  return { row: parsed.data, errors: {} }
}

describe('account editor model', () => {
  it('reads every account of every sample back to the row it came from', () => {
    for (const build of [abroad, usCardsCar, mortgage, markSize]) {
      const snapshot = snapshotOf(build)
      for (const a of snapshot.doc.accounts) {
        const { row, errors } = rowOf(snapshot, draftOfAccount(snapshot, a, LOCALE), a.id, a)
        expect(errors, `${a.id}`).toEqual({})
        expect(row, `${a.id}`).toEqual(a)
        expect(saveAccount(a, row as Account)).toBeNull()
      }
    }
  })

  it('adds a card copied from a preset named by behaviour, owed below zero and paid from the first cash account', () => {
    const snapshot = snapshotOf()
    let draft = newAccountDraft(snapshot, { kind: 'credit_card' }, LOCALE)
    expect([draft.kind, draft.funded_from, draft.preset, draft.balance]).toEqual(['credit_card', 'main', 'generic-in-full', '0'])
    draft = { ...withPreset(draft, 'US-generic', LOCALE), name: 'Travel card', balance: '1250', cut_day: '5', due: '28' }
    const { row } = rowOf(snapshot, draft, 'new-card', null)
    expect(row).toEqual({
      id: 'new-card',
      name: 'Travel card',
      kind: 'credit_card',
      currency: 'USD',
      opening_balance_minor: -125000,
      opening_date: AS_OF,
      terms: termsFromPreset('US-generic', { cut_day: 5, due: { day_of_month: 28 }, due_roll: 'none' }),
      funded_from_account_id: 'main',
      floor_windows: [],
      fx_fee_pct: null,
      csv_mapping: null,
      sort_order: 5,
      archived_at: null,
    })
    expect(matchesPreset(row)).toBe(true)
    // Every term stays editable; a changed rate no longer reads as the preset's.
    const changed = rowOf(snapshot, { ...draft, rate: '19.99', due_kind: 'days_after_cut', due: '21', pay_on: 'days_after_cut', pay_days: '18' }, 'new-card', null).row
    expect(changed?.kind === 'credit_card' && [changed.terms.interest.rate, changed.terms.due, changed.terms.pay.on]).toEqual([0.1999, { days_after_cut: 21 }, { days_after_cut: 18 }])
    expect(matchesPreset(changed)).toBe(false)
  })

  it('keeps the preset’s payment lag, which has no field, through an edit of another term, and takes the next preset’s', () => {
    const snapshot = snapshotOf()
    const draft = { ...withPreset(newAccountDraft(snapshot, { kind: 'credit_card' }, LOCALE), 'PH-daily-unpaid', LOCALE), name: 'Peso card', balance: '1250', cut_day: '2', due: '23' }
    const lagOf = (d: typeof draft) => {
      const row = rowOf(snapshot, d, 'new-card', null).row
      return row?.kind === 'credit_card' ? row.terms.interest.payment_effective_lag_days : null
    }
    expect([lagOf(draft), lagOf({ ...draft, rate: '2.5' }), lagOf(withPreset(draft, 'PH-round-up', LOCALE))]).toEqual([1, 1, 0])
  })

  it('keeps a card’s currency when a preset is picked on a card with transactions', () => {
    const snapshot = snapshotOf()
    const draft = draftOfAccount(snapshot, account(snapshot, 'rewards-card'), LOCALE)
    expect(withPreset(draft, 'US-generic', LOCALE, true).currency).toBe('PHP')
    expect(withPreset(draft, 'US-generic', LOCALE).currency).toBe('USD')
  })

  it('adds a loan with its balance owed, yearly rate, payment and day, and a cash account with floor windows and a fee', () => {
    const snapshot = snapshotOf()
    const loan = { ...newAccountDraft(snapshot, { kind: 'loan' }, LOCALE), name: 'Car loan', balance: '18000', loan_rate: '6.9', payment: '355.58', payment_day: '20' }
    const loanRow = rowOf(snapshot, loan, 'loan', null).row
    expect(loanRow && [loanRow.kind, loanRow.currency, loanRow.opening_balance_minor, loanRow.terms, loanRow.funded_from_account_id]).toEqual(['loan', 'EUR', -1800000, { annual_rate: 0.069, payment_minor: 35558, payment_day: 20 }, 'main'])
    const floors = [
      { ...newFloor('2026-10'), amount: '700' },
      { ...newFloor('2026-11'), open: false, to_month: '2028-12', amount: '350' },
    ]
    const cash = { ...newAccountDraft(snapshot, {}, LOCALE), name: 'Savings', balance: '-12.50', floors, fx_fee: '0.736', funded_from: 'main' }
    const cashRow = rowOf(snapshot, cash, 'savings', null).row
    expect(cashRow && [cashRow.opening_balance_minor, cashRow.floor_windows, cashRow.fx_fee_pct, cashRow.funded_from_account_id]).toEqual([
      -1250,
      [
        { from_month: '2026-10', to_month: null, amount_minor: 70000 },
        { from_month: '2026-11', to_month: '2028-12', amount_minor: 35000 },
      ],
      0.00736,
      'main',
    ])
    expect(readableFloors({ ...cash, floors: [...floors, { ...newFloor('2026-12'), amount: 'ten' }] }, 'EUR', LOCALE)).toHaveLength(2)
    // A code still being typed shows amounts in the fallback, so nothing formats in a currency that does not exist.
    expect([shownCurrency('U', 'EUR'), shownCurrency('usd', 'EUR')]).toEqual(['EUR', 'USD'])
  })

  it('names each unreadable answer beside its field', () => {
    const snapshot = snapshotOf()
    const card = { ...newAccountDraft(snapshot, { kind: 'credit_card' }, LOCALE), name: ' ', cut_day: '32', due: '', rate: 'lots', funded_from: null }
    expect(rowOf(snapshot, card, 'x', null).errors).toEqual({
      name: 'Type a name.',
      cut_day: 'Type a day of the month, 1 to 31.',
      due: 'Type a day of the month, 1 to 31.',
      'interest.rate': 'Type a percent such as 3.5.',
      funded_from_account_id: 'Pick the account that pays it.',
    })
    const loan = { ...newAccountDraft(snapshot, { kind: 'loan' }, LOCALE), name: 'Loan', balance: '0', loan_rate: '5', payment: '100', payment_day: '1' }
    expect(rowOf(snapshot, loan, 'x', null).errors).toEqual({ opening_balance_minor: 'Type more than 0.' })
    const cash = { ...newAccountDraft(snapshot, {}, LOCALE), name: 'Cash', currency: 'XX', floors: [{ ...newFloor('2026-11'), open: false, to_month: '2026-10', amount: '5' }], fx_fee: '0.7364' }
    expect(rowOf(snapshot, cash, 'x', null).errors).toEqual({
      currency: 'Enter a three-letter currency code, such as EUR or USD.',
      'floor_windows.0.to_month': 'Ends before it starts. Pick a later month, or no end.',
      fx_fee_pct: 'Type a percent with at most 3 decimals, such as 0.736.',
    })
  })

  it('offers as payer only cash accounts that it does not top up, directly or through another', () => {
    const snapshot = snapshotOf()
    expect(funderChoices(snapshot, 'main', null).map((a) => a.id)).toEqual(['tax'])
    expect(funderChoices(snapshot, 'pesos', 'main').map((a) => a.id)).toEqual(['main', 'tax'])
    expect(funderChoices(snapshot, 'new', null).map((a) => a.id)).toEqual(['main', 'tax', 'pesos'])
  })

  it('refuses what the engine would refuse for the whole household: a funding circle, a payer with no rate, rows before the opening date, a kind or currency under rows', () => {
    const snapshot = snapshotOf()
    const main = account(snapshot, 'main')
    const circle = accountChecks(snapshot, { ...main, funded_from_account_id: 'pesos' }, main, LOCALE)
    expect(circle).toEqual({ funded_from_account_id: 'Pesos is topped up from this account, so it cannot top this one up.' })
    expect(accountChecks(snapshot, { ...main, opening_date: '2026-09-10' }, main, LOCALE)).toEqual({ opening_date: 'Its first transaction is on Sep 1, 2026, so it must open on or before then.' })
    expect(accountChecks(snapshot, { ...main, currency: 'USD' }, main, LOCALE)).toEqual({ currency: 'It has transactions or plan items in EUR, so its currency stays.' })
    const noRate = accountChecks(snapshot, { ...main, id: 'dirham', currency: 'AED', funded_from_account_id: 'main' }, null, LOCALE)
    expect(noRate).toEqual({ funded_from_account_id: 'No reference rate for AED, so money cannot move from Main to this account.' })
    const kindChange = accountChecks(snapshot, { ...main, kind: 'credit_card' } as unknown as Account, main, LOCALE)
    expect(kindChange.kind).toBe('It has transactions or plan items, so its kind stays.')
    expect(inUse(snapshot, 'tax')).toBe(true)
  })

  it('saves only the columns that changed, guarded on the row as loaded, and archives by archived_at alone', () => {
    const snapshot = snapshotOf()
    const pesos = account(snapshot, 'pesos')
    const draft = draftOfAccount(snapshot, pesos, LOCALE)
    const raised = { ...draft, floors: draft.floors.map((f) => ({ ...f, amount: '40000' })), funded_from: 'tax' }
    const row = rowOf(snapshot, raised, 'pesos', pesos).row as Account
    const edit = saveAccount(pesos, row)
    expect(edit?.kind === 'edit_account' && edit.after).toEqual({ funded_from_account_id: 'tax', floor_windows: [{ from_month: '2026-10', to_month: null, amount_minor: 4000000 }] })
    expect(edit?.kind === 'edit_account' && [edit.id, edit.before.floor_windows, edit.before.funded_from_account_id, Object.keys(edit.before).sort()]).toEqual([
      'pesos',
      pesos.floor_windows,
      'main',
      ['archived_at', 'currency', 'floor_windows', 'funded_from_account_id', 'fx_fee_pct', 'kind', 'name', 'opening_balance_minor', 'opening_date', 'terms'],
    ])
    expect(archiveAccount(pesos, '2026-10-07T10:00:00.000Z')).toMatchObject({ kind: 'edit_account', id: 'pesos', after: { archived_at: '2026-10-07T10:00:00.000Z' } })
    // Key order in a JSON column does not count as a change, as Postgres compares jsonb.
    const reordered = { ...pesos, floor_windows: [{ amount_minor: 2000000, to_month: null, from_month: '2026-10' }] }
    expect(changedElsewhere(pesos, reordered)).toBe(false)
    expect(changedElsewhere(pesos, { ...pesos, name: 'Pesos wallet' })).toBe(true)
  })

  it('switches kind with a payer for a debt and none for cash, and keeps a loan from opening at 0 owed', () => {
    const snapshot = snapshotOf()
    const cash = newAccountDraft(snapshot, {}, LOCALE)
    const loan = withKind(snapshot, cash, 'loan', null)
    expect([loan.funded_from, loan.balance, loan.currency]).toEqual(['main', '', 'EUR'])
    const back = withKind(snapshot, { ...loan, funded_from: 'pesos' }, 'cash', null)
    expect([back.funded_from, back.balance]).toEqual([null, '0'])
    expect(withKind(snapshot, cash, 'credit_card', null).currency).toBe('EUR')
  })

  it('reads percents exactly and shows fractions as typed percents', () => {
    expect([percentText(0.00736, LOCALE), percentText(0.035, LOCALE), percentText(0.24, LOCALE), percentText(0.069, 'es-ES')]).toEqual(['0.736', '3.5', '24', '6,9'])
    expect([readFee('0.736'), readFee('0,736 %'), readFee('0.7364'), readFee('20')]).toEqual([0.00736, 0.00736, null, 0.2])
    expect(accountRow.safeParse({ id: 'a', name: 'A', kind: 'cash', currency: 'EUR', opening_date: AS_OF, fx_fee_pct: 0.2 }).success).toBe(false)
  })

  it('keys each schema issue to the field that shows it', () => {
    expect([fieldOf(['terms', 'interest', 'rate']), fieldOf(['terms', 'pay', 'on', 'days_after_cut']), fieldOf(['terms', 'cut_day']), fieldOf(['floor_windows', 1, 'to_month']), fieldOf(['name']), fieldOf([])]).toEqual([
      'interest.rate',
      'pay.on',
      'cut_day',
      'floor_windows.1.to_month',
      'name',
      'name',
    ])
  })
})
