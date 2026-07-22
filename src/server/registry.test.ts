import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TranscriptEvent } from './transcripts.js'
import { RegistryError, SessionRegistry, TRACKER_MCP_KEY, type TrackerMcpFactory } from './registry.js'
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

  it('setPermissionMode flips a live session, updates meta, and records the change', async () => {
    const meta = registry.start(startOpts)
    expect(meta.permissionMode).toBe('default')
    const session = adapter.sessions[0]!
    const received: TranscriptEvent[] = []
    registry.subscribe(meta.id, (e) => received.push(e))

    await registry.setPermissionMode(meta.id, 'acceptEdits')

    expect(session.permissionModes).toEqual(['acceptEdits'])
    expect(registry.get(meta.id)?.permissionMode).toBe('acceptEdits')
    expect(received).toContainEqual({ type: 'permission_mode', mode: 'acceptEdits' })
    await eventually(async () =>
      expect((await store.readMeta(meta.id))?.permissionMode).toBe('acceptEdits'),
    )
  })

  it('carries the chosen permission mode into a resume (ended-session path persists only)', async () => {
    const meta = registry.start(startOpts)
    const session = adapter.sessions[0]!
    session.emit({ type: 'session_started', resumeToken: 'tok-1', model: 'm', raw: {} })
    session.emit({ type: 'session_ended', outcome: 'completed', resumable: true, raw: {} })
    await eventually(async () => expect((await store.readMeta(meta.id))?.status).toBe('ended'))

    // No live process to flip — this must persist to meta so resume reads it.
    await registry.setPermissionMode(meta.id, 'bypassPermissions')
    const resumed = await registry.resume(meta.id, 'continue')

    expect(resumed.permissionMode).toBe('bypassPermissions')
    expect(adapter.resumed.at(-1)?.opts.permissionPolicy.mode).toBe('bypassPermissions')
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

  it('detachEffort clears an ended session’s effort but refuses a running one (#102)', async () => {
    const meta = registry.start(startOpts)

    // Running: refused — its in-memory meta would clobber the disk edit.
    await expect(registry.detachEffort(meta.id)).rejects.toThrow(/still running/)

    adapter.sessions[0]!.emit({ type: 'session_ended', outcome: 'completed', resumable: false })
    await eventually(async () => expect((await store.readMeta(meta.id))?.status).toBe('ended'))

    // Ended: the binding is cleared on disk, transcript-owning meta untouched.
    await registry.detachEffort(meta.id)
    expect((await store.readMeta(meta.id))?.effort).toBeUndefined()
  })
})

describe('SessionRegistry question bridge', () => {
  it('awaitAnswer resolves when the UI answers the pending question', async () => {
    const meta = registry.start(startOpts)
    const answerPromise = registry.awaitAnswer(meta.id)
    registry.answerQuestion(meta.id, 'toolu_1', [], { 'Which?': 'A' })
    expect(await answerPromise).toEqual({ 'Which?': 'A' })
  })

  it('awaitAnswer rejects when the session ends before an answer', async () => {
    const meta = registry.start(startOpts)
    const awaiting = registry.awaitAnswer(meta.id)
    adapter.sessions[0]!.emit({ type: 'session_ended', outcome: 'completed', resumable: false, raw: {} })
    await expect(awaiting).rejects.toThrow(/session ended/)
  })

  it('wires the question MCP tool into planning sessions only when a base URL is set', () => {
    const withUrl = new SessionRegistry({ fake: adapter }, store, undefined, 'http://127.0.0.1:4664')
    withUrl.start(startOpts)
    const opts = adapter.sessions[0]!.opts
    const servers = opts.mcpConfig?.servers as Record<string, { url: string }>
    expect(servers.threadmap?.url).toMatch(/^http:\/\/127\.0\.0\.1:4664\/mcp\//)
    expect(opts.permissionPolicy.allowedTools).toContain('mcp__threadmap__ask_user_questions')
    expect(opts.appendSystemPrompt).toMatch(/ask_user_questions/)
  })

  it('does not wire the tool into non-planning sessions', () => {
    const withUrl = new SessionRegistry({ fake: adapter }, store, undefined, 'http://127.0.0.1:4664')
    withUrl.start({ ...startOpts, stage: 'implement' })
    const opts = adapter.sessions[0]!.opts
    expect(opts.mcpConfig).toBeUndefined()
    expect(opts.appendSystemPrompt).toBeUndefined()
  })
})

describe('SessionRegistry planning guardrail', () => {
  it('injects the "plan, don\'t do" guardrail into planning sessions even without the question MCP', () => {
    registry.start(startOpts)
    const opts = adapter.sessions[0]!.opts
    expect(opts.appendSystemPrompt).toMatch(/planning \(\/wayfinder\) stage/)
    expect(opts.appendSystemPrompt).toMatch(/Do NOT create implementation tickets/)
  })

  it('does not inject the guardrail into non-planning sessions', () => {
    registry.start({ ...startOpts, stage: 'implement' })
    expect(adapter.sessions[0]!.opts.appendSystemPrompt).toBeUndefined()
  })
})

describe('SessionRegistry tracker MCP injection (gate #2)', () => {
  const factory: TrackerMcpFactory = (stage) => ({
    command: 'node',
    args: ['cli.js', 'tracker-mcp', '--org', 'org-1', ...(stage ? ['--stage', stage] : [])],
  })

  it('injects the tracker write path bound to the session stage', () => {
    const reg = new SessionRegistry({ fake: adapter }, store, undefined, undefined, factory)
    reg.start({ ...startOpts, stage: 'to-tickets' })
    const servers = adapter.sessions[0]!.opts.mcpConfig?.servers as Record<string, unknown>
    expect(servers[TRACKER_MCP_KEY]).toEqual({
      command: 'node',
      args: ['cli.js', 'tracker-mcp', '--org', 'org-1', '--stage', 'to-tickets'],
    })
  })

  it('injects into every stage, not just planning', () => {
    const reg = new SessionRegistry({ fake: adapter }, store, undefined, undefined, factory)
    reg.start({ ...startOpts, stage: 'implement' })
    const servers = adapter.sessions[0]!.opts.mcpConfig?.servers as Record<string, unknown>
    expect(servers[TRACKER_MCP_KEY]).toMatchObject({ args: expect.arrayContaining(['--stage', 'implement']) })
  })

  it('does not inject when no factory is set (GitHub workspaces use gh)', () => {
    registry.start({ ...startOpts, stage: 'planning' })
    expect(adapter.sessions[0]!.opts.mcpConfig?.servers).toBeUndefined()
  })

  it('composes with the question MCP tool on planning sessions', () => {
    const reg = new SessionRegistry(
      { fake: adapter },
      store,
      undefined,
      'http://127.0.0.1:4664',
      factory,
    )
    reg.start(startOpts)
    const servers = adapter.sessions[0]!.opts.mcpConfig?.servers as Record<string, unknown>
    expect(servers[TRACKER_MCP_KEY]).toBeDefined()
    expect(servers.threadmap).toBeDefined() // the question MCP server
  })
})
