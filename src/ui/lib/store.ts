// One client-side store: REST snapshots + the single WS channel (#9), bound
// to React via useSyncExternalStore. Live sessions are attached eagerly so
// the Needs-you queue sees approvals in sessions no pane is looking at.

import { useSyncExternalStore } from 'react'
import type {
  ClientMessage,
  CompleteResult,
  EffortSummary,
  LandResult,
  PermissionDecision,
  PermissionMode,
  ServerMessage,
  SessionMeta,
  SetupStatus,
  StartSessionOptions,
  TicketView,
  TranscriptEvent,
  Workspace,
  WorkspaceConfig,
} from './types.js'

export interface SessionView {
  meta: SessionMeta
  events: TranscriptEvent[]
  /** Ended sessions lazy-load their transcript from REST on first open. */
  transcriptLoaded: boolean
}

/** A pipeline outcome that needs the human (kept-dirty worktree, agent request-changes verdict) — rides the Needs-you queue. */
export interface PipelineNotice {
  id: string
  effort: string
  repo: string
  title: string
  text: string
}

export interface State {
  conn: 'connecting' | 'open' | 'closed'
  /** False until the first REST snapshot lands — panes show skeletons, not a false-empty. */
  loaded: boolean
  theme: 'dark' | 'light'
  workspace: Workspace | null
  efforts: EffortSummary[]
  sessions: Record<string, SessionView>
  selectedEffort: string | null
  selectedSession: string | null
  /** Rail stage the user is inspecting; null = the effort's current stage. */
  selectedStageIdx: number | null
  inboxOpen: boolean
  /** New-effort modal (#106): mints a wayfinder:map, distinct from the
   *  per-effort session modal. */
  newEffortOpen: boolean
  newSessionOpen: boolean
  /** Effort the New-session modal binds to, set by whoever opened it; null = an
   *  effort-less (ad-hoc) session. Never read from `selectedEffort` — the
   *  binding follows what was clicked, not the current selection (ADR-0002). */
  newSessionEffort: string | null
  /** ⌘K command palette (search over efforts + sessions). */
  paletteOpen: boolean
  setup: SetupStatus | null
  /** Readiness panel visibility (always dismissable — first-run lives in the wizard). */
  setupOpen: boolean
  /** Full-screen onboarding wizard takeover (#82); forced on while not ready. */
  onboarding: boolean
  notices: PipelineNotice[]
  error: string | null
}

type Listener = () => void

export class Store {
  private state: State = {
    conn: 'connecting',
    loaded: false,
    theme: (storedTheme() as 'dark' | 'light') ?? 'dark',
    workspace: null,
    efforts: [],
    sessions: {},
    selectedEffort: null,
    selectedSession: null,
    selectedStageIdx: null,
    inboxOpen: false,
    newEffortOpen: false,
    newSessionOpen: false,
    newSessionEffort: null,
    paletteOpen: false,
    setup: null,
    setupOpen: false,
    onboarding: false,
    notices: [],
    error: null,
  }
  private listeners = new Set<Listener>()
  private ws: WebSocket | null = null
  private attached = new Set<string>()
  /** Set once the user explicitly leaves the wizard (enter workspace, agent
   *  escalation) so later refreshes don't force the takeover back open. */
  private onboardingDismissed = false

  getState = (): State => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /* ---------- bootstrap ---------- */

  async init() {
    this.connect()
    const [workspace, efforts, sessions] = await Promise.all([
      fetchJson<Workspace>('/api/workspace'),
      fetchJson<EffortSummary[]>('/api/efforts'),
      fetchJson<SessionMeta[]>('/api/sessions'),
    ])
    const views: Record<string, SessionView> = { ...this.state.sessions }
    for (const meta of sessions ?? []) {
      views[meta.id] ??= { meta, events: [], transcriptLoaded: false }
    }
    this.set({
      loaded: true,
      workspace: workspace ?? null,
      efforts: efforts ?? [],
      sessions: views,
      selectedEffort: this.state.selectedEffort ?? efforts?.[0]?.ref.id ?? null,
    })
    for (const meta of sessions ?? []) {
      if (meta.status === 'running') this.attach(meta.id)
    }
    await this.refreshSetup()
  }

  /** Pull the readiness snapshot; an unready workspace enters the wizard (#7 §10, #82). */
  async refreshSetup() {
    const setup = await fetchJson<SetupStatus>('/api/setup/status')
    if (!setup) return
    this.set({
      setup,
      onboarding: this.state.onboarding || (!setup.ready && !this.onboardingDismissed),
    })
  }

  /**
   * Persist a config patch. Hot wizard interactions (repo toggles, tracker
   * pick) pass `refresh: false` and keep their own optimistic state — the full
   * status recompute (gh auth + fs stats) runs on step navigation instead (#82).
   */
  async saveSetupConfig(
    patch: Partial<WorkspaceConfig>,
    opts: { refresh?: boolean } = {},
  ): Promise<string | null> {
    const res = await mutateJson('/api/setup/config', 'PUT', patch)
    if (res.error) return res.error
    if (opts.refresh ?? true) await this.refreshSetup()
    return null
  }

  setSetupOpen(open: boolean) {
    this.set({ setupOpen: open })
  }

  /** Enter/leave the full-screen onboarding wizard; leaving sticks until re-entered. */
  setOnboarding(active: boolean) {
    this.onboardingDismissed = !active
    this.set({ onboarding: active, ...(active ? { setupOpen: false } : {}) })
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.set({ conn: 'open' })
      for (const id of this.attached) this.sendWs({ type: 'attach', sessionId: id })
    }
    ws.onclose = () => {
      this.set({ conn: 'closed' })
      setTimeout(() => this.connect(), 1500)
    }
    ws.onmessage = (event) => this.onServerMessage(JSON.parse(String(event.data)) as ServerMessage)
  }

  private sendWs(msg: ClientMessage) {
    // Instance constant, not the global — node unit tests have no WebSocket.
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private onServerMessage(msg: ServerMessage) {
    if (msg.type === 'error') {
      this.set({ error: msg.message })
      return
    }
    if (msg.type === 'session') {
      const meta = msg.meta as SessionMeta
      this.upsertSession(meta)
      this.attached.add(meta.id)
      this.set({ selectedSession: meta.id, selectedEffort: meta.effort ?? this.state.selectedEffort })
      return
    }
    const view = this.state.sessions[msg.sessionId]
    if (!view) return
    const event = msg.event as TranscriptEvent
    const meta = { ...view.meta }
    if (event.type === 'usage_update') meta.usage = event.usage
    if (event.type === 'session_started') meta.resumeToken = event.resumeToken
    if (event.type === 'permission_mode') meta.permissionMode = event.mode
    if (event.type === 'session_ended') {
      meta.status = 'ended'
      meta.outcome = event.outcome
      if (event.usage) meta.usage = event.usage
      if (!event.resumable) meta.resumeToken = undefined
    }
    this.set({
      sessions: {
        ...this.state.sessions,
        [msg.sessionId]: { ...view, meta, events: [...view.events, event] },
      },
    })
  }

  private upsertSession(meta: SessionMeta) {
    const existing = this.state.sessions[meta.id]
    this.set({
      sessions: {
        ...this.state.sessions,
        [meta.id]: existing
          ? { ...existing, meta }
          : { meta, events: [], transcriptLoaded: true },
      },
    })
  }

  /* ---------- actions ---------- */

  attach(sessionId: string) {
    if (this.attached.has(sessionId)) return
    this.attached.add(sessionId)
    this.sendWs({ type: 'attach', sessionId })
  }

  /** Pull an ended session's persisted transcript once. */
  async loadTranscript(sessionId: string) {
    const view = this.state.sessions[sessionId]
    if (!view || view.transcriptLoaded) return
    this.set({
      sessions: { ...this.state.sessions, [sessionId]: { ...view, transcriptLoaded: true } },
    })
    const events = await fetchJson<TranscriptEvent[]>(`/api/sessions/${sessionId}/transcript`)
    const current = this.state.sessions[sessionId]
    if (!current || !events) return
    this.set({
      sessions: {
        ...this.state.sessions,
        // Live events may have streamed in while loading; persisted ones come first anyway.
        [sessionId]: { ...current, events: events.length >= current.events.length ? events : current.events },
      },
    })
  }

  startSession(opts: StartSessionOptions) {
    this.sendWs({ type: 'start_session', ...opts })
  }

  resumeSession(sessionId: string, prompt: string) {
    this.sendWs({ type: 'resume_session', sessionId, prompt })
  }

  sendMessage(sessionId: string, text: string) {
    this.sendWs({ type: 'send', sessionId, text })
  }

  respondPermission(sessionId: string, id: string, decision: PermissionDecision) {
    this.sendWs({ type: 'permission', sessionId, id, decision })
  }

  /** Change a session's permission mode (#91). Optimistically reflects it on the
   *  session's meta so the composer switch feels instant; the server echoes a
   *  `permission_mode` event that re-asserts the same value and persists it. */
  setPermissionMode(sessionId: string, mode: PermissionMode) {
    const view = this.state.sessions[sessionId]
    if (view) {
      this.set({
        sessions: {
          ...this.state.sessions,
          [sessionId]: { ...view, meta: { ...view.meta, permissionMode: mode } },
        },
      })
    }
    this.sendWs({ type: 'set_permission_mode', sessionId, mode })
  }

  /** Route an AskUserQuestion selection back to the agent as its tool_result. */
  answerQuestion(
    sessionId: string,
    callId: string,
    questions: unknown[],
    answers: Record<string, string | string[]>,
  ) {
    this.sendWs({ type: 'answer_question', sessionId, callId, questions, answers })
  }

  interrupt(sessionId: string) {
    this.sendWs({ type: 'interrupt', sessionId })
  }

  /** Move an ended session to ad-hoc (#102): detach its effort binding on the
   *  server and optimistically drop `effort` from the local meta so the row
   *  regroups into the Ad-hoc list immediately (ad-hoc is defined by the absence
   *  of `effort`). The registry refuses a running session, but the UI only
   *  offers this on ended ones. */
  detachEffort(sessionId: string) {
    const view = this.state.sessions[sessionId]
    if (view) {
      const { effort: _detached, ...meta } = view.meta
      this.set({
        sessions: { ...this.state.sessions, [sessionId]: { ...view, meta } },
      })
    }
    this.sendWs({ type: 'detach_effort', sessionId })
  }

  kill(sessionId: string) {
    this.sendWs({ type: 'kill', sessionId })
  }

  /* ---------- pipeline actions (#37) — REST-started sessions stream over the same WS ---------- */

  /** Register a session the server started via REST, attach its stream, optionally focus it. */
  adoptSession(meta: SessionMeta, opts: { select?: boolean } = {}) {
    this.upsertSession(meta)
    this.attach(meta.id)
    if (opts.select ?? true)
      this.set({ selectedSession: meta.id, selectedEffort: meta.effort ?? this.state.selectedEffort })
  }

  async startImplement(effort: string, ticket: string): Promise<string | null> {
    const res = await mutateJson<SessionMeta>('/api/pipeline/implement', 'POST', { effort, ticket })
    if (res.error) return res.error
    if (res.data) this.adoptSession(res.data)
    return null
  }

  async startReview(effort: string, ticket: string): Promise<string | null> {
    const res = await mutateJson<SessionMeta>('/api/pipeline/review', 'POST', { effort, ticket })
    if (res.error) return res.error
    if (res.data) this.adoptSession(res.data)
    return null
  }

  async startReconcile(effort: string, ticket: string): Promise<string | null> {
    const res = await mutateJson<SessionMeta>('/api/pipeline/reconcile', 'POST', { effort, ticket })
    if (res.error) return res.error
    if (res.data) this.adoptSession(res.data)
    return null
  }

  async landEffort(effort: string): Promise<{ results?: LandResult[]; error?: string }> {
    const res = await mutateJson<{ results: LandResult[] }>('/api/pipeline/land', 'POST', { effort })
    if (res.error) return { error: res.error }
    const results = res.data?.results ?? []
    // Conflicted repos got a sync session — attach it, but keep the rail in view.
    for (const r of results) if (r.session) this.adoptSession(r.session, { select: false })
    return { results }
  }

  async completeEffort(
    effort: string,
    force = false,
  ): Promise<{ results?: CompleteResult[]; mapClosed?: boolean; error?: string }> {
    const res = await mutateJson<{ results: CompleteResult[]; mapClosed: boolean }>(
      '/api/pipeline/complete', 'POST', { effort, force },
    )
    if (res.error) return { error: res.error }
    const results = res.data?.results ?? []
    const kept = results.flatMap((r) =>
      r.keptWorktrees.map((wt) => ({
        id: `${effort}:${wt}`,
        effort,
        repo: r.repo,
        title: `Dirty worktree kept — ${r.repo}`,
        text: `Worktree kept — uncommitted work in ${wt}`,
      })),
    )
    if (kept.length > 0) {
      const known = new Set(this.state.notices.map((n) => n.id))
      this.set({ notices: [...this.state.notices, ...kept.filter((n) => !known.has(n.id))] })
    }
    return { results, mapClosed: res.data?.mapClosed ?? false }
  }

  /** Gate override (#40): "I know what I'm doing" with a required reason; audit lands on the map issue. */
  async applyOverride(effort: string, stage: string, reason: string): Promise<string | null> {
    const res = await mutateJson('/api/pipeline/override', 'POST', { effort, stage, reason })
    return res.error ?? null
  }

  async revokeOverride(effort: string, stage: string): Promise<string | null> {
    const res = await mutateJson('/api/pipeline/override/revoke', 'POST', { effort, stage })
    return res.error ?? null
  }

  dismissNotice(id: string) {
    this.set({ notices: this.state.notices.filter((n) => n.id !== id) })
  }

  /**
   * Advisory verdict inbox rows (#41): an open PR whose latest agent verdict is
   * request-changes rides the Needs-you queue. Re-synced from every stage poll,
   * so rows appear and clear as PRs are re-reviewed or merged.
   */
  syncVerdictNotices(effort: string, tickets: TicketView[]) {
    const prefix = `verdict:${effort}:`
    const fresh = tickets
      .filter((t) => t.pr?.state === 'open' && t.pr.agentVerdict === 'request-changes')
      .map((t) => ({
        id: `${prefix}${t.ref.id}`,
        effort,
        repo: t.ref.display,
        title: `Agent requested changes — ${t.ref.display}`,
        text: `Open PR's latest agent verdict is request-changes: ${t.pr!.url}`,
      }))
    const others = this.state.notices.filter((n) => !n.id.startsWith(prefix))
    const next = [...others, ...fresh]
    // Skip the set() when nothing changed — the rail polls every 15s.
    if (
      next.length !== this.state.notices.length ||
      next.some((n, i) => n.id !== this.state.notices[i]?.id)
    ) {
      this.set({ notices: next })
    }
  }

  selectEffort(effortId: string | null) {
    this.set({ selectedEffort: effortId, selectedStageIdx: null })
  }

  selectSession(sessionId: string | null) {
    if (sessionId) {
      const view = this.state.sessions[sessionId]
      if (view?.meta.status === 'running') this.attach(sessionId)
      else if (view) void this.loadTranscript(sessionId)
      this.set({
        selectedSession: sessionId,
        selectedEffort: view?.meta.effort ?? this.state.selectedEffort,
        inboxOpen: false,
      })
    } else {
      this.set({ selectedSession: null })
    }
  }

  selectStage(idx: number | null) {
    this.set({ selectedStageIdx: idx })
  }

  toggleTheme() {
    const theme = this.state.theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('threadmap:theme', theme)
    this.set({ theme })
  }

  setInboxOpen(open: boolean) {
    this.set({ inboxOpen: open })
  }

  setNewEffortOpen(open: boolean) {
    this.set({ newEffortOpen: open })
  }

  /**
   * Mint a brand-new effort (#106): POST the idea + home repo, then adopt the
   * returned effort into the list and select it. Returns an error string on
   * failure, else null. (The auto-kickoff planning session is #110 — this
   * action stops at minting the map and surfacing the new effort.)
   */
  async mintEffort(repo: string, idea: string): Promise<string | null> {
    const res = await mutateJson<EffortSummary>('/api/efforts', 'POST', { repo, idea })
    if (res.error) return res.error
    if (res.data) {
      const effort = res.data
      const efforts = this.state.efforts.some((e) => e.ref.id === effort.ref.id)
        ? this.state.efforts
        : [...this.state.efforts, effort]
      this.set({ efforts, selectedEffort: effort.ref.id, selectedStageIdx: null, newEffortOpen: false })
    }
    return null
  }

  /** Open/close the New-session modal, binding it to `effort` (null = ad-hoc).
   *  The binding is passed in by the caller — the effort row, rail, or palette —
   *  never inferred from the current selection. */
  setNewSessionOpen(open: boolean, effort: string | null = null) {
    this.set({ newSessionOpen: open, newSessionEffort: open ? effort : null })
  }

  setPaletteOpen(open: boolean) {
    this.set({ paletteOpen: open })
  }

  setError(message: string) {
    this.set({ error: message })
  }

  dismissError() {
    this.set({ error: null })
  }
}

// Guarded — unit tests import this module outside a browser.
function storedTheme(): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem('threadmap:theme')
}

/** POST/PUT helper for setup actions — surfaces the server's error string. */
export async function mutateJson<T = unknown>(
  url: string,
  method: 'POST' | 'PUT',
  body?: unknown,
): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
    if (!res.ok) return { error: data?.error ?? `HTTP ${res.status}` }
    return { data: data as T }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export const store = new Store()

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.getState)
}
