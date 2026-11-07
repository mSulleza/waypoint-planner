// A refusal the agent can act on, in plain words; anything else is reported as an unexpected failure.
export class AgentError extends Error {
  override name = 'AgentError'
}

// A write the database or a check refused, named like post_batch's errors, with the figures to act on beside the words.
export class Refusal extends AgentError {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

// What a write answers when it saves nothing: a refusal as JSON, its code 'refused' when no check named one; a failure that is no refusal stays as it is.
export function asRefusal(error: unknown): unknown {
  return error instanceof AgentError && !(error instanceof Refusal) ? new Refusal('refused', error.message) : error
}

export function messageOf(error: unknown): string {
  if (error instanceof Refusal) return JSON.stringify({ error: error.code, message: error.message, ...error.detail })
  if (error instanceof AgentError) return error.message
  return `Unexpected failure: ${error instanceof Error ? error.message : String(error)}`
}
