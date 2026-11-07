import { describe, expect, it } from 'vitest'
import { gate, homeOf } from './gate.model'

const ONLY_WELCOME = { welcome: true, onboarding: false, app: false }

describe('gate', () => {
  it('sends anyone signed out with no sample to Welcome, whatever the household query says', () => {
    for (const phase of ['signed_out', 'loading', 'failed'] as const) expect(gate({ owner: null, sample: false, phase })).toEqual(ONLY_WELCOME)
  })

  it('opens the tabs for a sample without an account, and keeps Welcome open to sign in from', () => {
    expect(gate({ owner: null, sample: true, phase: 'loading' })).toEqual({ welcome: true, onboarding: false, app: true })
    expect(gate({ owner: null, sample: true, phase: 'ready' })).toEqual({ welcome: true, onboarding: false, app: true })
    expect(gate({ owner: 'user-a', sample: true, phase: 'ready' })).toEqual({ welcome: false, onboarding: false, app: true })
  })

  it('opens the tabs at once for a stored session, before the server has answered', () => {
    expect(gate({ owner: 'user-a', sample: false, phase: 'loading' })).toEqual({ welcome: false, onboarding: true, app: true })
  })

  it('sends a signed-in account with no household to onboarding, and one with a household to the tabs', () => {
    expect(gate({ owner: 'user-a', sample: false, phase: 'no_household' })).toEqual({ welcome: false, onboarding: true, app: false })
    expect(gate({ owner: 'user-a', sample: false, phase: 'ready' })).toEqual({ welcome: false, onboarding: false, app: true })
  })

  it('keeps a failed load on the tabs, where the error has Retry', () => {
    expect(gate({ owner: 'user-a', sample: false, phase: 'failed' })).toEqual({ welcome: false, onboarding: false, app: true })
  })

  it('sends a session the server ended back to Welcome, though the device still holds it', () => {
    expect(gate({ owner: 'user-a', sample: false, phase: 'signed_out' })).toEqual(ONLY_WELCOME)
  })
})

describe('homeOf', () => {
  it('sends Back with no history to an open route: the tabs, set-up for an account with no household, else Welcome', () => {
    expect(homeOf(gate({ owner: 'user-a', sample: false, phase: 'ready' }))).toBe('/')
    expect(homeOf(gate({ owner: 'user-a', sample: false, phase: 'loading' }))).toBe('/')
    expect(homeOf(gate({ owner: null, sample: true, phase: 'ready' }))).toBe('/')
    expect(homeOf(gate({ owner: 'user-a', sample: false, phase: 'no_household' }))).toBe('/onboarding')
    expect(homeOf(gate({ owner: null, sample: false, phase: 'signed_out' }))).toBe('/welcome')
  })
})
