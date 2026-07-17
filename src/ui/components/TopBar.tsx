import { needsYou, sessionLabel, workspaceCost } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import { Pill, StatusDot } from './primitives.js'
import { STATUS_META } from '../lib/types.js'

export function TopBar() {
  const state = useStore()
  const queue = needsYou(state)
  const total = workspaceCost(state)
  const workspaceName = state.workspace ? state.workspace.root.split('/').filter(Boolean).pop() : '…'

  return (
    <div className="topbar">
      <span className="crumb">
        <span className="mark">✦</span> {workspaceName}
      </span>
      {state.conn !== 'open' && <Pill tone="amber">{state.conn === 'connecting' ? 'connecting…' : 'reconnecting…'}</Pill>}
      <span className="flex-1" />
      {queue.slice(0, 3).map(({ view, status }) => (
        <button
          key={view.meta.id}
          className={`pill ${STATUS_META[status].pill}`}
          onClick={() => store.selectSession(view.meta.id)}
        >
          <StatusDot status={status} />
          {sessionLabel(view)}
        </button>
      ))}
      {queue.length + state.notices.length > 0 && (
        <button className="pill amber" onClick={() => store.setInboxOpen(true)}>
          ⚑ {queue.length + state.notices.length} needs you
        </button>
      )}
      {total > 0 && (
        <Pill>
          <span className="mono">Σ ${total.toFixed(2)}</span>
        </Pill>
      )}
      <button
        className={`pill ${state.setup && !state.setup.ready ? 'amber' : ''}`}
        onClick={() => store.setSetupOpen(true)}
        title="workspace readiness"
      >
        ⚙ setup
      </button>
      <button className="pill" onClick={() => store.toggleTheme()} title="toggle theme">
        {state.theme === 'dark' ? '☀︎' : '☾'}
      </button>
      <Pill tone="solid-mint">threadmap dev</Pill>
    </div>
  )
}
