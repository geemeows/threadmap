// Global approvals inbox (#8): every session blocked on the human, one list.
// Inline-in-chat stays canonical — rows jump to the session's chat.

import { needsYou, sessionLabel } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import { pendingApprovals } from '../lib/transcript.js'
import { CostBadge, StatusDot, StatusPill } from './primitives.js'

export function Inbox() {
  const state = useStore()
  if (!state.inboxOpen) return null
  const queue = needsYou(state)
  const waiting = queue.length + state.notices.length

  return (
    <div
      className="overlay-bg"
      onClick={(e) => {
        if (e.target === e.currentTarget) store.setInboxOpen(false)
      }}
    >
      <div className="overlay-panel">
        <div className="flex items-center gap-2.5 p-[14px_18px]" style={{ borderBottom: '1px solid var(--border)' }}>
          <b>Needs you</b>
          <span className="dimmer text-[12px]">
            {waiting} item{waiting === 1 ? '' : 's'} waiting
          </span>
          <span className="flex-1" />
          <button className="btn sm" onClick={() => store.setInboxOpen(false)}>
            ✕
          </button>
        </div>
        {waiting === 0 && <div className="dim p-5">Nothing waiting on you.</div>}
        {state.notices.map((n) => (
          <div key={n.id} className="session-row" style={{ cursor: 'default' }}>
            <span className="dot approval" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">Dirty worktree kept — {n.repo}</div>
              <div className="dimmer mono truncate">
                {n.effort} · {n.text}
              </div>
            </div>
            <button className="btn sm" onClick={() => store.dismissNotice(n.id)}>
              dismiss
            </button>
          </div>
        ))}
        {queue.map(({ view, status }) => {
          const approvals = pendingApprovals(view.events)
          return (
            <button key={view.meta.id} className="session-row" onClick={() => store.selectSession(view.meta.id)}>
              <StatusDot status={status} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{sessionLabel(view)}</div>
                <div className="dimmer mono truncate">
                  {view.meta.effort ?? view.meta.cwd}
                  {approvals.length > 0 && ` · ${approvals.map((a) => a.tool).join(', ')} pending`}
                </div>
              </div>
              <StatusPill status={status} />
              <CostBadge usage={view.meta.usage} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
