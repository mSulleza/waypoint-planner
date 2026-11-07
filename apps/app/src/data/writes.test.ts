import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from './test-helpers'
import { LAST_ACCOUNT_KEY, newBatchIds, readLastAccount, rememberLastAccount } from './writes'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('one save’s ids', () => {
  it('makes five distinct uuids, one per row, the batch and the transfer', () => {
    const ids = newBatchIds()
    const all = [ids.batch_id, ...ids.rows, ids.transfer_id]
    expect(all.every((id) => UUID.test(id))).toBe(true)
    expect(new Set(all).size).toBe(5)
    expect(newBatchIds().batch_id).not.toBe(ids.batch_id)
  })
})

describe('the remembered account', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the last account a save used on this device', () => {
    expect(readLastAccount()).toBeNull()
    rememberLastAccount('main')
    expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBe('main')
    expect(readLastAccount()).toBe('main')
  })

  it('reads nothing and never throws when the browser blocks storage', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    vi.stubGlobal('localStorage', blocked)
    expect(() => rememberLastAccount('main')).not.toThrow()
    expect(readLastAccount()).toBeNull()
  })
})
