import { grossFor, netOf } from '../money'
import type { Account } from '../schema/rows'
import type { WalkError } from './types'

export interface FundingEdge {
  target: Account
  source: Account
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Cash accounts topped up from a cash funder, targets before their sources and then by sort order, which also orders targets sharing one source.
export function fundingOrder(accounts: readonly Account[]): { edges: FundingEdge[]; errors: WalkError[] } {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const funderOf = (a: Account) => (a.funded_from_account_id === null ? undefined : byId.get(a.funded_from_account_id))
  const errors: WalkError[] = []
  for (const a of accounts) {
    const funder = funderOf(a)
    if (funder && funder.kind !== 'cash') errors.push({ code: 'non_cash_funder', message: `'${a.id}' is funded from '${funder.id}', which is not a cash account`, ids: [a.id, funder.id] })
  }

  const cycles = new Set<string>()
  const depth = new Map<string, number>()
  for (const a of accounts) {
    const chain: Account[] = []
    let at: Account | undefined = a
    while (at && !depth.has(at.id) && !chain.includes(at)) {
      chain.push(at)
      at = funderOf(at)
    }
    if (at && chain.includes(at)) {
      const ring = chain.slice(chain.indexOf(at)).map((c) => c.id).sort(byText)
      const key = ring.join(' ')
      if (!cycles.has(key)) {
        cycles.add(key)
        errors.push({ code: 'funding_cycle', message: `${ring.map((id) => `'${id}'`).join(', ')} fund each other in a circle; funding runs one way`, ids: ring })
      }
      for (const c of chain) depth.set(c.id, 0)
      continue
    }
    let d = at ? (depth.get(at.id) ?? 0) : -1
    for (let i = chain.length - 1; i >= 0; i--) depth.set((chain[i] as Account).id, ++d)
  }
  if (errors.length > 0) return { edges: [], errors }

  const edges: FundingEdge[] = []
  for (const target of accounts) {
    const source = funderOf(target)
    if (target.kind === 'cash' && source) edges.push({ target, source })
  }
  edges.sort((x, y) => (depth.get(y.target.id) ?? 0) - (depth.get(x.target.id) ?? 0) || x.target.sort_order - y.target.sort_order || byText(x.target.id, y.target.id))
  return { edges, errors }
}

// The one rule that sizes a transfer: the smaller of what the target needs (net) and what the source can spare (gross); null when nothing would land.
export function sizeTopUp(needNet: number, spareGross: number, rate: number, feePct: number): { gross: number; net: number } | null {
  if (needNet <= 0 || spareGross <= 0) return null
  const gross = Math.min(grossFor(needNet, rate, feePct), spareGross)
  const net = netOf(gross, rate, feePct)
  return net > 0 ? { gross, net } : null
}
