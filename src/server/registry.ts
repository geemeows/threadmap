// In-process session spawn registry — the one place live AgentSessions exist
// (tech-stack decision #9). It pumps each session's event stream exactly once,
// fanning out to (a) the transcript store and (b) any number of attached
// subscribers, with an in-memory replay buffer so a browser can re-open a chat
// mid-run. Everything else addresses sessions by id through this registry.

import { randomUUID } from 'node:crypto'
import type {
  AgentAdapter,
  AgentEvent,
  PermissionDecision,
  StartOptions,
  UserMessage,
} from '../adapters/index.js'
import type { SessionMeta, TranscriptEvent } from './transcripts.js'
import { TranscriptStore } from './transcripts.js'

export interface StartSessionOptions extends StartOptions {
  /** Adapter name; defaults to the registry's only adapter when unambiguous. */
  adapter?: string
  /** Effort ref id (`owner/repo#n`); absent on setup sessions. */
  effort?: string
  stage?: string
}

export type SessionListener = (event: TranscriptEvent) => void

interface LiveSession {
  meta: SessionMeta
  buffer: TranscriptEvent[]
  listeners: Set<SessionListener>
  send: (msg: UserMessage) => void
  respondPermission: (id: string, decision: PermissionDecision) => void
  interrupt: () => void
  kill: () => void
}

export class SessionRegistry {
  private live = new Map<string, LiveSession>()

  constructor(
    private adapters: Record<string, AgentAdapter>,
    private store = new TranscriptStore(),
    private now: () => string = () => new Date().toISOString(),
  ) {}

  start(opts: StartSessionOptions): SessionMeta {
    const adapter = this.pickAdapter(opts.adapter)
    return this.track(adapter.name, opts, (o) => adapter.start(o))
  }

  /** Re-open an ended session with the resume token its adapter minted. */
  async resume(sessionId: string, prompt: string): Promise<SessionMeta> {
    const prior = this.live.get(sessionId)?.meta ?? (await this.store.readMeta(sessionId))
    if (!prior) throw new RegistryError(`unknown session: ${sessionId}`)
    if (prior.status === 'running') throw new RegistryError(`session still running: ${sessionId}`)
    if (!prior.resumeToken) throw new RegistryError(`session not resumable: ${sessionId}`)
    const adapter = this.pickAdapter(prior.adapter)
    const opts: StartSessionOptions = {
      cwd: prior.cwd,
      prompt,
      permissionPolicy: { mode: 'default', intercept: true },
      effort: prior.effort,
      stage: prior.stage,
    }
    return this.track(adapter.name, opts, (o) => adapter.resume(prior.resumeToken!, o))
  }

  get(sessionId: string): SessionMeta | undefined {
    return this.live.get(sessionId)?.meta
  }

  /** Live sessions plus ended ones persisted by the transcript store. */
  async list(): Promise<SessionMeta[]> {
    const persisted = await this.store.list()
    const liveIds = new Set(this.live.keys())
    return [
      ...[...this.live.values()].map((s) => s.meta),
      ...persisted.filter((m) => !liveIds.has(m.id)),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Attach a listener: replays buffered events synchronously, then streams
   * live ones. Returns a detach function.
   */
  subscribe(sessionId: string, listener: SessionListener): () => void {
    const session = this.require(sessionId)
    for (const event of session.buffer) listener(event)
    session.listeners.add(listener)
    return () => session.listeners.delete(listener)
  }

  send(sessionId: string, msg: UserMessage): void {
    const session = this.require(sessionId)
    session.send(msg)
    // The adapter stream never echoes user input — record the human's half
    // here so re-opened transcripts hold the whole conversation.
    if ('text' in msg) this.record(session, { type: 'user_message', text: msg.text })
  }

  respondPermission(sessionId: string, permissionId: string, decision: PermissionDecision): void {
    const session = this.require(sessionId)
    session.respondPermission(permissionId, decision)
    this.record(session, { type: 'permission_response', id: permissionId, decision })
  }

  interrupt(sessionId: string): void {
    this.require(sessionId).interrupt()
  }

  kill(sessionId: string): void {
    this.require(sessionId).kill()
  }

  /** Kill every live session — server shutdown. */
  killAll(): void {
    for (const s of this.live.values()) s.kill()
  }

  private track(
    adapterName: string,
    opts: StartSessionOptions,
    spawn: (o: StartOptions) => ReturnType<AgentAdapter['start']>,
  ): SessionMeta {
    const session = spawn(opts)
    const meta: SessionMeta = {
      id: randomUUID(),
      adapter: adapterName,
      cwd: opts.cwd,
      prompt: opts.prompt,
      effort: opts.effort,
      stage: opts.stage,
      createdAt: this.now(),
      status: 'running',
    }
    const entry: LiveSession = {
      meta,
      buffer: [],
      listeners: new Set(),
      send: (m) => session.send(m),
      respondPermission: (id, d) => session.respondPermission(id, d),
      interrupt: () => session.interrupt(),
      kill: () => session.kill(),
    }
    this.live.set(meta.id, entry)
    void this.store.writeMeta(meta).catch(() => {})
    void this.pump(entry, session.events)
    return meta
  }

  private async pump(entry: LiveSession, events: AsyncIterable<AgentEvent>): Promise<void> {
    const { meta } = entry
    try {
      for await (const event of events) {
        entry.buffer.push(event)
        await this.store.append(meta.id, event).catch(() => {})
        if (event.type === 'session_started') {
          meta.resumeToken = event.resumeToken
          void this.store.writeMeta(meta).catch(() => {})
        } else if (event.type === 'usage_update') {
          meta.usage = event.usage
        } else if (event.type === 'session_ended') {
          meta.status = 'ended'
          meta.outcome = event.outcome
          if (event.usage) meta.usage = event.usage
          if (!event.resumable) meta.resumeToken = undefined
        }
        for (const listener of entry.listeners) listener(event)
      }
    } finally {
      // The seam guarantees exactly-one session_ended (synthesized on crash),
      // but a broken iterator must not leave a zombie 'running' meta behind.
      if (meta.status !== 'ended') {
        meta.status = 'ended'
        meta.outcome = 'crashed'
      }
      await this.store.writeMeta(meta).catch(() => {})
      this.live.delete(meta.id)
    }
  }

  private record(session: LiveSession, event: TranscriptEvent): void {
    session.buffer.push(event)
    void this.store.append(session.meta.id, event).catch(() => {})
    for (const listener of session.listeners) listener(event)
  }

  private pickAdapter(name?: string): AgentAdapter {
    if (name) {
      const adapter = this.adapters[name]
      if (!adapter) throw new RegistryError(`unknown adapter: ${name}`)
      return adapter
    }
    const all = Object.values(this.adapters)
    if (all.length !== 1 || !all[0]) throw new RegistryError('adapter name required')
    return all[0]
  }

  private require(sessionId: string): LiveSession {
    const session = this.live.get(sessionId)
    if (!session) throw new RegistryError(`no live session: ${sessionId}`)
    return session
  }
}

export class RegistryError extends Error {}
