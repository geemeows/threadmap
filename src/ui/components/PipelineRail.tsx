// Middle pane of the locked IA (#8): the effort's pipeline rail — six stages
// with gates — plus the detail card for the selected stage. Gate data comes
// from the gating engine's StageSnapshot; until the TrackerAdapter (#21)
// wires derivation into the server, the rail renders the readiness skeleton
// and says so instead of faking gate state.

import { useEffect, useState } from 'react'
import { effortCost, effortSessions } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import type { StageSnapshot } from '../lib/types.js'
import { RAIL_STAGES } from '../lib/types.js'
import { Pill } from './primitives.js'

function useStageSnapshot(effortId: string | null): StageSnapshot | null {
  const [snapshot, setSnapshot] = useState<StageSnapshot | null>(null)
  useEffect(() => {
    setSnapshot(null)
    if (!effortId) return
    let alive = true
    void fetch(`/api/stage?effort=${encodeURIComponent(effortId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<StageSnapshot>) : null))
      .then((snap) => {
        if (alive && snap) setSnapshot(snap)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [effortId])
  return snapshot
}

export function PipelineRail() {
  const state = useStore()
  const effort = state.efforts.find((e) => e.ref.id === state.selectedEffort) ?? null
  const snapshot = useStageSnapshot(effort?.ref.id ?? null)

  if (!effort) {
    return (
      <div className="flex min-w-0 flex-col items-center justify-center overflow-y-auto" style={{ borderRight: '1px solid var(--border)' }}>
        <div className="dim p-6 text-center text-[13px]">
          Select an effort — or start one by charting a wayfinder map in a workspace repo.
        </div>
      </div>
    )
  }

  // Rail index 0 is Setup (repo readiness, #6); gating stages shift by one.
  const currentIdx = snapshot ? RAIL_STAGES.findIndex((s) => s.key === snapshot.stage) : -1
  const stageIdx = state.selectedStageIdx ?? (currentIdx >= 0 ? currentIdx : 1)
  const cost = effortCost(state, effort.ref.id)
  const sessions = effortSessions(state, effort.ref.id)

  return (
    <div className="flex min-w-0 flex-col overflow-y-auto pb-6" style={{ borderRight: '1px solid var(--border)' }}>
      <div className="p-[18px_20px_8px]">
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <h2 className="text-[16px]">{effort.title}</h2>
          <Pill>
            <a className="mono" href={effort.ref.url} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
              {effort.ref.display}
            </a>
          </Pill>
          {effort.state === 'closed' && <Pill>Completed</Pill>}
          <span className="flex-1" />
          {cost > 0 && (
            <Pill>
              <span className="mono">${cost.toFixed(2)}</span>
            </Pill>
          )}
        </div>
        <div className="railcard">
          {RAIL_STAGES.map((rail, i) => {
            const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : ''
            const gate = snapshot?.gates.find((g) => g.stage === rail.key)
            return (
              <button key={rail.key} className={`vstage ${cls} ${i === stageIdx ? 'selected' : ''}`} onClick={() => store.selectStage(i)}>
                <div className="vbubble">{i < currentIdx ? '✓' : i === currentIdx ? '' : snapshot ? '🔒' : '·'}</div>
                <div className="min-w-0 flex-1">
                  <div className="vslabel">
                    {i === currentIdx && <span className="spinner mr-1" />}
                    {rail.label}
                    {gate?.overridden && ' — overridden'}
                  </div>
                  {i === currentIdx && gate && gate.unmet.length > 0 && (
                    <div className="dim mt-0.5 text-[12px]">{gate.unmet.join(' · ')}</div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
        {!snapshot && (
          <p className="dimmer mt-2 text-[12px]">
            Gate state pending — stage derivation wires in with the TrackerAdapter (#21).
          </p>
        )}
        {snapshot && snapshot.warnings.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {snapshot.warnings.map((w) => (
              <Pill key={w} tone="amber">
                ⚑ {w}
              </Pill>
            ))}
          </div>
        )}
        {snapshot?.readyToComplete && (
          <div className="mt-3">
            <Pill tone="mint">All gates pass — close the map issue to complete the effort.</Pill>
          </div>
        )}
      </div>

      <StageDetail stageIdx={stageIdx} currentIdx={currentIdx} snapshot={snapshot} sessionCount={sessions.length} />
    </div>
  )
}

function StageDetail({
  stageIdx,
  currentIdx,
  snapshot,
  sessionCount,
}: {
  stageIdx: number
  currentIdx: number
  snapshot: StageSnapshot | null
  sessionCount: number
}) {
  const rail = RAIL_STAGES[stageIdx]!
  const gate = snapshot?.gates.find((g) => g.stage === rail.key)
  const statusPill = !snapshot ? (
    <Pill>unknown</Pill>
  ) : stageIdx < currentIdx ? (
    <Pill tone="mint">Done</Pill>
  ) : stageIdx === currentIdx ? (
    <Pill tone="blue">In Progress</Pill>
  ) : (
    <Pill>🔒 Locked</Pill>
  )

  return (
    <div className="p-[8px_20px_20px]">
      <div className="card p-[14px_16px]">
        <div className="flex items-center gap-2.5">
          <b>{rail.label}</b>
          {statusPill}
          <span className="flex-1" />
          <button className="btn primary sm" onClick={() => store.setNewSessionOpen(true)}>
            ▶ Start session
          </button>
        </div>
        <p className="dim mt-2 text-[13px]">
          {rail.key === 'setup'
            ? 'Repo readiness — skills installed, docs generated, tracker connected. Managed by the onboarding wizard (#22).'
            : gate
              ? gate.met
                ? 'Exit condition met — artifacts recorded on the tracker.'
                : gate.overridden
                  ? 'Gate overridden — an override stamp with audit comment is on the map issue.'
                  : gate.unmet.join(' · ')
              : 'Gate state unknown until stage derivation is wired (#21).'}
        </p>
        <p className="dimmer mt-1.5 text-[12px]">
          {sessionCount} session{sessionCount === 1 ? '' : 's'} on this effort — docked on the right.
        </p>
      </div>
    </div>
  )
}
