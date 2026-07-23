// Pipeline actions (#37): REST calls to /api/pipeline, session adoption, and
// the kept-dirty-worktree → Needs-you notice mapping.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from './types.js'
import { Store, wayfinderKickoffPrompt } from './store.js'

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
      mapClosed: false,
    })
    const store = new Store()
    const res = await store.completeEffort('o/r#1')
    expect(res.mapClosed).toBe(false)
    await store.completeEffort('o/r#1') // same kept worktree again — no duplicate
    const notices = store.getState().notices
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ effort: 'o/r#1', repo: 'r' })
    expect(notices[0]!.text).toContain('/wt/b')
    store.dismissNotice(notices[0]!.id)
    expect(store.getState().notices).toEqual([])
  })
})

describe('store session start (ADR-0002: client never sets a stage)', () => {
  /** Give the store an open fake socket and capture what it sends. */
  function withSocket(store: Store): string[] {
    const sent: string[] = []
    ;(store as unknown as {
      ws: { readyState: number; OPEN: number; send: (d: string) => void }
    }).ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(d) }
    return sent
  }

  it('startSession sends no stage and forwards the effort binding', () => {
    const store = new Store()
    const sent = withSocket(store)
    store.startSession({
      cwd: '/ws/repo',
      prompt: 'go',
      permissionPolicy: { mode: 'default', intercept: true },
      effort: 'o/r#1',
    })
    expect(sent).toHaveLength(1)
    const msg = JSON.parse(sent[0]!) as Record<string, unknown>
    expect(msg.type).toBe('start_session')
    expect(msg.effort).toBe('o/r#1')
    expect('stage' in msg).toBe(false)
  })

  it('an effort-less (ad-hoc) start sends neither effort nor stage', () => {
    const store = new Store()
    const sent = withSocket(store)
    store.startSession({
      cwd: '/ws/repo',
      prompt: 'go',
      permissionPolicy: { mode: 'default', intercept: true },
    })
    const msg = JSON.parse(sent[0]!) as Record<string, unknown>
    expect('effort' in msg).toBe(false)
    expect('stage' in msg).toBe(false)
  })

  it('setNewSessionOpen binds the modal to the clicked effort and clears it on close', () => {
    const store = new Store()
    store.setNewSessionOpen(true, 'o/r#9')
    expect(store.getState()).toMatchObject({ newSessionOpen: true, newSessionEffort: 'o/r#9' })
    store.setNewSessionOpen(true) // ad-hoc: no binding
    expect(store.getState().newSessionEffort).toBeNull()
    store.setNewSessionOpen(false)
    expect(store.getState()).toMatchObject({ newSessionOpen: false, newSessionEffort: null })
  })
})

describe('store mintEffort (#110: mint the map, then auto-start planning)', () => {
  function withSocket(store: Store): string[] {
    const sent: string[] = []
    ;(store as unknown as {
      ws: { readyState: number; OPEN: number; send: (d: string) => void }
    }).ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(d) }
    return sent
  }

  const effort = {
    ref: { id: 'o/r#7', display: 'o/r#7', url: 'https://github.com/o/r/issues/7' },
    title: 'Rework onboarding',
    state: 'open' as const,
    repo: { name: 'r', path: '/ws/r' },
  }

  it('POSTs the idea then auto-starts a seeded, stage-less planning session bound to the new effort', async () => {
    const fetch = stubFetch(effort)
    const store = new Store()
    const sent = withSocket(store)

    expect(await store.mintEffort('r', 'Rework onboarding\nmore detail')).toBeNull()

    // 1. POST /api/efforts with the idea + home repo.
    expect(fetch).toHaveBeenCalledWith('/api/efforts', expect.objectContaining({ method: 'POST' }))
    const opts = (fetch.mock.calls[0] as unknown as [string, { body: string }])[1]
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ repo: 'r', idea: 'Rework onboarding\nmore detail' })

    // 2. Effort adopted + selected; modal closed.
    const state = store.getState()
    expect(state.efforts.map((e) => e.ref.id)).toContain('o/r#7')
    expect(state.selectedEffort).toBe('o/r#7')
    expect(state.newEffortOpen).toBe(false)

    // 3. A planning session started: bound effort, cwd = home repo, NO stage on
    //    the wire (server derives `planning`), opening prompt a /wayfinder
    //    charting invocation seeded with the idea and the minted map ref.
    expect(sent).toHaveLength(1)
    const msg = JSON.parse(sent[0]!) as Record<string, unknown>
    expect(msg.type).toBe('start_session')
    expect(msg.effort).toBe('o/r#7')
    expect(msg.cwd).toBe('/ws/r')
    expect('stage' in msg).toBe(false)
    expect(msg.prompt).toContain('/wayfinder')
    expect(msg.prompt).toContain('o/r#7')
    expect(msg.prompt).toContain('Rework onboarding')
  })

  it('surfaces the server error and starts no session', async () => {
    stubFetch({ error: 'not a ready repo' }, false)
    const store = new Store()
    const sent = withSocket(store)
    expect(await store.mintEffort('r', 'idea')).toMatch(/not a ready repo/)
    expect(sent).toEqual([])
  })
})

describe('wayfinderKickoffPrompt', () => {
  it('is a /wayfinder charting invocation that charts into the minted map, not a new one', () => {
    const prompt = wayfinderKickoffPrompt('o/r#7', '  Rework onboarding  ')
    expect(prompt.startsWith('/wayfinder')).toBe(true)
    expect(prompt).toContain('o/r#7')
    expect(prompt).toContain('Rework onboarding') // idea, trimmed
    expect(prompt).toMatch(/do not create a second map/i)
  })
})
