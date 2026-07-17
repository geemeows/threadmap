import { describe, expect, it } from 'vitest'
import type { TicketRef } from './types.js'
import { LinearAdapter } from './linear.js'
import { LinearApiError, LinearClient, resolveLinearApiKey } from './linear-client.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAP: TicketRef = { id: 'map-uuid', display: 'FE-1', url: 'https://linear.app/x/issue/FE-1' }

interface Call {
  query: string
  variables?: Record<string, unknown>
}

/** Fake client: routes by substring of the query text; records calls. */
function fakeClient(routes: Record<string, unknown | ((vars: Record<string, unknown> | undefined) => unknown)>) {
  const calls: Call[] = []
  const client = {
    async query(query: string, variables?: Record<string, unknown>) {
      calls.push({ query, variables })
      const key = Object.keys(routes).find((k) => query.includes(k))
      if (!key) throw new Error(`no route for query: ${query}`)
      const value = routes[key]
      return typeof value === 'function' ? (value as (v: unknown) => unknown)(variables) : value
    },
  } as unknown as LinearClient
  return { client, calls }
}

function issueNode(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'child-uuid',
    identifier: 'FE-2',
    url: 'https://linear.app/x/issue/FE-2',
    updatedAt: '2026-07-17T10:00:00.000Z',
    state: { type: 'started' },
    assignee: null,
    labels: { nodes: [] },
    ...over,
  }
}

describe('LinearAdapter reads', () => {
  it('frontier sends the server-side unblocked predicate', async () => {
    const { client, calls } = fakeClient({ 'issues(filter': { issues: { nodes: [issueNode()] } } })
    const adapter = new LinearAdapter({ client })
    const refs = await adapter.frontier(MAP)
    expect(refs).toEqual([{ id: 'child-uuid', display: 'FE-2', url: 'https://linear.app/x/issue/FE-2' }])
    expect(calls[0]?.variables?.filter).toMatchObject({
      parent: { id: { eq: 'map-uuid' } },
      assignee: { null: true },
      hasBlockedByRelations: { eq: false },
      state: { type: { nin: ['completed', 'canceled'] } },
    })
  })

  it('children maps completed/canceled states to closed', async () => {
    const { client } = fakeClient({
      'issues(filter': {
        issues: {
          nodes: [
            issueNode({ id: 'a', state: { type: 'completed' } }),
            issueNode({ id: 'b', state: { type: 'canceled' } }),
            issueNode({ id: 'c', state: { type: 'backlog' } }),
          ],
        },
      },
    })
    const adapter = new LinearAdapter({ client })
    const children = await adapter.children(MAP, 'ticket')
    expect(children.map((c) => c.state)).toEqual(['closed', 'closed', 'open'])
  })

  it('openChildren namespaces via label filters (literal colon spelling)', async () => {
    const { client, calls } = fakeClient({ 'issues(filter': { issues: { nodes: [] } } })
    const adapter = new LinearAdapter({ client })
    await adapter.openChildren(MAP, 'wayfinder')
    await adapter.openChildren(MAP, 'ticket')
    expect(calls[0]?.variables?.filter).toMatchObject({ labels: { name: { startsWith: 'wayfinder:' } } })
    expect(calls[1]?.variables?.filter).toMatchObject({ labels: { name: { eq: 'threadline:ticket' } } })
  })

  it('specStatus: completed ⇒ approved, canceled-only ⇒ none', async () => {
    const spec = (type: string) =>
      new LinearAdapter({
        client: fakeClient({
          'issues(filter': { issues: { nodes: [issueNode({ state: { type } })] } },
        }).client,
      })
    expect(await spec('completed').specStatus(MAP)).toBe('approved')
    expect(await spec('started').specStatus(MAP)).toBe('open')
    expect(await spec('canceled').specStatus(MAP)).toBe('none')
  })
})

describe('LinearAdapter writes', () => {
  it('resolve resolves the stateId from the issue’s own team by type', async () => {
    const { client, calls } = fakeClient({
      'issue(id: $id) { team { states':
        { issue: { team: { states: { nodes: [
          { id: 'done-2', type: 'completed', position: 5 },
          { id: 'done-1', type: 'completed', position: 2 },
          { id: 'cancel-1', type: 'canceled', position: 9 },
        ] } } } },
      issueUpdate: { issueUpdate: { success: true } },
    })
    const adapter = new LinearAdapter({ client })
    await adapter.resolve({ id: 'x', display: 'FE-9', url: '' }, 'done')
    const update = calls.find((c) => c.query.includes('issueUpdate'))
    expect(update?.variables?.input).toEqual({ stateId: 'done-1' }) // lowest position wins
  })

  it('addBlockedBy points blocker → blocked (issue blocks relatedIssue)', async () => {
    const { client, calls } = fakeClient({ issueRelationCreate: { issueRelationCreate: { success: true } } })
    const adapter = new LinearAdapter({ client })
    await adapter.addBlockedBy({ id: 'blocked', display: '', url: '' }, { id: 'blocker', display: '', url: '' })
    expect(calls[0]?.variables?.input).toEqual({ issueId: 'blocker', relatedIssueId: 'blocked', type: 'blocks' })
  })

  it('createChild ensures workspace labels then creates with parentId', async () => {
    const { client, calls } = fakeClient({
      'issueLabels(filter': { issueLabels: { nodes: [] } },
      issueLabelCreate: { issueLabelCreate: { issueLabel: { id: 'label-1' } } },
      issueCreate: { issueCreate: { issue: { id: 'new-uuid', identifier: 'BE-7', url: 'u' } } },
    })
    const adapter = new LinearAdapter({ client })
    const ref = await adapter.createChild(MAP, {
      title: 'T',
      body: 'B',
      target: { id: 'team-uuid', display: 'BE' },
      labels: ['ticket'],
    })
    expect(ref).toEqual({ id: 'new-uuid', display: 'BE-7', url: 'u' })
    const create = calls.find((c) => c.query.includes('issueCreate'))
    expect(create?.variables?.input).toMatchObject({
      teamId: 'team-uuid',
      parentId: 'map-uuid',
      labelIds: ['label-1'],
    })
    const labelCreate = calls.find((c) => c.query.includes('issueLabelCreate'))
    expect(labelCreate?.variables?.input).toEqual({ name: 'threadline:ticket' })
  })
})

describe('LinearAdapter changesSince', () => {
  it('advances an updatedAt watermark', async () => {
    const { client, calls } = fakeClient({
      'issues(filter': (vars: Record<string, unknown> | undefined) => {
        const filter = vars?.filter as { updatedAt?: { gt: string } }
        const nodes = filter.updatedAt
          ? filter.updatedAt.gt < '2026-07-17T11:00:00.000Z'
            ? [{ updatedAt: '2026-07-17T11:00:00.000Z' }]
            : []
          : [{ updatedAt: '2026-07-17T10:00:00.000Z' }]
        return { issues: { nodes } }
      },
    })
    const adapter = new LinearAdapter({ client })
    const first = await adapter.changesSince(MAP)
    expect(first).toEqual({ changed: true, cursor: '2026-07-17T10:00:00.000Z' })
    const second = await adapter.changesSince(MAP, first.cursor)
    expect(second).toEqual({ changed: true, cursor: '2026-07-17T11:00:00.000Z' })
    const third = await adapter.changesSince(MAP, second.cursor)
    expect(third).toEqual({ changed: false, cursor: '2026-07-17T11:00:00.000Z' })
    expect(calls[1]?.variables?.filter).toMatchObject({
      or: [{ id: { eq: 'map-uuid' } }, { parent: { id: { eq: 'map-uuid' } } }],
      updatedAt: { gt: '2026-07-17T10:00:00.000Z' },
    })
  })
})

describe('LinearClient error classification', () => {
  const respond = (status: number, body: unknown) =>
    (async () => ({ ok: status < 300, status, json: async () => body })) as unknown as typeof fetch

  it('classifies RATELIMITED, complexity-cap, and generic input errors', async () => {
    const cases: [unknown, string][] = [
      [{ errors: [{ extensions: { code: 'RATELIMITED' } }] }, 'rate-limited'],
      [
        { errors: [{ extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'The query is too complex. Complexity: 99999. Maximum allowed complexity: 10000.' } }] },
        'too-complex',
      ],
      [
        { errors: [{ extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'Discrepancy between issue team and state, cycle or project.' } }] },
        'input',
      ],
    ]
    for (const [body, kind] of cases) {
      const client = new LinearClient({ apiKey: 'k', fetchImpl: respond(400, body) })
      await expect(client.query('query { x }')).rejects.toMatchObject({ kind })
    }
  })

  it('sends the API key bare — no Bearer prefix', async () => {
    let auth: string | undefined
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization
      return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) }
    }) as unknown as typeof fetch
    const client = new LinearClient({ apiKey: 'lin_api_123', fetchImpl })
    await client.query('query { x }')
    expect(auth).toBe('lin_api_123')
  })
})

describe('resolveLinearApiKey', () => {
  it('prefers the env override, else reads credentials.json by org id', async () => {
    expect(await resolveLinearApiKey('org', { LINEAR_API_KEY: 'from-env' } as NodeJS.ProcessEnv)).toBe('from-env')
    const dir = await mkdtemp(join(tmpdir(), 'tl-creds-'))
    const path = join(dir, 'credentials.json')
    await writeFile(path, JSON.stringify({ linear: { 'org-1': { apiKey: 'from-file' } } }))
    expect(await resolveLinearApiKey('org-1', {} as NodeJS.ProcessEnv, path)).toBe('from-file')
    expect(await resolveLinearApiKey(undefined, {} as NodeJS.ProcessEnv, path)).toBe('from-file')
    await expect(resolveLinearApiKey('org-2', {} as NodeJS.ProcessEnv, path)).rejects.toThrow(/org-2/)
  })
})

describe('LinearApiError', () => {
  it('is an Error with a kind', () => {
    const err = new LinearApiError('m', 'http')
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('http')
  })
})
