import { addDays, addMonths, approxTotal, ledgerDays, ledgerSum, missingRates, type Account, type Snapshot } from '@waypoint/core'
import { textWidth } from '../../ui/chart/layout'
import { identityIndex, identityOf } from '../../ui/identity'
import { CONTENT_MAX_WIDTH, GUTTER, LINE_WIDTH, SPACE, TILE } from '../../ui/tokens'

// Spec §7 Money: every open account by currency with its balance to today and a year of history, the cash total per currency, and one approximate total in the base currency.

export const SPARK_MONTHS = 12

// A row's sparkline is 64 wide, or 40 where that is all the name can spare.
export const SPARK_WIDTHS = [64, 40] as const
const CHEVRON = 18

// What a row leaves its name: the content column less the card's edges and padding, the tile, the amount column, the chevron and the gaps between them.
export function nameRoom(windowWidth: number, amountWidth: number): number {
  const card = Math.min(windowWidth - 2 * GUTTER, CONTENT_MAX_WIDTH)
  return card - 2 * LINE_WIDTH - 2 * GUTTER - TILE.row - amountWidth - CHEVRON - 3 * SPACE[3]
}

// The widest sparkline that leaves every whole name its line, so no name wraps as Today and Debts keep theirs; 0 leaves it out, as on a narrow phone.
export function sparkWidth(room: number, names: readonly string[], fontSize: number): number {
  const name = Math.max(0, ...names.map((n) => textWidth(n, fontSize)))
  return SPARK_WIDTHS.find((w) => room - w - SPACE[3] >= name) ?? 0
}

export interface AccountLine {
  account_id: string
  // The account's place in the account order, which picks its tile's and sparkline's colour on every screen.
  colour: number
  name: string
  kind: Account['kind']
  currency: string
  // Opening balance plus every row to today: what the bank shows, before rows entered for later days.
  live_minor: number
  // End-of-day balances from rows alone, over the last 12 months or since the account opened; a debt's are what it owes, so the line rises with the figure beside it.
  spark: Float64Array
}

export interface CurrencyGroup {
  currency: string
  accounts: AccountLine[]
  total_minor: number
}

export type BaseTotal =
  // Every cash account is in the base currency, so the group total is already the total.
  | { kind: 'single' }
  | { kind: 'approx'; minor: number; currency: string; day: string }
  // A rate is missing, so there is no total; never a zero (rule 14).
  | { kind: 'missing'; currency: string; missing: string[] }

export interface MoneyModel {
  // Cash accounts, one group per currency, in the order their first account sorts.
  groups: CurrencyGroup[]
  // Cards and loans, which keep their own ledgers; their total debt is on Debts.
  debts: AccountLine[]
  base: BaseTotal | null
}

const bySortOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1)

// The first day the sparkline draws: a year back from today, or the opening day when that is later.
export function sparkFrom(asOf: string, openingDate: string): string {
  const yearBack = addDays(addMonths(asOf, -SPARK_MONTHS), 1)
  return openingDate > yearBack ? openingDate : yearBack
}

// Full history: each point is opening plus every row to that day, so a transfer or a late row from before the window still counts (invariant 191).
export function sparkOf(snapshot: Snapshot, account: Account): Float64Array {
  const from = sparkFrom(snapshot.as_of, account.opening_date)
  if (from > snapshot.as_of) return new Float64Array(0)
  const days = ledgerDays(snapshot, account.id, from, snapshot.as_of)
  if (account.kind !== 'cash') for (let i = 0; i < days.length; i++) days[i] = -(days[i] as number)
  return days
}

function lineOf(snapshot: Snapshot, account: Account, identity: ReadonlyMap<string, number>): AccountLine {
  return { account_id: account.id, colour: identityOf(identity, account.id), name: account.name, kind: account.kind, currency: account.currency, live_minor: ledgerSum(snapshot, account.id, snapshot.as_of), spark: sparkOf(snapshot, account) }
}

export function moneyModel(snapshot: Snapshot): MoneyModel {
  const open = snapshot.doc.accounts.filter((a) => a.archived_at === null).sort(bySortOrder)
  const identity = identityIndex(snapshot.doc.accounts)
  const groups: CurrencyGroup[] = []
  for (const account of open.filter((a) => a.kind === 'cash')) {
    const line = lineOf(snapshot, account, identity)
    const group = groups.find((g) => g.currency === line.currency)
    if (group) {
      group.accounts.push(line)
      group.total_minor += line.live_minor
    } else groups.push({ currency: line.currency, accounts: [line], total_minor: line.live_minor })
  }
  const debts = open.filter((a) => a.kind !== 'cash').map((a) => lineOf(snapshot, a, identity))
  return { groups, debts, base: baseTotal(snapshot, groups) }
}

function baseTotal(snapshot: Snapshot, groups: readonly CurrencyGroup[]): BaseTotal | null {
  if (groups.length === 0) return null
  const base = snapshot.doc.household.base_currency
  if (groups.every((g) => g.currency === base)) return { kind: 'single' }
  const total = approxTotal(
    groups.map((g) => ({ minor: g.total_minor, currency: g.currency })),
    base,
    snapshot.rates,
  )
  if (total === null) return { kind: 'missing', currency: base, missing: missingRates([base, ...groups.map((g) => g.currency)], snapshot.rates) }
  // Any conversion makes the figure approximate and dated, so approx is always true here.
  return { kind: 'approx', minor: total.minor, currency: total.currency, day: total.approx ? total.day : snapshot.as_of }
}
