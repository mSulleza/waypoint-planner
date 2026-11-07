import { z } from 'zod'

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export const docId = z.string().min(1, 'must be a non-empty id')
export const uuid = z.guid('must be a uuid')
export const isoDay = z.iso.date('must be a real YYYY-MM-DD date')
export const isoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a YYYY-MM month')
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter ISO 4217 code such as EUR')
export const minorUnits = z.int('must be a whole number of minor units')
export const timestamp = z.iso.datetime({ offset: true, error: 'must be an ISO 8601 timestamp' })
export const rollRule = z.enum(['none', 'following', 'preceding'])
export const fraction = z.number().min(0, 'must not be negative').lt(1, 'must be a fraction below 1, such as 0.03 for 3%; percent and fraction never mix')

// Refuses unknown keys and names the allowed ones, so a typo never passes as a lever that did nothing.
export function strictKeys<T extends z.ZodRawShape>(shape: T) {
  const allowed = Object.keys(shape).join(', ')
  return z.strictObject(shape, {
    error: (issue) => (issue.code === 'unrecognized_keys' ? `Unknown key${issue.keys.length > 1 ? 's' : ''} ${issue.keys.map((k) => `'${k}'`).join(', ')}; ${allowed ? `allowed keys: ${allowed}` : 'it takes no keys'}` : undefined),
  })
}

function pathText(path: readonly PropertyKey[]): string {
  let out = ''
  for (const key of path) out += typeof key === 'number' ? `[${key}]` : `${out ? '.' : ''}${String(key)}`
  return out || '(root)'
}

// A union reports the branch the input was aiming at: drop branches whose shape did not match, then keep the one with fewest issues.
function describe(issue: z.core.$ZodIssue, prefix: readonly PropertyKey[]): string[] {
  const path = [...prefix, ...issue.path]
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const fits = issue.errors.filter((branch) => !branch.some((i) => i.path.length === 0 && (i.code === 'invalid_type' || i.code === 'invalid_value')))
    const fewest = Math.min(...fits.map((branch) => branch.length))
    const best = fits.filter((branch) => branch.length === fewest)
    if (best.length === 1 && best[0]) return best[0].flatMap((i) => describe(i, path))
  }
  return [`${pathText(path)}: ${issue.message}`]
}

export function listIssues(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => describe(issue, []))
}

export function checkInput<S extends z.ZodType>(schema: S, input: unknown): Checked<z.output<S>> {
  const result = schema.safeParse(input)
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: listIssues(result.error) }
}

export function flagDuplicateIds(rows: readonly { id: string }[], field: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  rows.forEach((row, i) => {
    if (seen.has(row.id)) ctx.addIssue({ code: 'custom', message: `duplicate id '${row.id}'`, path: [field, i, 'id'] })
    seen.add(row.id)
  })
}
