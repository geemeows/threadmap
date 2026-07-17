// Right pane of the locked IA (#8): docked, tabbed session chat. Approvals
// render inline in the transcript — the canonical surface; the global inbox
// links back here.

import { useEffect, useRef, useState } from 'react'
import { effortSessions, adhocSessions, sessionLabel, statusOf } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import type { SessionView } from '../lib/store.js'
import { reduceTranscript, summarizeInput } from '../lib/transcript.js'
import type { ChatItem } from '../lib/transcript.js'
import { CostBadge, StatusDot, StatusPill } from './primitives.js'

export function SessionPane() {
  const state = useStore()
  const rows = state.selectedEffort ? effortSessions(state, state.selectedEffort) : adhocSessions(state)
  const selected =
    (state.selectedSession && state.sessions[state.selectedSession]) ||
    rows[rows.length - 1]?.view ||
    null

  return (
    <div className="flex min-h-0 min-w-0 flex-col" style={{ background: 'var(--panel)' }}>
      <div className="vc-tabs">
        {rows.length === 0 && <div className="vc-tab dimmer">no sessions</div>}
        {rows.map(({ view, status }) => (
          <button
            key={view.meta.id}
            className={`vc-tab ${selected?.meta.id === view.meta.id ? 'active' : ''}`}
            onClick={() => store.selectSession(view.meta.id)}
          >
            <StatusDot status={status} />
            {sessionLabel(view)}
          </button>
        ))}
      </div>
      {selected ? (
        <Chat view={selected} />
      ) : (
        <div className="dim p-6">Start a session to see it here.</div>
      )}
    </div>
  )
}

function Chat({ view }: { view: SessionView }) {
  const { meta } = view
  const status = statusOf(view)
  const items = reduceTranscript(meta, view.events)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  })

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="pill mono" title={meta.cwd}>
          {meta.cwd.split('/').filter(Boolean).pop()}
        </span>
        {meta.stage && <span className="pill">{meta.stage}</span>}
        <StatusPill status={status} />
        <span className="flex-1" />
        <CostBadge usage={meta.usage} />
        {meta.status === 'running' && (
          <>
            <button className="btn sm" onClick={() => store.interrupt(meta.id)} title="interrupt the agent">
              ⏸
            </button>
            <button className="btn sm danger" onClick={() => store.kill(meta.id)} title="kill the session">
              ✕
            </button>
          </>
        )}
      </div>
      <div
        ref={scrollRef}
        className="chat-scroll"
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {items.map((item, i) => (
          <ChatMessage key={i} item={item} sessionId={meta.id} />
        ))}
      </div>
      <Composer view={view} />
    </div>
  )
}

function ChatMessage({ item, sessionId }: { item: ChatItem; sessionId: string }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>
    case 'agent':
      return (
        <div className="msg agent">
          <span className="mark">✦</span>
          <span>
            {item.text}
            {item.streaming && <span className="spinner ml-1.5 align-middle" />}
          </span>
        </div>
      )
    case 'tool':
      return <div className={`msg tool ${item.error ? 'error' : ''}`}>{item.text}</div>
    case 'system':
      return <div className="msg system">— {item.text} —</div>
    case 'approval':
      return <ApprovalCard item={item} sessionId={sessionId} />
  }
}

function ApprovalCard({
  item,
  sessionId,
}: {
  item: Extract<ChatItem, { kind: 'approval' }>
  sessionId: string
}) {
  return (
    <div className="approval-card">
      <div className="flex items-center gap-2">
        <span className={`dot ${item.resolved ? 'done' : 'approval'}`} />
        <b>Permission request — {item.tool}</b>
        {item.resolved && <span className="pill">{item.resolved === 'allow' ? 'allowed' : 'denied'}</span>}
      </div>
      <div className="cmd">{summarizeInput(item.input) || JSON.stringify(item.input, null, 2)}</div>
      {!item.resolved && (
        <div className="mt-2 flex gap-2">
          <button
            className="btn primary sm"
            onClick={() => store.respondPermission(sessionId, item.id, { behavior: 'allow' })}
          >
            Allow
          </button>
          <button
            className="btn danger sm"
            onClick={() => store.respondPermission(sessionId, item.id, { behavior: 'deny', message: 'denied from threadmap UI' })}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  )
}

function Composer({ view }: { view: SessionView }) {
  const [text, setText] = useState('')
  const { meta } = view
  const ended = meta.status === 'ended'
  const resumable = ended && !!meta.resumeToken

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (ended) {
      if (!resumable) return
      store.resumeSession(meta.id, trimmed)
    } else {
      store.sendMessage(meta.id, trimmed)
    }
    setText('')
  }

  return (
    <div className="composer">
      <div className="hints">
        <span className="hint">
          <kbd>⏎</kbd> to send
        </span>
        <span className="hint">
          <kbd>⇧⏎</kbd> new line
        </span>
        <span className="hint">
          <span className="slash">/</span> grilling
        </span>
        <span className="hint">
          <span className="slash">/</span> code-review
        </span>
      </div>
      <div className="composer-box">
        <textarea
          rows={2}
          value={text}
          placeholder={
            ended
              ? resumable
                ? 'Session ended — sending resumes it…'
                : 'Session ended and is not resumable.'
              : 'Message the agent…'
          }
          disabled={ended && !resumable}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex items-center gap-1.5">
          <span className="flex-1" />
          <button className="btn primary sm" onClick={submit} disabled={ended && !resumable}>
            {ended && resumable ? 'Resume ↵' : 'Send ↵'}
          </button>
        </div>
      </div>
    </div>
  )
}
