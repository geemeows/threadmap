// The one bidirectional channel (tech-stack decision #9). A client speaks
// JSON messages over a single WebSocket: it starts/resumes/attaches to any
// number of sessions and the server fans their normalized AgentEvents back,
// tagged by session id. The handler is socket-agnostic — index.ts binds it to
// @hono/node-ws, tests bind it to an array.

import type { PermissionDecision, PermissionMode } from '../adapters/index.js'
import type { SessionRegistry, StartSessionOptions } from './registry.js'

export type ClientMessage =
  | ({ type: 'start_session' } & StartSessionOptions)
  | { type: 'resume_session'; sessionId: string; prompt: string }
  | { type: 'attach'; sessionId: string }
  | { type: 'detach'; sessionId: string }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'permission'; sessionId: string; id: string; decision: PermissionDecision }
  | { type: 'set_permission_mode'; sessionId: string; mode: PermissionMode }
  | {
      type: 'answer_question'
      sessionId: string
      callId: string
      questions: unknown[]
      answers: Record<string, string | string[]>
    }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'kill'; sessionId: string }
  | { type: 'detach_effort'; sessionId: string }

export type ServerMessage =
  | { type: 'session'; meta: unknown }
  | { type: 'event'; sessionId: string; event: unknown }
  | { type: 'error'; message: string }

export interface Connection {
  onMessage(data: string): Promise<void>
  /** Detach every subscription this connection holds. */
  close(): void
}

/**
 * Derive an effort's current pipeline stage from its artifact snapshot (#105 /
 * ADR-0002). Backed by `stageService.snapshot(effort).stage`; the connection
 * awaits it at `start_session` so the client never supplies a stage.
 */
export type DeriveStage = (effort: string) => Promise<string | undefined>

export function createConnection(
  registry: SessionRegistry,
  send: (msg: ServerMessage) => void,
  deriveStage?: DeriveStage,
): Connection {
  const detachers = new Map<string, () => void>()

  const attach = (sessionId: string) => {
    detachers.get(sessionId)?.()
    detachers.set(
      sessionId,
      registry.subscribe(sessionId, (event) => send({ type: 'event', sessionId, event })),
    )
  }

  return {
    async onMessage(data) {
      let msg: ClientMessage
      try {
        msg = JSON.parse(data) as ClientMessage
      } catch {
        return send({ type: 'error', message: 'malformed message: not JSON' })
      }
      try {
        switch (msg.type) {
          case 'start_session': {
            const { type: _, ...opts } = msg
            // ADR-0002: the client never sets a pipeline stage. When the session
            // is bound to an effort, the server derives the stage from that
            // effort's artifact snapshot (an empty map derives to `planning`).
            // An effort-less (ad-hoc) session stays stage-less. A derivation
            // failure — e.g. tracker offline — is non-fatal: the session runs
            // stage-agnostic rather than refusing to start.
            if (deriveStage && opts.effort && opts.stage === undefined) {
              try {
                opts.stage = await deriveStage(opts.effort)
              } catch {
                // snapshot unavailable — leave the session stage-agnostic
              }
            }
            const meta = registry.start(opts)
            send({ type: 'session', meta })
            attach(meta.id)
            break
          }
          case 'resume_session': {
            const meta = await registry.resume(msg.sessionId, msg.prompt)
            send({ type: 'session', meta })
            attach(meta.id)
            break
          }
          case 'attach':
            attach(msg.sessionId)
            break
          case 'detach':
            detachers.get(msg.sessionId)?.()
            detachers.delete(msg.sessionId)
            break
          case 'send':
            registry.send(msg.sessionId, { text: msg.text })
            break
          case 'permission':
            registry.respondPermission(msg.sessionId, msg.id, msg.decision)
            break
          case 'set_permission_mode':
            await registry.setPermissionMode(msg.sessionId, msg.mode)
            break
          case 'answer_question':
            registry.answerQuestion(msg.sessionId, msg.callId, msg.questions, msg.answers)
            break
          case 'interrupt':
            registry.interrupt(msg.sessionId)
            break
          case 'kill':
            registry.kill(msg.sessionId)
            break
          case 'detach_effort':
            // Move-to-ad-hoc (#102): the registry refuses a running session
            // (its in-memory meta would overwrite the edit); the error surfaces
            // to the client, which only offers the action on ended sessions.
            await registry.detachEffort(msg.sessionId)
            break
          default:
            send({ type: 'error', message: `unknown message type: ${(msg as { type: string }).type}` })
        }
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    close() {
      for (const detach of detachers.values()) detach()
      detachers.clear()
    },
  }
}
