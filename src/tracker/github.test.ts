import { describe, expect, it } from 'vitest'
import type { TicketRef } from './types.js'
import { GitHubAdapter, mintGitHubRef, parseGitHubRef, type GhRun } from './github.js'

const MAP: TicketRef = mintGitHubRef('acme/web', 1)

function subIssue(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 900 + Math.floor(Number(over.number ?? 2)),
    number: 2,
    state: 'open',
    html_url: 'https://github.com/acme/web/issues/2',
    repository_url: 'https://api.github.com/repos/acme/web',
    labels: [],
    assignees: [],
    issue_dependencies_summary: { blocked_by: 0 },
    ...over,
  }
}

/** Fake gh: routes by joined args; records calls. */
function fakeGh(routes: Record<string, unknown | ((args: string[]) => unknown)>) {
  const calls: string[][] = []
  const run: GhRun = async (args) => {
    calls.push(args)
    const key = Object.keys(routes).find((k) => args.join(' ').includes(k))
    if (!key) throw new Error(`no route for: ${args.join(' ')}`)
    const value = routes[key]
    const resolved = typeof value === 'function' ? (value as (a: string[]) => unknown)(args) : value
    if (resolved instanceof Error) throw resolved
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  }
  return { run, calls }
}

const TARGETS = [{ id: 'acme/web', display: 'web' }]

describe('parseGitHubRef', () => {
  it('parses owner/repo#n and rejects foreign refs', () => {
    expect(parseGitHubRef('acme/web#42')).toEqual({ repo: 'acme/web', number: 42 })
    expect(() => parseGitHubRef('0195c8f2-uuid')).toThrow(/not a GitHub ticket ref/)
  })
})

describe('GitHubAdapter reads', () => {
  it('openChildren filters by state and label namespace', async () => {
    const { run } = fakeGh({
      'issues/1/sub_issues': [
        subIssue({ number: 2, labels: [{ name: 'wayfinder:grilling' }] }),
        subIssue({ number: 3, state: 'closed', labels: [{ name: 'wayfinder:task' }] }),
        subIssue({ number: 4, labels: [{ name: 'threadline:ticket' }] }),
      ],
    })
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    const wayfinder = await adapter.openChildren(MAP, 'wayfinder')
    expect(wayfinder.map((r) => r.id)).toEqual(['acme/web#2'])
    const all = await adapter.openChildren(MAP)
    expect(all.map((r) => r.id)).toEqual(['acme/web#2', 'acme/web#4'])
  })

  it('children returns closed tickets too, with state', async () => {
    const { run } = fakeGh({
      'issues/1/sub_issues': [
        subIssue({ number: 4, labels: [{ name: 'threadline:ticket' }] }),
        subIssue({ number: 5, state: 'closed', labels: [{ name: 'threadline:ticket' }] }),
      ],
    })
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    expect(await adapter.children(MAP, 'ticket')).toEqual([
      { ref: mintGitHubRef('acme/web', 4, 'https://github.com/acme/web/issues/2'), state: 'open' },
      { ref: mintGitHubRef('acme/web', 5, 'https://github.com/acme/web/issues/2'), state: 'closed' },
    ])
  })

  it('frontier = open ∧ unblocked ∧ unassigned, in map order', async () => {
    const { run } = fakeGh({
      'issues/1/sub_issues': [
        subIssue({ number: 2 }),
        subIssue({ number: 3, issue_dependencies_summary: { blocked_by: 2 } }),
        subIssue({ number: 4, assignees: [{ login: 'dev' }] }),
        subIssue({ number: 5, state: 'closed' }),
        subIssue({ number: 6 }),
      ],
    })
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    expect((await adapter.frontier(MAP)).map((r) => r.id)).toEqual(['acme/web#2', 'acme/web#6'])
  })

  it('specStatus: none / open / closed ⇒ approved', async () => {
    const spec = (state: string) =>
      fakeGh({
        'issues/1/sub_issues': [subIssue({ number: 7, state, labels: [{ name: 'threadline:spec' }] })],
      }).run
    const none = new GitHubAdapter({
      targets: TARGETS,
      run: fakeGh({ 'issues/1/sub_issues': [subIssue({ number: 2 })] }).run,
    })
    expect(await none.specStatus(MAP)).toBe('none')
    expect(await new GitHubAdapter({ targets: TARGETS, run: spec('open') }).specStatus(MAP)).toBe('open')
    expect(await new GitHubAdapter({ targets: TARGETS, run: spec('closed') }).specStatus(MAP)).toBe('approved')
  })

  it('mapStamps strips the threadline: prefix and keeps wayfinder:* literal', async () => {
    const { run } = fakeGh({
      'repos/acme/web/issues/1': {
        labels: [
          { name: 'wayfinder:map' },
          { name: 'threadline:ticketed' },
          { name: 'threadline:override:implement' },
          { name: 'bug' },
        ],
      },
    })
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    expect(await adapter.mapStamps(MAP)).toEqual(['wayfinder:map', 'ticketed', 'override:implement'])
  })
})

describe('GitHubAdapter writes', () => {
  it('createChild creates in the target repo, labels it, links as sub-issue', async () => {
    const { run, calls } = fakeGh({
      'repos/acme/api/issues -f': { id: 555, number: 9, html_url: 'https://github.com/acme/api/issues/9' },
      'repos/acme/api/labels': {},
      'issues/9/labels': [],
      'issues/1/sub_issues': {},
    })
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    const ref = await adapter.createChild(MAP, {
      title: 'T',
      body: 'B',
      target: { id: 'acme/api', display: 'api' },
      labels: ['ticket'],
    })
    expect(ref.id).toBe('acme/api#9')
    const joined = calls.map((c) => c.join(' '))
    expect(joined.some((c) => c.includes('labels[]=threadline:ticket'))).toBe(true)
    expect(joined.some((c) => c.includes('repos/acme/web/issues/1/sub_issues') && c.includes('sub_issue_id=555'))).toBe(true)
  })

  it('addBlockedBy posts the blocker database id on the blocked side', async () => {
    const { run, calls } = fakeGh({
      'repos/acme/api/issues/3': { id: 777 },
      'dependencies/blocked_by': {},
    })
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    await adapter.addBlockedBy(mintGitHubRef('acme/web', 2), mintGitHubRef('acme/api', 3))
    const post = calls.map((c) => c.join(' ')).find((c) => c.includes('blocked_by'))
    expect(post).toContain('repos/acme/web/issues/2/dependencies/blocked_by')
    expect(post).toContain('issue_id=777')
  })

  it('resolve maps done/wontfix to state_reason', async () => {
    const { run, calls } = fakeGh({ 'repos/acme/web/issues/2': {}, comments: {} })
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    await adapter.resolve(mintGitHubRef('acme/web', 2), 'wontfix', 'nope')
    const joined = calls.map((c) => c.join(' '))
    expect(joined.some((c) => c.includes('comments') && c.includes('body=nope'))).toBe(true)
    expect(joined.some((c) => c.includes('state_reason=not_planned'))).toBe(true)
  })

  it('unstamp swallows 404 (already absent)', async () => {
    const { run } = fakeGh({ 'labels/threadline%3Aticketed': new Error('gh: HTTP 404 (Not Found)') })
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    await expect(adapter.unstamp(mintGitHubRef('acme/web', 2), 'ticketed')).resolves.toBeUndefined()
  })
})

describe('GitHubAdapter changesSince', () => {
  it('mints an ETag-set cursor and reports unchanged on 304s', async () => {
    let conditional = false
    const run: GhRun = async (args) => {
      const joined = args.join(' ')
      if (joined.includes('If-None-Match')) {
        conditional = true
        throw new Error('gh: HTTP 304')
      }
      return 'HTTP/2.0 200 OK\netag: W/"abc"\n\n{}'
    }
    const adapter = new GitHubAdapter({ targets: TARGETS, run })
    const first = await adapter.changesSince(MAP)
    expect(first.changed).toBe(true)
    expect(JSON.parse(first.cursor)).toEqual({ map: 'W/"abc"', children: 'W/"abc"' })
    const second = await adapter.changesSince(MAP, first.cursor)
    expect(conditional).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.cursor).toBe(first.cursor)
  })
})
