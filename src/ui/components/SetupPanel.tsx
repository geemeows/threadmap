// Setup wizard / readiness panel (#22, decisions in #7): one component, two
// modes. Guided mode is the first-run wizard — forced open until ≥1 repo is
// ready — and afterwards the identical checks live behind a TopBar pill as
// the always-available readiness panel. Every row is check-then-fix: the
// check text comes from GET /api/setup/status, the buttons are the fixes.

import { useEffect, useState } from 'react'
import { mutateJson, store, useStore } from '../lib/store.js'
import type { DocPlanEntry, GitHubProvisionResult, LinearOrgInfo, LinearTeam, SetupStatus } from '../lib/types.js'
import { Pill } from './primitives.js'

const DOC_AGENT_PROMPT = [
  'Run /setup-matt-pocock-skills for this repository.',
  'Seed CONTEXT.md at the repo root, docs/agents/glossary.md, and docs/agents/coding-standards.md',
  'from what the codebase actually contains. Do not overwrite docs/agents/issue-tracker.md',
  'or docs/adr/template.md — threadmap stamps those from templates.',
  'Commit the new docs with the message "docs: threadmap setup — agent docs" and push to origin.',
  'If the push is rejected (branch protection), move the commit onto a branch and open a PR instead.',
].join(' ')

const SKILLS_AGENT_PROMPT = [
  'The threadmap skills install failed. Install the official mattpocock/skills at the pinned',
  'version with `npx skills add "mattpocock/skills#<pin>" --global`, then make sure every skill',
  'in ~/.agents/skills is linked (or copied) into ~/.claude/skills. Diagnose whatever is failing',
  '(npx availability, permissions, symlink support) and fix it.',
].join(' ')

export function SetupPanel() {
  const state = useStore()
  const setup = state.setup
  if (!state.setupOpen || !setup) return null
  const guided = !setup.ready

  return (
    <div
      className="overlay-bg"
      onClick={(e) => {
        if (e.target === e.currentTarget) store.setSetupOpen(false)
      }}
    >
      <div className="overlay-panel" style={{ width: 720, maxHeight: '86vh', overflowY: 'auto' }}>
        <div className="flex items-center gap-2.5 p-[14px_18px]" style={{ borderBottom: '1px solid var(--border)' }}>
          <b>{guided ? 'Workspace setup' : 'Readiness'}</b>
          {guided ? (
            <Pill tone="amber">setup required — the pipeline unlocks at 1 ready repo</Pill>
          ) : (
            <Pill tone="mint">ready</Pill>
          )}
          <span className="flex-1" />
          {!guided && (
            <button className="btn sm" onClick={() => store.setSetupOpen(false)}>
              ✕
            </button>
          )}
        </div>
        <div className="p-[16px_18px] flex flex-col gap-4">
          <ReposSection setup={setup} />
          <TrackerSection setup={setup} />
          <AuthSection setup={setup} />
          {setup.tracker === 'linear' && <TeamsSection setup={setup} />}
          {setup.tracker === 'github' && <LabelsSection setup={setup} />}
          <SkillsSection setup={setup} />
          <DocsSection setup={setup} />
        </div>
      </div>
    </div>
  )
}

function Section({ title, ok, children }: { title: string; ok: boolean; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
      <div className="flex items-center gap-2 mb-2">
        <Pill tone={ok ? 'mint' : 'amber'}>{ok ? '✓' : '•'}</Pill>
        <b>{title}</b>
      </div>
      {children}
    </div>
  )
}

/* ---------- 1. repos: scan-children discovery with confirm (#7 §1) ---------- */

function ReposSection({ setup }: { setup: SetupStatus }) {
  const state = useStore()
  const discovered = state.workspace?.repos ?? []
  const confirmed = new Set(setup.repos.map((r) => r.name))
  const [error, setError] = useState<string | null>(null)

  const toggle = async (name: string) => {
    const next = discovered.map((r) => r.name).filter((n) => (n === name ? !confirmed.has(n) : confirmed.has(n)))
    setError(await store.saveSetupConfig({ repos: next }))
  }

  return (
    <Section title="Repos" ok={setup.repos.length > 0}>
      <div className="flex flex-col gap-1">
        {discovered.map((repo) => (
          <label key={repo.name} className="flex items-center gap-2">
            <input type="checkbox" checked={confirmed.has(repo.name)} onChange={() => void toggle(repo.name)} />
            <span className="mono">{repo.name}</span>
          </label>
        ))}
        {discovered.length === 0 && <span>No git clones found in this workspace directory.</span>}
      </div>
      {error && <ErrorLine text={error} />}
    </Section>
  )
}

/* ---------- 2. tracker choice, locked once efforts exist (#7 §9) ---------- */

function TrackerSection({ setup }: { setup: SetupStatus }) {
  const [error, setError] = useState<string | null>(null)
  const pick = async (tracker: 'github' | 'linear') => {
    setError(await store.saveSetupConfig({ tracker }))
  }
  return (
    <Section title="Tracker" ok={setup.tracker !== null}>
      <div className="flex items-center gap-4">
        {(['github', 'linear'] as const).map((t) => (
          <label key={t} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="tracker"
              checked={setup.tracker === t}
              disabled={setup.trackerLocked && setup.tracker !== t}
              onChange={() => void pick(t)}
            />
            {t === 'github' ? 'GitHub Issues' : 'Linear'}
          </label>
        ))}
        {setup.trackerLocked && <Pill title="efforts exist — create a new workspace to switch">locked</Pill>}
      </div>
      {error && <ErrorLine text={error} />}
    </Section>
  )
}

/* ---------- 3. auth: gh re-check / masked Linear key (#7 §3) ---------- */

function AuthSection({ setup }: { setup: SetupStatus }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [org, setOrg] = useState<LinearOrgInfo | null>(null)

  const submitKey = async () => {
    setBusy(true)
    setError(null)
    const res = await mutateJson<LinearOrgInfo>('/api/setup/linear/key', 'POST', { apiKey: key })
    setBusy(false)
    if (res.error) return setError(res.error)
    setOrg(res.data ?? null)
    setKey('')
    await store.refreshSetup()
  }

  return (
    <Section title="Auth" ok={setup.auth.ok}>
      <div className="mb-2">{setup.auth.detail}</div>
      {setup.tracker === 'linear' ? (
        <div className="flex items-center gap-2">
          <input
            type="password"
            placeholder="lin_api_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn primary sm" disabled={!key.trim() || busy} onClick={() => void submitKey()}>
            {busy ? 'validating…' : 'Save key'}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {!setup.auth.ok && <span className="mono">gh auth login</span>}
          <button className="btn sm" onClick={() => void store.refreshSetup()}>
            Re-check
          </button>
        </div>
      )}
      {org && <div className="mt-1">Connected to {org.orgName} as {org.viewerName}.</div>}
      {error && <ErrorLine text={error} />}
    </Section>
  )
}

/* ---------- 4. Linear team mapping + provision (#7 §4, #20) ---------- */

function TeamsSection({ setup }: { setup: SetupStatus }) {
  const [teams, setTeams] = useState<LinearTeam[] | null>(null)
  const [newTeam, setNewTeam] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [provisioned, setProvisioned] = useState(false)

  useEffect(() => {
    if (!setup.auth.ok) return
    void fetch('/api/setup/linear/teams')
      .then((r) => r.json())
      .then((data: LinearTeam[] | { error: string }) =>
        Array.isArray(data) ? setTeams(data) : setError(data.error),
      )
      .catch((err: unknown) => setError(String(err)))
  }, [setup.auth.ok])

  const assigned = new Map(setup.repos.map((r) => [r.name, r.teamId]))
  const taken = new Set([...assigned.values()].filter(Boolean))

  const assign = async (repoName: string, teamId: string) => {
    const repoTeams: Record<string, string> = {}
    for (const r of setup.repos) {
      const v = r.name === repoName ? teamId : r.teamId
      if (v) repoTeams[r.name] = v
    }
    setError(await store.saveSetupConfig({ linear: { repoTeams } }))
  }

  const create = async () => {
    setBusy(true)
    const res = await mutateJson<LinearTeam>('/api/setup/linear/teams', 'POST', { name: newTeam.trim() })
    setBusy(false)
    if (res.error) return setError(res.error)
    if (res.data) setTeams((prev) => [...(prev ?? []), res.data as LinearTeam])
    setNewTeam('')
  }

  const provision = async () => {
    setBusy(true)
    const teamIds = [...taken].filter((id): id is string => typeof id === 'string')
    const res = await mutateJson('/api/setup/linear/provision', 'POST', { teamIds })
    setBusy(false)
    if (res.error) return setError(res.error)
    setProvisioned(true)
  }

  const mapped = setup.repos.every((r) => r.teamId)
  return (
    <Section title="Teams" ok={mapped}>
      {setup.repos.map((repo) => (
        <div key={repo.name} className="flex items-center gap-2 mb-1.5">
          <span className="mono" style={{ width: 160 }}>{repo.name}</span>
          <select
            value={repo.teamId ?? ''}
            onChange={(e) => void assign(repo.name, e.target.value)}
            disabled={!teams}
          >
            <option value="">— pick default team —</option>
            {(teams ?? prefill(repo.teamId)).map((t) => (
              <option key={t.id} value={t.id} disabled={taken.has(t.id) && repo.teamId !== t.id}>
                {t.name} ({t.key})
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="flex items-center gap-2 mt-2">
        <input placeholder="new team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} />
        <button className="btn sm" disabled={!newTeam.trim() || busy} onClick={() => void create()}>
          + Create team
        </button>
        <span className="flex-1" />
        <button
          className="btn primary sm"
          disabled={taken.size === 0 || busy}
          onClick={() => void provision()}
          title="create vocabulary labels + disable auto-close automations"
        >
          {provisioned ? '✓ Provisioned' : 'Provision teams'}
        </button>
      </div>
      {error && <ErrorLine text={error} />}
    </Section>
  )
}

/* ---------- 4b. GitHub label vocabulary provisioning (#43) ---------- */

function LabelsSection({ setup }: { setup: SetupStatus }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<GitHubProvisionResult[] | null>(null)

  const provision = async () => {
    setBusy(true)
    setError(null)
    const res = await mutateJson<{ repos: GitHubProvisionResult[] }>('/api/setup/github/provision', 'POST', {})
    setBusy(false)
    if (res.data?.repos) setResults(res.data.repos)
    else if (res.error) setError(res.error)
  }

  const allOk = results !== null && results.every((r) => r.ok)
  return (
    <Section title="Labels" ok={allOk}>
      <div className="mb-2">
        Stamp the threadmap label vocabulary into each confirmed repo — sessions fail to create
        labelled issues without it.
      </div>
      <div className="flex items-center gap-2">
        <button
          className="btn primary sm"
          disabled={busy || setup.repos.length === 0 || !setup.auth.ok}
          onClick={() => void provision()}
          title="gh label create the wayfinder:*/threadmap:* vocabulary in every confirmed repo"
        >
          {busy ? 'stamping…' : allOk ? '✓ Provisioned' : 'Provision labels'}
        </button>
        {results?.map((r) => (
          <Pill key={r.name} tone={r.ok ? 'mint' : 'amber'} title={r.detail}>
            {r.ok ? '✓' : '!'} {r.name}
          </Pill>
        ))}
      </div>
      {error && <ErrorLine text={error} />}
    </Section>
  )
}

function prefill(teamId: string | null): LinearTeam[] {
  return teamId ? [{ id: teamId, key: '…', name: 'assigned team' }] : []
}

/* ---------- 5. skills install, agent escalation on failure (#7 §5) ---------- */

function SkillsSection({ setup }: { setup: SetupStatus }) {
  const state = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const install = async () => {
    setBusy(true)
    setError(null)
    const res = await mutateJson('/api/setup/skills/install', 'POST', {})
    setBusy(false)
    if (res.error) return setError(res.error)
    await store.refreshSetup()
  }

  const escalate = () => {
    const cwd = state.workspace?.root
    if (!cwd) return
    store.startSession({
      cwd,
      prompt: SKILLS_AGENT_PROMPT,
      permissionPolicy: { mode: 'default', intercept: true },
      stage: 'setup',
    })
    store.setSetupOpen(false)
  }

  return (
    <Section title="Skills" ok={setup.skills.ok}>
      <div className="mb-2">
        <span className="mono">mattpocock/skills#{setup.skills.pin}</span> — {setup.skills.detail}
      </div>
      <div className="flex items-center gap-2">
        <button className="btn primary sm" disabled={busy || setup.skills.ok} onClick={() => void install()}>
          {busy ? 'installing…' : setup.skills.ok ? 'Installed' : 'Install + link'}
        </button>
        {error && (
          <button className="btn sm" onClick={escalate} title="spawn a Claude Code session to fix the install">
            ⚑ Let an agent fix it
          </button>
        )}
      </div>
      {error && <ErrorLine text={error} />}
    </Section>
  )
}

/* ---------- 6. docs: template stamping + one agent session per repo (#7 §6–7) ---------- */

function DocsSection({ setup }: { setup: SetupStatus }) {
  const allReady = setup.repos.length > 0 && setup.repos.every((r) => r.docs.every((d) => d.present))
  return (
    <Section title="Docs" ok={allReady}>
      {setup.repos.map((repo) => (
        <RepoDocs key={repo.name} repo={repo} />
      ))}
    </Section>
  )
}

function RepoDocs({ repo }: { repo: SetupStatus['repos'][number] }) {
  const [plan, setPlan] = useState<DocPlanEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [landed, setLanded] = useState<string | null>(null)

  const templatesMissing = repo.docs.filter((d) => d.source === 'template' && !d.present)
  const agentMissing = repo.docs.filter((d) => d.source === 'agent' && !d.present)

  const loadPlan = async () => {
    setBusy(true)
    const res = await fetch(`/api/setup/docs/plan?repo=${encodeURIComponent(repo.name)}`)
    const data = (await res.json()) as DocPlanEntry[] | { error: string }
    setBusy(false)
    if (Array.isArray(data)) setPlan(data)
    else setError(data.error)
  }

  const apply = async (files: string[]) => {
    setBusy(true)
    setError(null)
    const res = await mutateJson<{ mode: string; prUrl?: string }>('/api/setup/docs/apply', 'POST', {
      repo: repo.name,
      files,
    })
    setBusy(false)
    if (res.error) return setError(res.error)
    setLanded(res.data?.mode === 'pr' ? `PR opened: ${res.data.prUrl}` : 'committed')
    setPlan(null)
    await store.refreshSetup()
  }

  const seedWithAgent = () => {
    store.startSession({
      cwd: repo.path,
      prompt: DOC_AGENT_PROMPT,
      permissionPolicy: { mode: 'default', intercept: true },
      stage: 'setup',
    })
    store.setSetupOpen(false)
  }

  return (
    <div className="mb-2" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="mono">{repo.name}</span>
        {repo.docs.map((d) => (
          <Pill key={d.path} tone={d.present ? 'mint' : ''} title={d.path}>
            {d.present ? '✓' : '·'} {d.path.split('/').pop()}
          </Pill>
        ))}
      </div>
      <div className="flex items-center gap-2">
        {templatesMissing.length > 0 && !plan && (
          <button className="btn sm" disabled={busy} onClick={() => void loadPlan()}>
            Review templates
          </button>
        )}
        {agentMissing.length > 0 && (
          <button className="btn sm" onClick={seedWithAgent}>
            ▶ Seed with agent session
          </button>
        )}
        {landed && <span>{landed}</span>}
      </div>
      {plan && (
        <div className="mt-2 flex flex-col gap-1.5">
          {plan.map((entry) => (
            <details key={entry.path}>
              <summary className="mono">
                {entry.path} — {entry.action}
              </summary>
              <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 11, padding: 8 }}>{entry.proposed}</pre>
            </details>
          ))}
          <div className="flex gap-2">
            <button
              className="btn primary sm"
              disabled={busy || plan.every((e) => e.action === 'unchanged')}
              onClick={() => void apply(plan.filter((e) => e.action !== 'unchanged').map((e) => e.path))}
            >
              Write + commit
            </button>
            <button className="btn sm" onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <ErrorLine text={error} />}
    </div>
  )
}

function ErrorLine({ text }: { text: string }) {
  return <div className="mt-1" style={{ color: 'var(--red)', fontSize: 12.5 }}>{text}</div>
}
