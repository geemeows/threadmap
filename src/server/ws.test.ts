import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './registry.js'
import { TranscriptStore } from './transcripts.js'
import { FakeAdapter, eventually } from './test-helpers.js'
import type { ServerMessage } from './ws.js'
import { createConnection } from './ws.js'

let dir: string
let adapter: FakeAdapter
let registry: SessionRegistry
let sent: ServerMessage[]
let connection: ReturnType<typeof createConnection>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadmap-ws-proto-'))
  adapter = new FakeAdapter()
  registry = new SessionRegistry({ fake: adapter }, new TranscriptStore(dir))
  sent = []
  connection = createConnection(registry, (msg) => sent.push(msg))
})

afterEach(async () => {
  // Registry transcript writes are fire-and-forget; let in-flight appends settle
  // before rm, or a concurrent write races the rmdir into ENOTEMPTY.
  await new Promise((r) => setTimeout(r, 0))
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const startMsg = JSON.stringify({
  type: 'start_session',
  cwd: '/repo',
  prompt: 'go',
  permissionPolicy: { mode: 'default', intercept: true },
})

function sessionId(): string {
  const msg = sent.find((m) => m.type === 'session') as { meta: { id: string } }
  return msg.meta.id
}

describe('ws connection', () => {
  it('start_session replies with meta and streams that session’s events', async () => {
    await connection.onMessage(startMsg)
    expect(sent[0]).toMatchObject({ type: 'session', meta: { status: 'running' } })

    adapter.sessions[0]!.emit({ type: 'assistant_delta', text: 'hi', raw: {} })
    await eventually(() =>
      expect(sent).toContainEqual({
        type: 'event',
        sessionId: sessionId(),
        event: { type: 'assistant_delta', text: 'hi', raw: {} },
      }),
    )
  })

  it('attach replays the buffer; detach stops the stream', async () => {
    await connection.onMessage(startMsg)
    const id = sessionId()
    adapter.sessions[0]!.emit({ type: 'assistant_delta', text: 'one', raw: {} })
    await eventually(() => expect(sent.filter((m) => m.type === 'event')).toHaveLength(1))

    // a second connection attaching late sees the buffered event replayed
    const sent2: ServerMessage[] = []
    const conn2 = createConnection(registry, (msg) => sent2.push(msg))
    await conn2.onMessage(JSON.stringify({ type: 'attach', sessionId: id }))
    expect(sent2).toHaveLength(1)

    await conn2.onMessage(JSON.stringify({ type: 'detach', sessionId: id }))
    adapter.sessions[0]!.emit({ type: 'assistant_delta', text: 'two', raw: {} })
    await eventually(() => expect(sent.filter((m) => m.type === 'event')).toHaveLength(2))
    expect(sent2).toHaveLength(1) // detached — saw nothing new
  })

  it('routes send, permission, interrupt, and kill to the session', async () => {
    await connection.onMessage(startMsg)
    const id = sessionId()
    const session = adapter.sessions[0]!

    await connection.onMessage(JSON.stringify({ type: 'send', sessionId: id, text: 'more' }))
    await connection.onMessage(
      JSON.stringify({ type: 'permission', sessionId: id, id: 'p1', decision: { behavior: 'deny' } }),
    )
    await connection.onMessage(JSON.stringify({ type: 'interrupt', sessionId: id }))
    await connection.onMessage(JSON.stringify({ type: 'kill', sessionId: id }))

    expect(session.sent).toEqual([{ text: 'more' }])
    expect(session.permissions).toEqual([{ id: 'p1', decision: { behavior: 'deny' } }])
    expect(session.interrupted).toBe(true)
    expect(session.killed).toBe(true)
  })

  it('answers malformed and failing messages with error, not a dead socket', async () => {
    await connection.onMessage('not json')
    expect(sent[0]).toMatchObject({ type: 'error', message: expect.stringContaining('JSON') })

    await connection.onMessage(JSON.stringify({ type: 'send', sessionId: 'nope', text: 'x' }))
    expect(sent[1]).toMatchObject({ type: 'error', message: expect.stringContaining('nope') })

    await connection.onMessage(JSON.stringify({ type: 'wat' }))
    expect(sent[2]).toMatchObject({ type: 'error', message: expect.stringContaining('wat') })
  })

  it('derives the stage from the bound effort and stamps it before start', async () => {
    const conn = createConnection(registry, (m) => sent.push(m), async () => 'implement')
    await conn.onMessage(
      JSON.stringify({
        type: 'start_session',
        cwd: '/repo',
        prompt: 'go',
        effort: 'o/r#1',
        permissionPolicy: { mode: 'default', intercept: true },
      }),
    )
    expect(sent[0]).toMatchObject({ type: 'session', meta: { effort: 'o/r#1', stage: 'implement' } })
  })

  it('leaves an effort-less start stage-less', async () => {
    const conn = createConnection(registry, (m) => sent.push(m), async () => 'implement')
    await conn.onMessage(startMsg) // no effort
    const meta = (sent[0] as { meta: { effort?: string; stage?: string } }).meta
    expect(meta.effort).toBeUndefined()
    expect(meta.stage).toBeUndefined()
  })

  it('starts stage-agnostic (no throw) when the snapshot is unavailable', async () => {
    const conn = createConnection(registry, (m) => sent.push(m), async () => {
      throw new Error('tracker offline')
    })
    await conn.onMessage(
      JSON.stringify({
        type: 'start_session',
        cwd: '/repo',
        prompt: 'go',
        effort: 'o/r#1',
        permissionPolicy: { mode: 'default', intercept: true },
      }),
    )
    expect(sent[0]).toMatchObject({ type: 'session', meta: { effort: 'o/r#1' } })
    expect((sent[0] as { meta: { stage?: string } }).meta.stage).toBeUndefined()
    expect(sent.some((m) => m.type === 'error')).toBe(false)
  })

  it('detach_effort clears an ended session’s effort and refuses a running one (#102)', async () => {
    const store = new TranscriptStore(dir)
    await connection.onMessage(
      JSON.stringify({
        type: 'start_session',
        cwd: '/repo',
        prompt: 'go',
        effort: 'o/r#1',
        permissionPolicy: { mode: 'default', intercept: true },
      }),
    )
    const id = sessionId()

    // Running: the registry refuses — surfaced as an error, not a dead socket.
    await connection.onMessage(JSON.stringify({ type: 'detach_effort', sessionId: id }))
    expect(sent.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('still running') })

    adapter.sessions[0]!.emit({ type: 'session_ended', outcome: 'completed', resumable: false })
    await eventually(async () => expect((await store.readMeta(id))?.status).toBe('ended'))

    await connection.onMessage(JSON.stringify({ type: 'detach_effort', sessionId: id }))
    await eventually(async () => expect((await store.readMeta(id))?.effort).toBeUndefined())
  })

  it('close detaches all subscriptions', async () => {
    await connection.onMessage(startMsg)
    connection.close()
    adapter.sessions[0]!.emit({ type: 'assistant_delta', text: 'after', raw: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent.filter((m) => m.type === 'event')).toHaveLength(0)
  })
})
