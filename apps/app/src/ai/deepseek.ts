// What every DeepSeek helper shares: the caller's sign-in, the allow list, and one json-mode chat call whose failures come back named. Plain TypeScript with no imports at run time, so each Vercel function bundles only its own helper.

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
export const DEFAULT_MODEL = 'deepseek-flash'
const TIMEOUT_MS = 120_000

export interface AiEnv {
  supabase_url: string | undefined
  supabase_key: string | undefined
  deepseek_key: string | undefined
  model: string | undefined
  // User ids that may use the helper, comma-separated.
  users: string | undefined
}

export const allowed = (env: AiEnv, userId: string) =>
  (env.users ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(userId)

export interface Fail {
  status: number
  error: string
}

export const fail = (status: number, error: string): Fail => ({ status, error })

// The signed-in user from their own token, and whether the helper is on for them; a failure when the server is not set up or the token is not a sign-in.
export async function caller(env: AiEnv, token: string | null, fetchFn: typeof fetch): Promise<{ id: string; enabled: boolean; headers: Record<string, string> } | Fail> {
  if (!env.supabase_url || !env.supabase_key) return fail(503, 'not_configured')
  if (!token) return fail(401, 'signed_out')
  const headers = { apikey: env.supabase_key, Authorization: `Bearer ${token}` }
  const who = await fetchFn(new URL('auth/v1/user', `${env.supabase_url}/`).href, { headers })
  if (!who.ok) return fail(401, 'signed_out')
  const user = (await who.json()) as { id?: string }
  if (typeof user.id !== 'string') return fail(401, 'signed_out')
  return { id: user.id, enabled: allowed(env, user.id) && Boolean(env.deepseek_key), headers }
}

// The json in a reply, also when it comes in a code fence or with words around it; undefined when there is none.
export function readJson(content: string): unknown {
  const text = content.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Try the next reading.
    }
  }
  return undefined
}

// One chat call in json mode; an empty, broken, refused or late answer comes back as a named failure.
export async function askDeepSeek(env: AiEnv, fetchFn: typeof fetch, system: string, user: string, maxTokens: number, temperature = 0.4): Promise<{ json: unknown } | Fail> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const reply = await fetchFn(DEEPSEEK_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.deepseek_key}` },
      // Thinking is on by default and its reasoning spent the plan's whole token limit, leaving the json empty.
      body: JSON.stringify({ model: env.model || DEFAULT_MODEL, thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    })
    if (!reply.ok) return fail(502, `deepseek_${reply.status}`)
    const out = (await reply.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
    const content = out.choices?.[0]?.message?.content ?? ''
    const cutOff = out.choices?.[0]?.finish_reason === 'length'
    if (content.trim() === '') return fail(502, cutOff ? 'deepseek_cut_off' : 'deepseek_empty')
    const json = readJson(content)
    if (json !== undefined) return { json }
    return fail(502, cutOff ? 'deepseek_cut_off' : 'deepseek_not_json')
  } catch {
    return fail(504, controller.signal.aborted ? 'deepseek_timeout' : 'deepseek_unreachable')
  } finally {
    clearTimeout(timer)
  }
}
