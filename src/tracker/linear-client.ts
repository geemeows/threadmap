// Thin hand-rolled Linear GraphQL client (#19 §8 "ships its own thin client").
// Owns the error shapes verified in docs/research/linear-api.md §10.5: hourly
// RATELIMITED arrives as HTTP 400 with a dedicated code; the per-query
// complexity cap arrives as a generic INPUT_ERROR whose *message* must be
// parsed. Auth is a personal API key sent bare — no `Bearer` prefix.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate-limited' | 'too-complex' | 'input' | 'http' | 'graphql',
  ) {
    super(message)
    this.name = 'LinearApiError'
  }
}

interface GraphQLErrorShape {
  message?: string
  extensions?: { code?: string; userPresentableMessage?: string }
}

export interface LinearClientOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  endpoint?: string
}

export class LinearClient {
  private apiKey: string
  private fetchImpl: typeof fetch
  private endpoint: string

  constructor(opts: LinearClientOptions) {
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.endpoint = opts.endpoint ?? LINEAR_ENDPOINT
  }

  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiKey, // personal API key: no Bearer prefix (§8)
      },
      body: JSON.stringify({ query, variables }),
    })
    const body = (await res.json().catch(() => null)) as {
      data?: T
      errors?: GraphQLErrorShape[]
    } | null

    const errors = body?.errors
    if (errors?.length) throw classifyErrors(errors)
    if (!res.ok) throw new LinearApiError(`Linear API HTTP ${res.status}`, 'http')
    if (!body?.data) throw new LinearApiError('Linear API returned no data', 'graphql')
    return body.data
  }
}

function classifyErrors(errors: GraphQLErrorShape[]): LinearApiError {
  const messages = errors
    .map((e) => e.extensions?.userPresentableMessage ?? e.message ?? 'unknown error')
    .join('; ')
  if (errors.some((e) => e.extensions?.code === 'RATELIMITED'))
    return new LinearApiError(messages, 'rate-limited')
  // Complexity-cap breaches hide behind generic INPUT_ERROR — parse the message (§10.5).
  if (/too complex/i.test(messages)) return new LinearApiError(messages, 'too-complex')
  if (errors.some((e) => e.extensions?.code === 'INPUT_ERROR'))
    return new LinearApiError(messages, 'input')
  return new LinearApiError(messages, 'graphql')
}

interface CredentialsFile {
  linear?: Record<string, { apiKey?: string }>
}

/**
 * Resolve the Linear API key: `LINEAR_API_KEY` env override, else
 * `~/.threadline/credentials.json` → `linear.<workspace-org-uuid>.apiKey`
 * (#19 §9). Without an orgId, a lone configured workspace wins.
 */
export async function resolveLinearApiKey(
  orgId?: string,
  env: NodeJS.ProcessEnv = process.env,
  credentialsPath = join(homedir(), '.threadline', 'credentials.json'),
): Promise<string> {
  if (env.LINEAR_API_KEY) return env.LINEAR_API_KEY
  const raw = await readFile(credentialsPath, 'utf8').catch(() => null)
  if (raw === null)
    throw new Error(`no Linear credentials: set LINEAR_API_KEY or create ${credentialsPath}`)
  const linear = (JSON.parse(raw) as CredentialsFile).linear ?? {}
  const entry = orgId ? linear[orgId] : Object.values(linear).length === 1 ? Object.values(linear)[0] : undefined
  if (!entry?.apiKey)
    throw new Error(
      orgId
        ? `no Linear API key for workspace ${orgId} in ${credentialsPath}`
        : `ambiguous or missing Linear credentials in ${credentialsPath} — pass a workspace org id`,
    )
  return entry.apiKey
}
