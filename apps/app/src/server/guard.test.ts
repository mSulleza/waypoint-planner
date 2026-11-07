import { describe, expect, it } from 'vitest'
import { POST as mealsAi } from '../../api/meals-ai'
import { POST as mercadona } from '../../api/mercadona'
import { POST as pdfRead } from '../../api/pdf-read'
import { bearer, KB, refuseEarly } from './guard'

const post = (headers: Record<string, string>, body = '{}') => new Request('https://waypoint.test/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
// A body of n bytes with its Content-Length, as a client sends it.
const sized = (n: number, headers: Record<string, string> = {}) => post({ 'Content-Length': String(n), ...headers }, 'x'.repeat(n))

// Each function and the largest body it takes.
const FUNCTIONS = [
  { name: 'meals-ai', POST: mealsAi, max: 64 * KB },
  { name: 'mercadona', POST: mercadona, max: 64 * KB },
  { name: 'pdf-read', POST: pdfRead, max: 4_000_000 + 64 * KB },
]

describe('request guard', () => {
  it('reads the token of a Bearer header only', () => {
    expect([bearer(post({ Authorization: 'Bearer abc.def' })), bearer(post({ Authorization: 'bearer  abc' })), bearer(post({ Authorization: 'Bearer ' })), bearer(post({ Authorization: 'Basic abc' })), bearer(post({}))]).toEqual(['abc.def', 'abc', null, null, null])
  })

  it('lets a signed-in request up to the limit through', () => {
    expect(refuseEarly(sized(64 * KB, { Authorization: 'Bearer t' }), 64 * KB)).toBeNull()
    expect(refuseEarly(post({ Authorization: 'Bearer t' }), 64 * KB)).toBeNull()
  })

  for (const f of FUNCTIONS) {
    describe(`/api/${f.name}`, () => {
      it('answers a request with no sign-in token with 401 and never reads its body', async () => {
        for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: 'Basic abc' }] as Record<string, string>[]) {
          const request = post(headers)
          const reply = await f.POST(request)
          expect(reply.status).toBe(401)
          expect(await reply.json()).toEqual({ status: 401, error: 'signed_out' })
          expect(reply.headers.get('cache-control')).toBe('no-store')
          expect(request.bodyUsed).toBe(false)
        }
      })

      it('answers a body over its limit with 413 and never reads it', async () => {
        const request = sized(f.max + 1, { Authorization: 'Bearer t' })
        const reply = await f.POST(request)
        expect(reply.status).toBe(413)
        expect(await reply.json()).toEqual({ status: 413, error: 'too_large' })
        expect(request.bodyUsed).toBe(false)
      })

      it('turns away a request with no token before its size', async () => {
        const request = sized(f.max + 1)
        expect((await f.POST(request)).status).toBe(401)
        expect(request.bodyUsed).toBe(false)
      })

      it('reads the body of a signed-in request within its limit', async () => {
        // Not one the function takes, so it stops at its own check before any sign-in call.
        const request = post({ Authorization: 'Bearer t' }, '{}')
        const reply = await f.POST(request)
        expect(reply.status).toBe(400)
        expect(request.bodyUsed).toBe(true)
      })
    })
  }
})
