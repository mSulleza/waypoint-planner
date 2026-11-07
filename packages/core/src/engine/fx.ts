import { minorDigits, type Money } from '../money'
import type { RatesPerEur } from '../rates'
import type { Account } from '../schema/rows'
import { snapshotIndex, type Snapshot } from '../snapshot'

const bySortOrder = (a: Account, b: Account) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The currency money leaves when it crosses currencies: of accounts that fund or send transfer items into another currency, the base currency if it is among them, else the first by sort order.
export function fundingCurrency(snapshot: Snapshot): string | null {
  const { accounts } = snapshotIndex(snapshot)
  const senders = new Set<Account>()
  for (const a of snapshot.doc.accounts) {
    const funder = a.funded_from_account_id === null ? undefined : accounts.get(a.funded_from_account_id)
    if (funder && funder.currency !== a.currency) senders.add(funder)
  }
  for (const p of snapshot.doc.plan_items) {
    if (p.kind !== 'transfer' || p.from_account_id === null || p.to_account_id === null) continue
    const [from, to] = [accounts.get(p.from_account_id), accounts.get(p.to_account_id)]
    if (from && to && from.currency !== to.currency) senders.add(from)
  }
  const list = [...senders].sort(bySortOrder)
  const base = snapshot.doc.household.base_currency
  return list.some((a) => a.currency === base) ? base : (list[0]?.currency ?? null)
}

// Moves the funding currency's value by `shift` (−0.1 is 10% weaker); every cross rate between other currencies stays.
export function shiftRates(rates: RatesPerEur, funding: string | null, shift: number): RatesPerEur {
  if (funding === null || shift === 0) return rates
  const m = 1 + shift
  // Twelve significant digits drop float noise such as 70 × 0.9 = 63.00000000000001; published rates carry about six.
  const clean = (x: number) => Number(x.toPrecision(12))
  if (funding === 'EUR') return Object.fromEntries(Object.entries(rates).map(([quote, rate]) => [quote, quote === 'EUR' ? rate : clean(rate * m)]))
  const own = rates[funding]
  return own === undefined ? rates : { ...rates, [funding]: clean(own / m) }
}

// A recorded transfer's real rate from its two legs, fee included: received ÷ sent, in major units.
export function realisedRate(snapshot: Snapshot, transferId: string): { sent: Money; received: Money; rate: number } {
  const index = snapshotIndex(snapshot)
  const legs = index.transfers.get(transferId)
  if (!legs) throw new RangeError(`No transfer '${transferId}' in the snapshot`)
  const [out, into] = legs
  const [from, to] = [index.accounts.get(out.account_id), index.accounts.get(into.account_id)]
  if (!from || !to) throw new RangeError(`Transfer '${transferId}' names an account the snapshot lacks`)
  const sent = { minor: -out.amount_minor, currency: from.currency }
  const received = { minor: into.amount_minor, currency: to.currency }
  return { sent, received, rate: received.minor / 10 ** minorDigits(to.currency) / (sent.minor / 10 ** minorDigits(from.currency)) }
}
