import { describe, expect, it } from 'vitest'
import type { TicketRef } from '../tracker/types.js'
import { countUnresolved, GhPrSource, parseVerdict, pickPR, reviewBodies, type GhExec } from './gh-pr-source.js'

function ref(id: string, display = id): TicketRef {
  return { id, display, url: `https://example.test/${id}` }
}

function ghPr(over: Partial<Parameters<typeof pickPR>[0][number]>) {
  return { number: 1, url: 'u', state: 'OPEN' as const, headRefName: 'tm/feat/1-x', body: '', ...over }
}

describe('pickPR', () => {
  const open = ghPr({ number: 1, url: 'u1', state: 'OPEN' })
  const merged = ghPr({ number: 2, url: 'u2', state: 'MERGED' })
  const closed = ghPr({ number: 3, url: 'u3', state: 'CLOSED' })

  it('prefers open over merged over abandoned', () => {
    expect(pickPR([closed, merged, open])).toBe(open)
    expect(pickPR([closed, merged])).toBe(merged)
    expect(pickPR([closed])).toBe(closed)
    expect(pickPR([])).toBeUndefined()
  })
})

describe('countUnresolved', () => {
  it('counts unresolved threads and tolerates missing shapes', () => {
    const graphql = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] },
          },
        },
      },
    }
    expect(countUnresolved(graphql)).toBe(2)
    expect(countUnresolved({})).toBe(0)
  })
})

describe('parseVerdict', () => {
  it('takes the latest review carrying a Verdict first line — re-reviews supersede (#41)', () => {
    expect(parseVerdict(['Verdict: request-changes\nnits', 'plain comment', 'Verdict: approve\nfixed'])).toBe('approve')
    expect(parseVerdict(['Verdict: approve', 'Verdict: request-changes\nregression'])).toBe('request-changes')
  })

  it('matches the first line only, case-insensitively, and ignores everything else', () => {
    expect(parseVerdict(['  verdict: APPROVE  \nprose'])).toBe('approve')
    expect(parseVerdict(['prose first\nVerdict: approve'])).toBeNull()
    expect(parseVerdict(['Verdict: maybe', 'no verdict here'])).toBeNull()
    expect(parseVerdict([])).toBeNull()
  })
})

describe('reviewBodies', () => {
  it('extracts review bodies and tolerates missing shapes', () => {
    const graphql = {
      data: { repository: { pullRequest: { reviews: { nodes: [{ body: 'a' }, {}] } } } },
    }
    expect(reviewBodies(graphql)).toEqual(['a', ''])
    expect(reviewBodies({})).toEqual([])
  })
})

describe('GhPrSource', () => {
  it('lists PRs by trunk base, matches the ticket branch by regex, and fetches threads for live PRs', async () => {
    const calls: string[][] = []
    const exec: GhExec = async (args, repoDir) => {
      calls.push([repoDir, ...args])
      if (args[0] === 'pr')
        return JSON.stringify([
          ghPr({ number: 9, url: 'other', headRefName: 'tm/feat/20-unrelated' }),
          ghPr({ number: 7, url: 'https://x/pull/7', headRefName: 'tm/fix/2-crash', body: 'Ticket: #2' }),
        ])
      return JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }] } } } },
      })
    }
    const pr = await new GhPrSource(exec).ticketPR('/ws/repo', ref('o/repo#2'), 'tm/effort/1')
    expect(pr).toEqual({ url: 'https://x/pull/7', number: 7, state: 'open', unresolvedReviewThreads: 1 })
    expect(calls[0]).toEqual([
      '/ws/repo', 'pr', 'list', '--base', 'tm/effort/1', '--state', 'all',
      '--json', 'number,url,state,headRefName,body,mergeable', '--limit', '100',
    ])
    expect(calls[1]![0]).toBe('/ws/repo')
    expect(calls[1]).toContain('graphql')
    expect(calls[1]).toContain('number=7')
  })

  it('carries the latest agent verdict off the same GraphQL call (#41)', async () => {
    const source = new GhPrSource(async (args) => {
      if (args[0] === 'pr')
        return JSON.stringify([ghPr({ number: 7, headRefName: 'tm/fix/2-crash', body: 'Ticket: #2' })])
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [] },
              reviews: { nodes: [{ body: 'Verdict: request-changes\nmissing tests' }, { body: 'Verdict: approve\nlgtm' }] },
            },
          },
        },
      })
    })
    const pr = await source.ticketPR('/r', ref('o/repo#2'), 'tm/effort/1')
    expect(pr?.agentVerdict).toBe('approve')
  })

  it('leaves agentVerdict unset when no review carries a Verdict line', async () => {
    const source = new GhPrSource(async (args) => {
      if (args[0] === 'pr')
        return JSON.stringify([ghPr({ number: 7, headRefName: 'tm/fix/2-crash', body: 'Ticket: #2' })])
      return JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] }, reviews: { nodes: [{ body: 'just prose' }] } } } },
      })
    })
    const pr = await source.ticketPR('/r', ref('o/repo#2'), 'tm/effort/1')
    expect(pr?.agentVerdict).toBeUndefined()
  })

  it('flags an open PR GitHub reports as CONFLICTING, but never a merged one', async () => {
    const source = (state: 'OPEN' | 'MERGED', mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN') =>
      new GhPrSource(async (args) => {
        if (args[0] === 'pr')
          return JSON.stringify([ghPr({ number: 7, state, headRefName: 'tm/fix/2-crash', body: 'Ticket: #2', mergeable })])
        return JSON.stringify({})
      })
    const conflicted = await source('OPEN', 'CONFLICTING').ticketPR('/r', ref('o/repo#2'), 'tm/effort/1')
    expect(conflicted?.conflicting).toBe(true)
    const clean = await source('OPEN', 'MERGEABLE').ticketPR('/r', ref('o/repo#2'), 'tm/effort/1')
    expect(clean?.conflicting).toBeUndefined()
    const merged = await source('MERGED', 'CONFLICTING').ticketPR('/r', ref('o/repo#2'), 'tm/effort/1')
    expect(merged?.conflicting).toBeUndefined()
  })

  it('flags a GitHub ticket PR whose body lacks the Ticket: #<n> reference', async () => {
    const exec: GhExec = async (args) => {
      if (args[0] === 'pr')
        return JSON.stringify([ghPr({ number: 7, headRefName: 'tm/fix/2-crash', body: 'no reference here' })])
      return JSON.stringify({})
    }
    const pr = await new GhPrSource(exec).ticketPR('/r', ref('o/repo#2'), 'tm/effort/1')
    expect(pr?.missingTicketRef).toBe(true)
  })

  it('never flags Linear tickets — linkage rides the branch name', async () => {
    const exec: GhExec = async (args) => {
      if (args[0] === 'pr')
        return JSON.stringify([ghPr({ number: 7, headRefName: 'tm/feat/FE-12-thing', body: '' })])
      return JSON.stringify({})
    }
    const pr = await new GhPrSource(exec).ticketPR('/r', ref('uuid-abc', 'FE-12'), 'tm/effort/1')
    expect(pr?.missingTicketRef).toBeUndefined()
  })

  it('returns null when no PR matches and skips threads for abandoned PRs', async () => {
    const none = new GhPrSource(async () => '[]')
    expect(await none.ticketPR('/r', ref('o/repo#2'), 'tm/effort/1')).toBeNull()

    let graphqlCalled = false
    const abandoned = new GhPrSource(async (args) => {
      if (args[0] === 'api') graphqlCalled = true
      return JSON.stringify([ghPr({ number: 7, state: 'CLOSED', headRefName: 'tm/fix/2', body: 'Ticket: #2' })])
    })
    expect(await abandoned.ticketPR('/r', ref('o/repo#2'), 'tm/effort/1')).toEqual({
      url: 'u',
      number: 7,
      state: 'closed',
      unresolvedReviewThreads: 0,
    })
    expect(graphqlCalled).toBe(false)
  })
})
