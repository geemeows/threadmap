// Left pane of the locked IA (#8): efforts tree with per-effort sessions,
// plus the workspace-wide Needs-you section.

import { adhocSessions, effortSessions, needsYou, sessionLabel } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import type { SessionRowView } from '../lib/derive.js'
import { StatusDot } from './primitives.js'

export function EffortsTree() {
  const state = useStore()
  const queue = needsYou(state)
  const adhoc = adhocSessions(state)

  return (
    <div className="overflow-y-auto p-[16px_12px_24px]" style={{ borderRight: '1px solid var(--border)', background: 'var(--panel)' }}>
      <div className="brand">
        <span className="mark">✦</span> threadmap
        <span className="actions">
          <button title="new session" onClick={() => store.setNewSessionOpen(true)}>
            ＋
          </button>
        </span>
      </div>
      <div className="search">
        <span className="dimmer">⌕</span>
        <input placeholder="Search…" />
        <kbd>⌘</kbd>
        <kbd>K</kbd>
      </div>

      <div className="navsec">Efforts</div>
      {state.efforts.length === 0 && (
        <div className="dimmer px-[10px] py-1 text-[12.5px]">
          No efforts yet — a <span className="mono">wayfinder:map</span> issue in a workspace repo becomes one.
        </div>
      )}
      {state.efforts.map((effort) => {
        const active = state.selectedEffort === effort.ref.id
        return (
          <div key={effort.ref.id}>
            <button className={`titem ${active ? 'active' : ''}`} onClick={() => store.selectEffort(effort.ref.id)}>
              <span className="dimmer">{active ? '▾' : '▸'}</span>
              <span className="min-w-0 flex-1 truncate">{effort.title}</span>
            </button>
            {active && (
              <>
                <div className="titem indent2 mono dimmer" style={{ cursor: 'default' }}>
                  {effort.ref.display}
                </div>
                {effortSessions(state, effort.ref.id).map((row) => (
                  <SessionItem key={row.view.meta.id} row={row} active={state.selectedSession === row.view.meta.id} />
                ))}
              </>
            )}
          </div>
        )
      })}

      {adhoc.length > 0 && (
        <>
          <div className="navsec">Ad-hoc sessions</div>
          {adhoc.map((row) => (
            <SessionItem key={row.view.meta.id} row={row} active={state.selectedSession === row.view.meta.id} />
          ))}
        </>
      )}

      <div className="navsec">Needs you</div>
      {queue.length === 0 && <div className="dimmer px-[10px] text-[12.5px]">Nothing waiting on you.</div>}
      {queue.map((row) => (
        <SessionItem key={row.view.meta.id} row={row} active={false} />
      ))}
    </div>
  )
}

function SessionItem({ row, active }: { row: SessionRowView; active: boolean }) {
  return (
    <button className={`titem indent2 ${active ? 'active' : ''}`} onClick={() => store.selectSession(row.view.meta.id)}>
      <StatusDot status={row.status} />
      <span className="min-w-0 flex-1 truncate">{sessionLabel(row.view)}</span>
    </button>
  )
}
