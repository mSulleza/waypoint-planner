import { describe, expect, it } from 'vitest'
import { identityIndex, identityOf, OTHER_IDENTITY, tileLetters } from './identity'
import { identityColor } from './tokens'

const account = (id: string, sort_order: number, archived_at: string | null = null) => ({ id, sort_order, archived_at })

describe('identity order', () => {
  it('numbers accounts of every kind by sort order, then id, an archived one keeping its place', () => {
    const index = identityIndex([account('card', 3), account('main', 0), account('old', 1, '2026-09-01T00:00:00Z'), account('b-tax', 1), account('a-pesos', 1)])
    expect([...index]).toEqual([
      ['main', 0],
      ['a-pesos', 1],
      ['b-tax', 2],
      ['old', 3],
      ['card', 4],
    ])
    // An unknown account falls past the seven colours, so it reads grey.
    expect([identityOf(index, 'nope'), OTHER_IDENTITY]).toEqual([7, 7])
    expect([identityColor(identityOf(index, 'nope'), 'light'), identityColor(identityOf(index, 'nope'), 'dark')]).toEqual(['#747474', '#8a8a8a'])
  })

  it('keeps every other account’s colour when one is archived', () => {
    const open = [account('main', 0), account('card', 1), account('tax', 2), account('loan', 3)]
    const closed = open.map((a) => (a.id === 'card' ? { ...a, archived_at: '2026-10-01T00:00:00Z' } : a))
    expect([...identityIndex(closed)]).toEqual([...identityIndex(open)])
  })

  it('gives the same numbers whatever order the rows arrive in, as after a reload', () => {
    const rows = [account('main', 0), account('tax', 1), account('pesos', 2), account('card', 3), account('loan', 3), account('eighth', 9)]
    const once = [...identityIndex(rows)]
    expect([...identityIndex([...rows].reverse())]).toEqual(once)
    expect([...identityIndex([rows[3]!, rows[0]!, rows[5]!, rows[1]!, rows[4]!, rows[2]!])]).toEqual(once)
  })
})

describe('tile letters', () => {
  it('take the first letter of each of the first two words', () => {
    expect(['Main', 'Tax', 'ACME', 'Example Bank', 'Rewards card', 'Car loan', 'Current account', ' Wallet ', 'Bank of the Isles', 'élan vital', 'Cash-EUR', ''].map(tileLetters)).toEqual(['M', 'T', 'A', 'EB', 'RC', 'CL', 'CA', 'W', 'BO', 'ÉV', 'CE', ''])
  })
})
