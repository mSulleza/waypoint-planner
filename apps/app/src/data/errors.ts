import { isAuthRetryableFetchError } from '@supabase/auth-js'

// Each kind is a different situation with its own words, so an error, an empty household and a refused read never look alike.
export type DataErrorKind = 'network' | 'signed_out' | 'not_allowed' | 'rejected' | 'server' | 'bad_data' | 'config' | 'read_only' | 'unknown_sample'

export class DataError extends Error {
  readonly kind: DataErrorKind
  // The SQLSTATE, or the error name a checked function puts before ': ' (bad_input, over_remainder, ...).
  readonly code: string | null
  readonly detail: unknown
  // The server's own words, shown only when the person asks for details; message is the plain sentence.
  readonly technical: string | null

  constructor(kind: DataErrorKind, message: string, options: { code?: string | null; detail?: unknown; technical?: string | null } = {}) {
    super(message)
    this.name = 'DataError'
    this.kind = kind
    this.code = options.code ?? null
    this.detail = options.detail ?? null
    this.technical = options.technical ?? null
  }
}

export const ERROR_TITLES: Record<DataErrorKind, string> = {
  network: 'Offline',
  signed_out: 'Signed out',
  not_allowed: 'Not allowed',
  rejected: 'Not saved',
  server: 'Could not load your household',
  bad_data: 'Your data did not pass the checks',
  config: 'Waypoint is not connected',
  read_only: 'Saving is off',
  unknown_sample: 'No such sample',
}

export const SESSION_ENDED = 'Your session has ended. Sign in again.'

export interface RpcFailure {
  message: string
  code?: string | null
  details?: string | null
  hint?: string | null
}

// What each server function does, in the words a person would use.
const DOING: Record<string, string> = {
  export_household: 'read this household',
  post_batch: 'save this change',
  import_household: 'import a household',
  delete_my_account: 'delete this account',
}

function detailJson(details: string | null | undefined): unknown {
  if (!details) return null
  try {
    return JSON.parse(details)
  } catch {
    return details
  }
}

// supabase's database client answers a request that never reached the server with HTTP status 0.
export function rpcError(fn: string, error: RpcFailure, status: number): DataError {
  const code = error.code || null
  const technical = `${fn}: ${error.message}${code ? ` (${code}, HTTP ${status})` : ` (HTTP ${status})`}`
  if (status === 0) return new DataError('network', 'Waypoint could not reach the server.', { code, technical })
  if (status === 401 || code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303') return new DataError('signed_out', SESSION_ENDED, { code, technical })
  // RLS and revoked rights: the read was refused, which is not the same as an empty household.
  if (code === '42501' || status === 403) return new DataError('not_allowed', `This account is not allowed to ${DOING[fn] ?? 'do that'}.`, { code, technical })
  if (code === 'P0001') {
    const name = error.message.split(':', 1)[0] ?? ''
    return new DataError('rejected', 'The server did not accept this change.', { code: name, detail: detailJson(error.details), technical })
  }
  if (code?.startsWith('23') || code?.startsWith('22')) return new DataError('rejected', 'The server did not accept this change.', { code, detail: detailJson(error.details), technical })
  return new DataError('server', 'The server had a problem. Try again in a moment.', { code, technical })
}

export function authError(error: unknown): DataError {
  const technical = error instanceof Error ? error.message : String(error)
  if (isAuthRetryableFetchError(error)) return new DataError('network', 'Waypoint could not reach the server.', { technical })
  return new DataError('signed_out', SESSION_ENDED, { technical })
}

export function asDataError(error: unknown): DataError {
  if (error instanceof DataError) return error
  return new DataError('server', 'Something went wrong. Try again in a moment.', { technical: error instanceof Error ? error.message : String(error) })
}
