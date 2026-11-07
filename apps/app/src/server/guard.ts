// What every /api function checks before it reads a body: a caller with no sign-in token, or a body over what the function takes, is answered at once, so an anonymous request never makes it read megabytes. The full sign-in check and the allow list still run after, in each function's own handler. Plain TypeScript with no imports, so each Vercel function bundles only this.

export const KB = 1024

// The token of an `Authorization: Bearer <token>` header, or null when there is none.
export function bearer(request: Request): string | null {
  return /^Bearer\s+(\S.*)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
}

// The handlers' own failure shape, { status, error }, never cached.
const refuse = (status: number, error: string) => Response.json({ status, error }, { status, headers: { 'Cache-Control': 'no-store' } })

// A 401 when there is no Bearer token and a 413 when Content-Length says the body is over maxBytes, both before the body is read; null to go on.
export function refuseEarly(request: Request, maxBytes: number): Response | null {
  if (!bearer(request)) return refuse(401, 'signed_out')
  if (Number(request.headers.get('content-length')) > maxBytes) return refuse(413, 'too_large')
  return null
}
