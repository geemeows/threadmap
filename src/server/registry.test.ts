import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TranscriptEvent } from './transcripts.js'
import { RegistryError, SessionRegistry } from './registry.js'
import { TranscriptStore } from './transcripts.js'
import { FakeAdapter, eventually } from './test-helpers.js'

let dir: string
let adapter: FakeAdapter
let store: TranscriptStore
let registry: SessionRegistry

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadmap-registry-'))
  adapter = new FakeAdapter()
  store = new TranscriptStore(dir)
  registry = new SessionRegistry({ fake: adapter }, store)
})

afterEach(async () => {
  // Registry writes are fire-and-forget; let in-flight appends settle before rm.
  await new Promise((r) => setTimeout(r, 0))
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const startOpts = {
  cwd: '/repo',
  prompt: '/grilling go',
  permissionPolicy: { mode: 'default' as const, intercept: true },
  effort: 'geemeows/threadmap#1',
  stage: 'planning',
}

describe('SessionRegistry', () => {
  it('starts a session and fans events out to subscribers and the transcript', async () => {
    const meta = registry.start(startOpts)
    expect(meta.status).toBe('running')
    expect(meta.effort).toBe('geemeows/threadmap#1')

    const received: TranscriptEvent[] = []
    registry.subscribe(meta.id, (e) => received.push(e))

    const session = adapter.sessions[0]!
    session.emit({ type: 'session_started', resumeToken: 'tok-1', model: 'm', raw: {} })
    session.emit({ type: 'assistant_delta', text: 'hi', raw: {} })

    await eventually(() => expect(received).toHaveLength(2))
    expect(registry.get(meta.id)?.resumeToken).toBe('tok-1')
    await eventually(async () => expect(await store.readEvents(meta.id)).toHaveLength(2))
  })

  it('replays buffered events to a late subscriber', async () => {
    const meta = registry.start(startOpts)
    const session = adapter.sessions[0]!
    session.emit({ type: 'session_started', resumeToken: 'tok-1', model: 'm', raw: {} })
    session.emit({ type: 'assistant_delta', text: 'early', raw: {} })
    await eventually(() => expect(registry.get(meta.id)?.resumeToken).toBe('tok-1'))

    const received: TranscriptEvent[] = []
    registry.subscribe(meta.id, (e) => received.push(e))
    expect(received.map((e) => e.type)).toEqual(['session_started', 'assistant_delta'])
  })

  it('records user messages and permission responses in the transcript', async () => {
    const meta = registry.start(startOpts)
    const received: TranscriptEvent[] = []
    registry.subscribe(meta.id, (e) => received.push(e))

    registry.send(meta.id, { text: 'more' })
    registry.respondPermission(meta.id, 'p1', { behavior: 'deny', message: 'no' })

    expect(received).toEqual([
      { type: 'user_message', text: 'more' },
      { type: 'permission_response', id: 'p1', decision: { behavior: 'deny', message: 'no' } },
    ])
    await eventually(async () => expect(await store.readEvents(meta.id)).toHaveLength(2))
  })

  it('routes send/permission/interrupt/kill to the live session', () => {
    const meta = registry.start(startOpts)
    const session = adapter.sessions[0]!

    registry.send(meta.id, { text: 'more' })
    registry.respondPermission(meta.id, 'p1', { behavior: 'allow' })
    registry.interrupt(meta.id)
    registry.kill(meta.id)

    expect(session.sent).toEqual([{ text: 'more' }])
    expect(session.permissions).toEqual([{ id: 'p1', decision: { behavior: 'allow' } }])
    expect(session.interrupted).toBe(true)
    expect(session.killed).toBe(true)
  })

  it('marks the session ended with outcome and usage, and persists meta', async () => {
    const meta = registry.start(startOpts)
    const session = adapter.sessions[0]!
    session.emit({ type: 'session_started', resumeToken: 'tok-1', model: 'm', raw: {} })
    session.emit({
      type: 'session_ended',
      outcome: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      resumable: true,
      raw: {},
    })

    await eventually(async () => {
      const persisted = await store.readMeta(meta.id)
      expect(persisted?.status).toBe('ended')
      expect(persisted?.outcome).toBe('completed')
      expect(persisted?.usage?.costUsd).toBe(0.01)
      expect(persisted?.resumeToken).toBe('tok-1')
    })
    expect(registry.get(meta.id)).toBeUndefined() // no longer live
  })

  it('resumes an ended session with its stored token and inherits effort binding', async () => {
    const meta = registry.start(startOpts)
    const session = adapter.sessions[0]!
    session.emit({ type: 'session_started', resumeToken: 'tok-1', model: 'm', raw: {} })
    session.emit({ type: 'session_ended', outcome: 'completed', resumable: true, raw: {} })
    await eventually(async () => expect((await store.readMeta(meta.id))?.status).toBe('ended'))

    const resumed = await registry.resume(meta.id, 'continue')
    expect(adapter.resumed).toEqual([{ token: 'tok-1', opts: expect.anything() }])
    expect(resumed.id).not.toBe(meta.id)
    expect(resumed.effort).toBe('geemeows/threadmap#1')
    expect(resumed.stage).toBe('planning')
  })

  it('refuses to resume a running or non-resumable session', async () => {
    const meta = registry.start(startOpts)
    await expect(registry.resume(meta.id, 'x')).rejects.toThrow(RegistryError)

    const session = adapter.sessions[0]!
    session.emit({ type: 'session_ended', outcome: 'crashed', resumable: false })
    await eventually(async () => expect((await store.readMeta(meta.id))?.status).toBe('ended'))
    await expect(registry.resume(meta.id, 'x')).rejects.toThrow(/not resumable/)
  })

  it('lists live and persisted sessions together, newest first', async () => {
    const a = registry.start(startOpts)
    adapter.sessions[0]!.emit({ type: 'session_ended', outcome: 'completed', resumable: false })
    await eventually(async () => expect((await store.readMeta(a.id))?.status).toBe('ended'))

    const b = registry.start(startOpts)
    const list = await registry.list()
    expect(list.map((m) => m.id)).toContain(a.id)
    expect(list.map((m) => m.id)).toContain(b.id)
    expect(list.find((m) => m.id === b.id)?.status).toBe('running')
  })

  it('throws on operations against unknown sessions', () => {
    expect(() => registry.send('nope', { text: 'x' })).toThrow(RegistryError)
    expect(() => registry.subscribe('nope', () => {})).toThrow(RegistryError)
  })
})
