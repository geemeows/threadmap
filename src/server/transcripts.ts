// Persistent, re-openable transcripts under ~/.threadmap/transcripts.
// One JSONL file of normalized AgentEvents (raw CLI JSON attached) plus one
// metadata sidecar per session. Ephemeral by design — losing this directory
// loses chat history, never pipeline state (ADR-0001).

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, PermissionDecision, SessionOutcome, Usage } from '../adapters/index.js'
import { transcriptsDir } from './home.js'

// The adapter seam's AgentEvent stream is CLI output only — it never carries
// the human's half of the conversation. Re-openable transcripts (MVP extra)
// need both halves, so the registry records its own entries for user input
// and permission decisions alongside the agent's events.
export type TranscriptEvent =
  | AgentEvent
  | { type: 'user_message'; text: string }
  | { type: 'permission_response'; id: string; decision: PermissionDecision }

export interface SessionMeta {
  id: string
  adapter: string
  cwd: string
  prompt: string
  /** Effort ref id (`owner/repo#n`); absent on setup sessions (CONTEXT.md: Session). */
  effort?: string
  stage?: string
  createdAt: string
  status: 'running' | 'ended'
  outcome?: SessionOutcome
  resumeToken?: string
  usage?: Usage
}

export class TranscriptStore {
  constructor(private dir = transcriptsDir()) {}

  async append(sessionId: string, event: TranscriptEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await appendFile(this.eventsPath(sessionId), `${JSON.stringify(event)}\n`, 'utf8')
  }

  async writeMeta(meta: SessionMeta): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8')
  }

  async readMeta(sessionId: string): Promise<SessionMeta | null> {
    const text = await readFile(this.metaPath(sessionId), 'utf8').catch(() => null)
    return text === null ? null : (JSON.parse(text) as SessionMeta)
  }

  async readEvents(sessionId: string): Promise<TranscriptEvent[]> {
    const text = await readFile(this.eventsPath(sessionId), 'utf8').catch(() => '')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptEvent)
  }

  /** All known sessions, newest first — re-openable transcripts survive restarts. */
  async list(): Promise<SessionMeta[]> {
    const files = await readdir(this.dir).catch(() => [])
    const metas = await Promise.all(
      files
        .filter((f) => f.endsWith('.meta.json'))
        .map((f) => this.readMeta(f.slice(0, -'.meta.json'.length))),
    )
    return metas
      .filter((m): m is SessionMeta => m !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private eventsPath(id: string) {
    return join(this.dir, `${id}.jsonl`)
  }

  private metaPath(id: string) {
    return join(this.dir, `${id}.meta.json`)
  }
}
