import { useCallback, useMemo, useState } from 'react'

// The parts of a core zod schema a form reads: its parse, and its fields for the values an enum allows. Typed by shape, so the app needs no zod of its own.
export interface FormSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: readonly FormIssue[] } }
  shape?: Readonly<Record<string, unknown>>
}

export interface FormIssue {
  path: readonly PropertyKey[]
  message: string
}

export type FieldErrors<F extends string> = Partial<Record<F, string>>

export type FormResult<T, F extends string> = { ok: true; value: T } | { ok: false; errors: FieldErrors<F> }

// How a sentence names each field, so 'must not be before starts_on' reads 'Must not be before the first date.'
export type FieldNames<F extends string> = Partial<Record<F, string>>

// A schema's sentence as a person reads it beside the field: other fields by name, a capital first and a full stop.
export function plainIssue<F extends string>(message: string, names: FieldNames<F> = {}): string {
  let text = message
  for (const [field, name] of Object.entries(names) as [F, string | undefined][]) if (name) text = text.replace(new RegExp(`\\b${field}\\b`, 'g'), name)
  text = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?]$/.test(text) ? text : `${text}.`
}

// The first issue on each field, keyed by the field it sits on; an issue on the whole row goes to `root` when one is named.
export function issuesByField<F extends string>(issues: readonly FormIssue[], names: FieldNames<F> = {}, root?: F): FieldErrors<F> {
  const out: FieldErrors<F> = {}
  for (const issue of issues) {
    const head = issue.path[0]
    const field = (typeof head === 'string' ? head : root) as F | undefined
    if (field === undefined || out[field] !== undefined) continue
    out[field] = plainIssue(issue.message, names)
  }
  return out
}

// The values a schema's enum field allows, through its defaults and nullables; empty for a field that is not an enum.
export function allowedValues(schema: FormSchema<unknown>, field: string): readonly string[] {
  let node = schema.shape?.[field] as { options?: unknown; _zod?: { def?: { innerType?: unknown } } } | undefined
  while (node && !Array.isArray(node.options) && node._zod?.def?.innerType) node = node._zod.def.innerType as typeof node
  return Array.isArray(node?.options) ? (node.options as string[]) : []
}

export interface ZodFormOptions<D, T, F extends string> {
  schema: FormSchema<T>
  initial: D | (() => D)
  // The draft as the schema's input, each typed value parsed once here; a value that cannot be read names its field.
  read: (draft: D) => { input: unknown; errors?: FieldErrors<F> }
  // Checks across rows the schema cannot see, on the parsed value.
  check?: (value: T) => FieldErrors<F>
  names?: FieldNames<F>
}

export interface ZodForm<D, T, F extends string> {
  draft: D
  set: (patch: Partial<D>) => void
  change: (next: (draft: D) => D) => void
  reset: (draft: D) => void
  result: FormResult<T, F>
  // Errors to show beside fields: none until the first attempt, then live as the person corrects them.
  errors: FieldErrors<F>
  // Marks an attempt, so errors show, and gives the checked value or null.
  attempt: () => T | null
  allowed: (field: F) => readonly string[]
}

// A form over a core schema: the draft is read, then checked by the same schema the database mirrors, with each error beside its field.
export function useZodForm<D, T, F extends string>({ schema, initial, read, check, names }: ZodFormOptions<D, T, F>): ZodForm<D, T, F> {
  const [draft, setDraft] = useState<D>(initial)
  const [tried, setTried] = useState(false)
  const result = useMemo((): FormResult<T, F> => {
    const { input, errors: unread = {} } = read(draft)
    const parsed = schema.safeParse(input)
    const errors: FieldErrors<F> = parsed.success ? {} : issuesByField<F>(parsed.error.issues, names)
    // A value that could not be read says so, rather than what the schema made of its stand-in.
    Object.assign(errors, unread)
    if (parsed.success && check && Object.keys(errors).length === 0) Object.assign(errors, check(parsed.data))
    return parsed.success && Object.keys(errors).length === 0 ? { ok: true, value: parsed.data } : { ok: false, errors }
  }, [draft, read, schema, check, names])
  const set = useCallback((patch: Partial<D>) => setDraft((d) => ({ ...d, ...patch })), [])
  const reset = useCallback((next: D) => {
    setDraft(next)
    setTried(false)
  }, [])
  const attempt = () => {
    setTried(true)
    return result.ok ? result.value : null
  }
  const allowed = useCallback((field: F) => allowedValues(schema as FormSchema<unknown>, field), [schema])
  return { draft, set, change: setDraft, reset, result, errors: tried && !result.ok ? result.errors : {}, attempt, allowed }
}
