// Middle pane of the locked IA (#8): the effort's pipeline rail — six stages
// with gates — plus the detail card for the selected stage. Gate data comes
// from the gating engine's StageSnapshot served by /api/stage (#21); the
// detail card drives the implement stage over /api/pipeline (#30/#37):
// per-ticket implement/reconcile sessions, the landing flow, and completion.

import { useCallback, useEffect, useState } from 'react'
import { effortCost, effortSessions } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import type { LandResult, StageSnapshot, TicketView } from '../lib/types.js'
import { RAIL_STAGES } from '../lib/types.js'
import { Pill } from './primitives.js'

const STAGE_POLL_MS = 15_000

function useStageSnapshot(effortId: string | null): { snapshot: StageSnapshot | null; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<StageSnapshot | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    if (!effortId) {
      setSnapshot(null)
      return
    }
    let alive = true
    const pull = () =>
      fetch(`/api/stage?effort=${encodeURIComponent(effortId)}`)
        .then((res) => (res.ok ? (res.json() as Promise<StageSnapshot>) : null))
        .then((snap) => {
          if (alive && snap) {
            setSnapshot(snap)
            // Advisory verdicts (#41): open request-changes PRs ride the Needs-you inbox.
            store.syncVerdictNotices(effortId!, snap.tickets)
          }
        })
        .catch(() => {})
    void pull()
    const timer = setInterval(pull, STAGE_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [effortId, tick])
  // Stale snapshot from the previous effort must not flash — drop it on switch.
  useEffect(() => setSnapshot(null), [effortId])
  return { snapshot, refresh }
}

export function PipelineRail() {
  const state = useStore()
  const effort = state.efforts.find((e) => e.ref.id === state.selectedEffort) ?? null
  const { snapshot, refresh } = useStageSnapshot(effort?.ref.id ?? null)

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
          <p className="dimmer mt-2 text-[12px]">Deriving gate state from the tracker…</p>
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
        {snapshot?.readyToComplete && effort.state !== 'closed' && (
          <CompleteEffort effortId={effort.ref.id} onDone={refresh} />
        )}
      </div>

      <StageDetail
        effortId={effort.ref.id}
        stageIdx={stageIdx}
        currentIdx={currentIdx}
        snapshot={snapshot}
        sessionCount={sessions.length}
        refresh={refresh}
      />
    </div>
  )
}

function StageDetail({
  effortId,
  stageIdx,
  currentIdx,
  snapshot,
  sessionCount,
  refresh,
}: {
  effortId: string
  stageIdx: number
  currentIdx: number
  snapshot: StageSnapshot | null
  sessionCount: number
  refresh: () => void
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
              : 'Gate state pending — deriving from the tracker.'}
        </p>
        <p className="dimmer mt-1.5 text-[12px]">
          {sessionCount} session{sessionCount === 1 ? '' : 's'} on this effort — docked on the right.
        </p>
        {gate && (
          <OverrideGate
            effortId={effortId}
            stage={gate.stage}
            met={gate.met}
            overridden={gate.overridden}
            onDone={refresh}
          />
        )}
        {(rail.key === 'implement' || rail.key === 'code-review') && snapshot && (
          <TicketList
            effortId={effortId}
            tickets={snapshot.tickets}
            reviewable={rail.key === 'code-review'}
            refresh={refresh}
          />
        )}
        {rail.key === 'code-review' && snapshot && (gate?.met || gate?.overridden) && (
          <LandEffort effortId={effortId} onDone={refresh} />
        )}
      </div>
    </div>
  )
}

/**
 * Gate override (#6/#40): per-stage "I know what I'm doing" with a required
 * reason — POSTs /api/pipeline/override, which writes the audit comment then
 * the stamp. An overridden gate offers revoke instead.
 */
function OverrideGate({
  effortId,
  stage,
  met,
  overridden,
  onDone,
}: {
  effortId: string
  stage: string
  met: boolean
  overridden: boolean
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true)
    const error = await action()
    setBusy(false)
    if (error) store.setError(error)
    else {
      setOpen(false)
      setReason('')
      onDone()
    }
  }

  if (overridden) {
    return (
      <div className="mt-3 flex items-center gap-2.5" style={{ borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
        <span className="dim text-[12.5px]">Override stamp on the map issue — audit comment holds who/why.</span>
        <span className="flex-1" />
        <button className="btn sm" disabled={busy} onClick={() => void run(() => store.revokeOverride(effortId, stage))}>
          {busy ? 'Revoking…' : 'Revoke override'}
        </button>
      </div>
    )
  }
  if (met) return null
  return (
    <div className="mt-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
      {!open ? (
        <div className="flex items-center gap-2.5">
          <span className="dim text-[12.5px]">Gate not met — hard gates only unlock on their exit condition.</span>
          <span className="flex-1" />
          <button className="btn sm" onClick={() => setOpen(true)}>
            ⚠ Override gate…
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="dim text-[12.5px]">
            Overriding records an audit comment and stamps the map issue — a reason is required.
          </span>
          <div className="field" style={{ marginBottom: 0 }}>
            <textarea
              rows={2}
              placeholder="Why is it safe to pass this gate anyway?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1" />
            <button className="btn sm" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn danger sm"
              disabled={busy || !reason.trim()}
              onClick={() => void run(() => store.applyOverride(effortId, stage, reason))}
            >
              {busy ? 'Overriding…' : 'I know what I’m doing — override'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Per-ticket rows with the per-stage actions (#37/#52): start a session,
 * reconcile a conflicted PR, and — on the code-review rows only — launch a
 * review session against the ticket's open PR.
 */
function TicketList({
  effortId,
  tickets,
  reviewable,
  refresh,
}: {
  effortId: string
  tickets: TicketView[]
  reviewable: boolean
  refresh: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key)
    const error = await action()
    setBusy(null)
    if (error) store.setError(error)
    else refresh()
  }

  if (tickets.length === 0) {
    return <p className="dimmer mt-3 text-[12px]">No tickets on this effort yet — to-tickets creates them.</p>
  }
  return (
    <div className="mt-3 flex flex-col gap-1.5" style={{ borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
      {tickets.map((t) => {
        const id = t.ref.id
        return (
          <div key={id} className="flex items-center gap-2 text-[12.5px]">
            <span className="mono truncate">{t.ref.display}</span>
            {t.closed && <Pill>closed</Pill>}
            {t.pr ? (
              <a href={t.pr.url} target="_blank" rel="noreferrer" className={`pill ${t.pr.state === 'merged' ? 'mint' : t.pr.state === 'open' ? 'blue' : ''}`} style={{ textDecoration: 'none' }}>
                PR {t.pr.state}
              </a>
            ) : (
              <Pill>no PR</Pill>
            )}
            {t.pr?.agentVerdict && (
              <Pill tone={t.pr.agentVerdict === 'approve' ? 'mint' : 'amber'}>
                {t.pr.agentVerdict === 'approve' ? 'agent: approve' : 'agent: changes requested'}
              </Pill>
            )}
            {t.pr?.conflicting && <Pill tone="red">conflicts with trunk</Pill>}
            <span className="flex-1" />
            {t.pr?.conflicting && (
              <button
                className="btn danger sm"
                disabled={busy !== null}
                onClick={() => void run(`reconcile:${id}`, () => store.startReconcile(effortId, id))}
              >
                {busy === `reconcile:${id}` ? 'Starting…' : '⚡ Reconcile'}
              </button>
            )}
            {reviewable && t.pr?.state === 'open' && (
              <button
                className="btn sm"
                disabled={busy !== null}
                onClick={() => void run(`review:${id}`, () => store.startReview(effortId, id))}
              >
                {busy === `review:${id}` ? 'Starting…' : t.pr.agentVerdict ? '🔍 Review again' : '🔍 Review'}
              </button>
            )}
            {t.pr?.state !== 'merged' && (
              <button
                className="btn sm"
                disabled={busy !== null}
                onClick={() => void run(`implement:${id}`, () => store.startImplement(effortId, id))}
              >
                {busy === `implement:${id}` ? 'Starting…' : t.pr ? '▶ Implement again' : '▶ Implement'}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Landing flow (#11): one button per effort, per-repo results — PR link, sync session, or in-progress. */
function LandEffort({ effortId, onDone }: { effortId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<LandResult[] | null>(null)

  const land = async () => {
    setBusy(true)
    const res = await store.landEffort(effortId)
    setBusy(false)
    if (res.error) store.setError(res.error)
    else {
      setResults(res.results ?? [])
      onDone()
    }
  }

  return (
    <div className="mt-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
      <div className="flex items-center gap-2.5">
        <span className="dim text-[13px]">All ticket PRs are in — land the effort trunk on main.</span>
        <span className="flex-1" />
        <button className="btn primary sm" disabled={busy} onClick={() => void land()}>
          {busy ? 'Landing…' : '⤓ Land effort'}
        </button>
      </div>
      {results && results.length === 0 && (
        <p className="dimmer mt-2 text-[12px]">No repo grew an effort trunk — nothing to land.</p>
      )}
      {results?.map((r) => (
        <div key={r.repo} className="mt-1.5 flex items-center gap-2 text-[12.5px]">
          <span className="mono">{r.repo}</span>
          {r.status === 'pr_opened' || r.status === 'pr_exists' ? (
            <a href={r.prUrl} target="_blank" rel="noreferrer" className="pill mint" style={{ textDecoration: 'none' }}>
              {r.status === 'pr_opened' ? 'landing PR opened' : 'landing PR already open'} ↗
            </a>
          ) : r.status === 'sync_session_started' ? (
            <button className="pill amber" onClick={() => r.session && store.selectSession(r.session.id)}>
              main→trunk conflicts — sync session started, open chat
            </button>
          ) : (
            <Pill tone="amber">sync session still running</Pill>
          )}
        </div>
      ))}
    </div>
  )
}

/** Post-landing sweep (#11): remove worktrees + trunks; a clean sweep closes the map issue (#6). */
function CompleteEffort({ effortId, onDone }: { effortId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [kept, setKept] = useState<number | null>(null)
  const [mapClosed, setMapClosed] = useState(false)

  const complete = async () => {
    setBusy(true)
    const res = await store.completeEffort(effortId)
    setBusy(false)
    if (res.error) store.setError(res.error)
    else {
      const keptCount = (res.results ?? []).reduce((n, r) => n + r.keptWorktrees.length, 0)
      setKept(keptCount)
      setMapClosed(res.mapClosed ?? false)
      if (keptCount > 0) store.setInboxOpen(true)
      onDone()
    }
  }

  return (
    <div className="mt-3 flex items-center gap-2.5">
      <Pill tone="mint">All gates pass.</Pill>
      <span className="dim text-[12.5px]">Sweeps worktrees and trunks, then closes the map issue.</span>
      <span className="flex-1" />
      <button className="btn primary sm" disabled={busy} onClick={() => void complete()}>
        {busy ? 'Completing…' : '✓ Complete effort'}
      </button>
      {mapClosed && <Pill tone="mint">map issue closed</Pill>}
      {kept !== null && kept > 0 && (
        <Pill tone="amber">{kept} dirty worktree{kept === 1 ? '' : 's'} kept — map left open</Pill>
      )}
    </div>
  )
}
