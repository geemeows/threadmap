// Pure reduction of a session's transcript stream into renderable chat items.
// Keeps every rendering rule out of components so it's unit-testable.

import type { SessionMeta, SessionStatus, TranscriptEvent } from './types.js'

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string; streaming?: boolean }
  | { kind: 'tool'; text: string; error?: boolean }
  | {
      kind: 'approval'
      id: string
      tool: string
      input: unknown
      resolved?: 'allow' | 'deny'
    }
  | { kind: 'system'; text: string }

export function reduceTranscript(meta: SessionMeta, events: TranscriptEvent[]): ChatItem[] {
  const items: ChatItem[] = [{ kind: 'user', text: meta.prompt }]
  let streaming: { kind: 'agent'; text: string; streaming?: boolean } | null = null

  const closeStream = () => {
    if (streaming) streaming.streaming = false
    streaming = null
  }

  for (const event of events) {
    switch (event.type) {
      case 'assistant_delta':
        if (!streaming) {
          streaming = { kind: 'agent', text: '', streaming: true }
          items.push(streaming)
        }
        streaming.text += event.text
        break
      case 'assistant_message': {
        // The full message supersedes its own accumulated deltas.
        const text = extractText(event.content)
        if (streaming) {
          streaming.text = text || streaming.text
          closeStream()
        } else if (text) {
          items.push({ kind: 'agent', text })
        }
        break
      }
      case 'tool_call':
        closeStream()
        items.push({ kind: 'tool', text: `$ ${event.name} ${summarizeInput(event.input)}`.trim() })
        break
      case 'tool_result':
        if (event.isError) {
          items.push({ kind: 'tool', text: summarizeOutput(event.output), error: true })
        }
        break
      case 'permission_request':
        closeStream()
        items.push({ kind: 'approval', id: event.id, tool: event.tool, input: event.input })
        break
      case 'permission_response': {
        const approval = items.find(
          (i): i is ChatItem & { kind: 'approval' } => i.kind === 'approval' && i.id === event.id,
        )
        if (approval) approval.resolved = event.decision.behavior
        break
      }
      case 'user_message':
        closeStream()
        items.push({ kind: 'user', text: event.text })
        break
      case 'session_ended':
        closeStream()
        items.push({ kind: 'system', text: `session ended — ${event.outcome}` })
        break
      case 'session_started':
      case 'usage_update':
        break
    }
  }
  return items
}

export function pendingApprovals(events: TranscriptEvent[]) {
  const pending = new Map<string, { id: string; tool: string; input: unknown }>()
  for (const event of events) {
    if (event.type === 'permission_request') {
      pending.set(event.id, { id: event.id, tool: event.tool, input: event.input })
    } else if (event.type === 'permission_response') {
      pending.delete(event.id)
    }
  }
  return [...pending.values()]
}

/**
 * Status vocabulary from the locked visual system (#8): Active / Needs you /
 * Waiting / Done. "Waiting" is a heuristic — the agent's last move was a full
 * message with nothing pending, so the turn is with the human.
 */
export function sessionStatus(meta: SessionMeta, events: TranscriptEvent[]): SessionStatus {
  if (meta.status === 'ended') return 'done'
  if (pendingApprovals(events).length > 0) return 'needs-approval'
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'usage_update' || event.type === 'session_started') continue
    if (event.type === 'assistant_message') return 'waiting-human'
    break
  }
  return 'running'
}

function extractText(content: unknown[]): string {
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

/** One human-scannable line for a tool call, whatever the tool's input shape. */
export function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return truncate(input)
  if (typeof input !== 'object' || input === null) return ''
  const obj = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
    if (typeof obj[key] === 'string') return truncate(obj[key] as string)
  }
  const first = Object.values(obj).find((v) => typeof v === 'string')
  return first ? truncate(first as string) : ''
}

function summarizeOutput(output: unknown): string {
  if (typeof output === 'string') return truncate(output, 400)
  return truncate(JSON.stringify(output) ?? '', 400)
}

function truncate(text: string, max = 120): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
