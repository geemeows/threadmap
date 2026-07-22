// Regrouping behaviour behind "Move to ad-hoc" (#102): detaching a session's
// effort optimistically drops the binding, so the derive selectors move it out
// of its effort's rows and into the ad-hoc group (ad-hoc == absence of effort).

import { describe, expect, it } from 'vitest'
import { adhocSessions, effortSessions } from './derive.js'
import { Store } from './store.js'
import type { SessionMeta } from './types.js'

function endedMeta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    adapter: 'claude-code',
    cwd: '/ws/repo',
    prompt: 'grill',
    effort: 'o/r#1',
    stage: 'planning',
    createdAt: '2026-07-17T00:00:00Z',
    status: 'ended',
    ...over,
  }
}

/** Give the store an open fake socket and capture what it sends. */
function withSocket(store: Store): string[] {
  const sent: string[] = []
  ;(store as unknown as {
    ws: { readyState: number; OPEN: number; send: (d: string) => void }
  }).ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(d) }
  return sent
}

describe('detachEffort regrouping', () => {
  it('moves a detached session out of its effort and into the ad-hoc group', () => {
    const store = new Store()
    const sent = withSocket(store)
    store.adoptSession(endedMeta(), { select: false })

    // Bound to its effort, not yet ad-hoc.
    expect(effortSessions(store.getState(), 'o/r#1').map((r) => r.view.meta.id)).toEqual(['s1'])
    expect(adhocSessions(store.getState())).toHaveLength(0)

    store.detachEffort('s1')

    // Optimistically regrouped, and the server was told.
    expect(effortSessions(store.getState(), 'o/r#1')).toHaveLength(0)
    expect(adhocSessions(store.getState()).map((r) => r.view.meta.id)).toEqual(['s1'])
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: 'detach_effort', sessionId: 's1' })
  })
})
