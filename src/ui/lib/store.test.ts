// Pipeline actions (#37): REST calls to /api/pipeline, session adoption, and
// the kept-dirty-worktree → Needs-you notice mapping.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from './types.js'
import { Store } from './store.js'

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    adapter: 'claude-code',
    cwd: '/ws/repo',
    prompt: 'implement',
    effort: 'o/r#1',
    stage: 'implement',
    createdAt: '2026-07-17T00:00:00Z',
    status: 'running',
    ...over,
  }
}

function stubFetch(body: unknown, ok = true) {
  const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 502, json: async () => body }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('store pipeline actions', () => {
  it('startImplement adopts and selects the returned session', async () => {
    const m = meta()
    const fetch = stubFetch(m)
    const store = new Store()
    expect(await store.startImplement('o/r#1', 'o/r#2')).toBeNull()
    expect(fetch).toHaveBeenCalledWith('/api/pipeline/implement', expect.objectContaining({ method: 'POST' }))
    const state = store.getState()
    expect(state.sessions['s1']?.meta).toEqual(m)
    expect(state.selectedSession).toBe('s1')
    expect(state.selectedEffort).toBe('o/r#1')
  })

  it('startReconcile surfaces the server error string', async () => {
    stubFetch({ error: 'no worktree for ticket o/r#2' }, false)
    const store = new Store()
    expect(await store.startReconcile('o/r#1', 'o/r#2')).toMatch(/no worktree/)
    expect(store.getState().sessions).toEqual({})
  })

  it('landEffort adopts sync sessions without stealing focus', async () => {
    const sync = meta({ id: 'sync1', stage: 'land-sync' })
    stubFetch({ results: [{ repo: 'r', status: 'sync_session_started', session: sync }] })
    const store = new Store()
    const res = await store.landEffort('o/r#1')
    expect(res.results).toHaveLength(1)
    expect(store.getState().sessions['sync1']?.meta).toEqual(sync)
    expect(store.getState().selectedSession).toBeNull()
  })

  it('completeEffort turns kept worktrees into dismissible notices, deduped', async () => {
    stubFetch({
      results: [
        { repo: 'r', removedWorktrees: ['/wt/a'], keptWorktrees: ['/wt/b'], trunkDeleted: false },
      ],
    })
    const store = new Store()
    await store.completeEffort('o/r#1')
    await store.completeEffort('o/r#1') // same kept worktree again — no duplicate
    const notices = store.getState().notices
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ effort: 'o/r#1', repo: 'r' })
    expect(notices[0]!.text).toContain('/wt/b')
    store.dismissNotice(notices[0]!.id)
    expect(store.getState().notices).toEqual([])
  })
})
