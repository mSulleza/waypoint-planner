import { dueDate, minimumDue, replayCard } from '../src/engine/cards'
import { cardPreset, termsFromPreset } from '../src/presets'
import { addMonths, daysBetween } from '../src/dates'
import { buildSnapshot, snapshotIndex } from '../src/snapshot'

// statements-calibration.json in the private directory: printed statements per card in minor units, each with the card rows its cycle holds.
export interface CalibrationCredit {
  posted_on: string
  amount_minor: number
  kind: 'transfer' | 'drawdown' | 'income' | 'refund' | 'adjustment'
}

export interface CalibrationStatement {
  cut_date: string
  due_date: string
  previous_balance_minor: number
  payments_and_credits_minor: number
  charges_minor: number
  installments_minor: number
  interest_minor: number
  fees_minor: number
  total_due_minor: number
  minimum_due_minor: number
  credits: readonly CalibrationCredit[]
}

export interface CalibrationCard {
  account_id: string
  preset: string
  statements: readonly CalibrationStatement[]
}

export interface CalibrationFile {
  cards: readonly CalibrationCard[]
}

// How far printed interest may sit from the replayed model, in minor units (estimates); null until one is set from the miss the parity report records.
export const INTEREST_TOLERANCE: Readonly<Record<string, number | null>> = {
  // An estimate: a fit of the daily rule over three months of printed statements missed by just under this.
  'PH-daily-unpaid': 6000,
  'PH-round-up': null,
  'PH-round-off': null,
  // A card paid in full by every due date keeps its grace, so there is no interest to miss.
  'PH-min-floor': 0,
}

type CardRow = Pick<CalibrationCredit, 'posted_on' | 'amount_minor' | 'kind'> & { id: string; account_id: string; transfer_id?: string }

const PRINTED = ['cut_date', 'due_date', 'previous_balance_minor', 'payments_and_credits_minor', 'charges_minor', 'installments_minor', 'interest_minor', 'fees_minor', 'total_due_minor', 'minimum_due_minor'] as const

export interface CycleFit {
  account_id: string
  preset: string
  cut_date: string
  charges_minor: number
  installments_minor: number
  // The card rows the file lists for the cycle against the printed payments and credits; the replay sees only the listed rows.
  credits: { listed: number; printed: number }
  minimum: { printed: number; preset: number }
  interest: { printed: number; modelled: number }
}

export interface CalibrateOptions {
  // Replaces the preset's payment lag, to see which lag the printed interest fits.
  lag?: number
}

// The lags the parity report and the test compare a preset's own against.
export const LAGS = [0, 1, 2] as const

// Every printed statement of one card on a household of that card alone, its terms copied from the preset: the minimum from the printed total, and each cycle's interest replayed from the statement before it.
// The first statement's printed previous balance stands as a total-only statement a month before its cut, so its cycle is replayed too.
// The file dates no charges, so the replay holds credits only and cannot test interest on in-cycle purchases (average-daily-balance presets).
export function calibrate(card: CalibrationCard, options: CalibrateOptions = {}): CycleFit[] {
  const preset = cardPreset(card.preset)
  if (!preset?.currency) throw new RangeError(`'${card.preset}' is not a preset with its own currency`)
  const [first, last] = [card.statements[0], card.statements.at(-1)]
  if (!first || !last) throw new RangeError(`'${card.account_id}' has no statements`)
  const fitted = termsFromPreset(card.preset, { cut_day: Number(first.cut_date.slice(8)), due: { days_after_cut: daysBetween(first.cut_date, first.due_date) }, due_roll: 'none' })
  const terms = options.lag === undefined ? fitted : { ...fitted, interest: { ...fitted.interest, payment_effective_lag_days: options.lag } }
  const baseCut = addMonths(first.cut_date, -1)
  const baseTotal = first.previous_balance_minor
  const base = {
    id: 'base',
    account_id: 'card',
    cut_date: baseCut,
    due_date: dueDate(terms, baseCut),
    total_due_minor: baseTotal,
    minimum_due_minor: minimumDue(terms, baseTotal, { installments_minor: 0, interest_minor: 0, fees_minor: 0 }),
  }
  const statements = [
    base,
    ...card.statements.map((s, i) => ({
      id: `s${i}`,
      account_id: 'card',
      ...Object.fromEntries(PRINTED.map((key) => [key, s[key]])),
    })),
  ]
  const transactions = card.statements.flatMap((s, i) =>
    s.credits.flatMap((c, k): CardRow[] => {
      const id = `c${i}-${k}`
      if (c.kind !== 'transfer') return [{ id, account_id: 'card', posted_on: c.posted_on, amount_minor: c.amount_minor, kind: c.kind }]
      return [
        { id: `${id}-out`, account_id: 'cash', posted_on: c.posted_on, amount_minor: 0 - c.amount_minor, kind: 'transfer', transfer_id: id },
        { id, account_id: 'card', posted_on: c.posted_on, amount_minor: c.amount_minor, kind: 'transfer', transfer_id: id },
      ]
    }),
  )
  const opening = { currency: preset.currency, opening_balance_minor: 0, opening_date: baseCut }
  const doc = {
    version: 1,
    household: { base_currency: preset.currency, timezone: 'UTC', locale: 'en', track_from: baseCut },
    accounts: [
      { id: 'cash', name: 'Cash', kind: 'cash', ...opening },
      { id: 'card', name: 'Card', kind: 'credit_card', terms, funded_from_account_id: 'cash', ...opening },
    ],
    statements,
    transactions,
  }
  const snapshot = buildSnapshot(doc, last.cut_date, [])
  const account = snapshotIndex(snapshot).accounts.get('card')
  if (account?.kind !== 'credit_card') throw new Error('The calibration card did not build')
  const entered = snapshotIndex(snapshot).statementsByAccount.get('card') ?? []
  return entered.slice(1).map((s, k) => {
    const i = k + 1
    const printed = card.statements[Number(s.id.slice(1))] as CalibrationStatement
    const replay = replayCard(snapshot, account, { entered: entered.slice(0, i + 1), until: s.cut_date, events: null, payer: null })
    const cycle = replay.statements.find((r) => r.id === s.id)
    if (!cycle?.model || cycle.previous_id !== entered[i - 1]?.id) throw new Error(`The ${s.cut_date} cycle of '${card.account_id}' was not replayed from the statement before it`)
    return {
      account_id: card.account_id,
      preset: card.preset,
      cut_date: s.cut_date,
      charges_minor: printed.charges_minor,
      installments_minor: printed.installments_minor,
      credits: { listed: printed.credits.reduce((sum, c) => sum + c.amount_minor, 0), printed: printed.payments_and_credits_minor },
      minimum: { printed: printed.minimum_due_minor, preset: minimumDue(account.terms, printed.total_due_minor, printed) },
      interest: { printed: printed.interest_minor, modelled: cycle.model.interest_minor },
    }
  })
}

// The worst interest miss over every replayed cycle at each lag in LAGS, in minor units.
export function worstMissByLag(card: CalibrationCard): { lag: number; worst: number; misses: number[] }[] {
  return LAGS.map((lag) => {
    const misses = calibrate(card, { lag }).map((f) => f.interest.modelled - f.interest.printed)
    return { lag, worst: Math.max(...misses.map(Math.abs)), misses }
  })
}
