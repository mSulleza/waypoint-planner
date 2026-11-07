import { describe, expect, it } from 'vitest'
import { followSampleParam, ownerAfter, resumeSampleParam, type SampleParam } from './source-state'

describe('followSampleParam', () => {
  it('opens a sample from the URL and keeps it open on routes without the param', () => {
    const opened = followSampleParam({ seen: null, open: null }, 'abroad')
    expect(opened).toEqual({ seen: 'abroad', open: 'abroad' })
    expect(followSampleParam(opened, null)).toEqual({ seen: null, open: 'abroad' })
  })

  it('stays closed after exitSample while ?sample= is still in the URL, and opens again when the param comes back', () => {
    const exited: SampleParam = { seen: 'abroad', open: null }
    expect(followSampleParam(exited, 'abroad')).toBe(exited)
    const cleared = followSampleParam(exited, null)
    expect(cleared).toEqual({ seen: null, open: null })
    expect(followSampleParam(cleared, 'abroad')).toEqual({ seen: 'abroad', open: 'abroad' })
    expect(followSampleParam(exited, 'mortgage')).toEqual({ seen: 'mortgage', open: 'mortgage' })
  })
})

describe('resumeSampleParam', () => {
  it('starts from the URL on the first mount, and from what the last mount left on a remount whose URL has no sample', () => {
    expect(resumeSampleParam(null, 'abroad')).toEqual({ seen: 'abroad', open: 'abroad' })
    expect(resumeSampleParam(null, null)).toEqual({ seen: null, open: null })
    const left: SampleParam = { seen: null, open: 'us-cards-car' }
    expect(resumeSampleParam(left, null)).toBe(left)
    expect(resumeSampleParam(left, 'mortgage')).toEqual({ seen: 'mortgage', open: 'mortgage' })
    // A sample the person closed stays closed.
    expect(resumeSampleParam({ seen: null, open: null }, null)).toEqual({ seen: null, open: null })
  })
})

describe('ownerAfter', () => {
  it('reads a sign-out as nobody, a session as its account, and a start with no session as nothing new', () => {
    const a = { user: { id: 'user-a' } }
    expect(ownerAfter('SIGNED_OUT', null)).toBeNull()
    expect(ownerAfter('SIGNED_IN', a)).toBe('user-a')
    expect(ownerAfter('TOKEN_REFRESHED', a)).toBe('user-a')
    expect(ownerAfter('INITIAL_SESSION', a)).toBe('user-a')
    // Offline with an expired token, the client starts with no session but keeps it saved.
    expect(ownerAfter('INITIAL_SESSION', null)).toBeUndefined()
  })
})
