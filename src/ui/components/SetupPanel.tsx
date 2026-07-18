// Setup wizard / readiness panel (#22, decisions in #7), rebuilt on shadcn
// (Base UI) in the Soft Depth direction (#67): one Dialog, two modes. Guided
// mode is the first-run wizard — non-dismissable (no close, no outside-press,
// no Escape) until ≥1 repo is ready — and afterwards the identical checks live
// behind a TopBar pill as the always-available readiness panel. Sections scroll
// in a ScrollArea; every row is check-then-fix on Field/Checkbox/RadioGroup/
// Input/Select, and docs plans render through the CodeBlock particle. Behavior
// is unchanged from the #8 panel — the check text comes from GET
// /api/setup/status, the buttons are the fixes.

import { Check, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { mutateJson, store, useStore } from '../lib/store.js'
import type { DocPlanEntry, GitHubProvisionResult, LinearOrgInfo, LinearTeam, SetupStatus } from '../lib/types.js'
import { CodeBlock } from './particles.js'

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

/** Soft Depth tone pill — the setup panel's ✓ / • / status markers on Badge. */
function TonePill({
  tone = 'muted',
  children,
  title,
  className,
}: {
  tone?: 'success' | 'warning' | 'muted'
  children: React.ReactNode
  title?: string
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        'border-transparent',
        tone === 'success' && 'bg-success/12 text-success',
        tone === 'warning' && 'bg-warning/12 text-warning',
        tone === 'muted' && 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {children}
    </Badge>
  )
}

export function SetupPanel() {
  const state = useStore()
  const setup = state.setup
  const guided = !!setup && !setup.ready

  return (
    <Dialog
      open={state.setupOpen && !!setup}
      // Guided mode is non-dismissable: block outside-press / Escape / close.
      disablePointerDismissal={guided}
      onOpenChange={(open) => {
        if (!open && guided) return
        store.setSetupOpen(open)
      }}
    >
      {setup && (
        <DialogContent
          showCloseButton={!guided}
          className="flex max-h-[86vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        >
          <DialogHeader className="flex-row items-center gap-2.5 border-b p-4 pr-12">
            <DialogTitle>{guided ? 'Workspace setup' : 'Readiness'}</DialogTitle>
            {guided ? (
              <TonePill tone="warning">setup required — the pipeline unlocks at 1 ready repo</TonePill>
            ) : (
              <TonePill tone="success">ready</TonePill>
            )}
            <DialogDescription className="sr-only">
              Check-then-fix workspace readiness: repos, tracker, auth, skills, and agent docs.
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              <ReposSection setup={setup} />
              <TrackerSection setup={setup} />
              <AuthSection setup={setup} />
              {setup.tracker === 'linear' && <TeamsSection setup={setup} />}
              {setup.tracker === 'github' && <LabelsSection setup={setup} />}
              <SkillsSection setup={setup} />
              <DocsSection setup={setup} />
            </div>
          </ScrollArea>
        </DialogContent>
      )}
    </Dialog>
  )
}

function Section({ title, ok, children }: { title: string; ok: boolean; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-3.5">
      <div className="mb-2 flex items-center gap-2">
        <TonePill tone={ok ? 'success' : 'warning'}>{ok ? <Check className="size-3" /> : '•'}</TonePill>
        <b className="text-sm">{title}</b>
      </div>
      {children}
    </section>
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
      <div className="flex flex-col gap-2">
        {discovered.map((repo) => (
          <label key={repo.name} className="flex cursor-pointer items-center gap-2">
            <Checkbox checked={confirmed.has(repo.name)} onCheckedChange={() => void toggle(repo.name)} />
            <span className="font-mono text-sm">{repo.name}</span>
          </label>
        ))}
        {discovered.length === 0 && (
          <span className="text-sm text-muted-foreground">No git clones found in this workspace directory.</span>
        )}
      </div>
      {error && <ErrorLine text={error} />}
    </Section>
  )
}

/* ---------- 2. tracker choice, locked once efforts exist (#7 §9) ---------- */

function TrackerSection({ setup }: { setup: SetupStatus }) {
  const [error, setError] = useState<string | null>(null)
  const pick = async (tracker: string) => {
    if (tracker !== 'github' && tracker !== 'linear') return
    setError(await store.saveSetupConfig({ tracker }))
  }
  return (
    <Section title="Tracker" ok={setup.tracker !== null}>
      <div className="flex items-center gap-4">
        <RadioGroup
          value={setup.tracker ?? ''}
          onValueChange={(v) => void pick(String(v))}
          className="flex grid-cols-none gap-4"
        >
          {(['github', 'linear'] as const).map((t) => (
            <label
              key={t}
              className={cn(
                'flex items-center gap-1.5 text-sm',
                setup.trackerLocked && setup.tracker !== t ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              )}
            >
              <RadioGroupItem value={t} disabled={setup.trackerLocked && setup.tracker !== t} />
              {t === 'github' ? 'GitHub Issues' : 'Linear'}
            </label>
          ))}
        </RadioGroup>
        {setup.trackerLocked && (
          <TonePill title="efforts exist — create a new workspace to switch">locked</TonePill>
        )}
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
      <div className="mb-2 text-sm text-muted-foreground">{setup.auth.detail}</div>
      {setup.tracker === 'linear' ? (
        <div className="flex items-center gap-2">
          <Input type="password" placeholder="lin_api_…" value={key} onChange={(e) => setKey(e.target.value)} />
          <Button size="sm" disabled={!key.trim() || busy} onClick={() => void submitKey()}>
            {busy && <Spinner />}
            {busy ? 'Validating…' : 'Save key'}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {!setup.auth.ok && <code className="font-mono text-sm text-muted-foreground">gh auth login</code>}
          <Button variant="outline" size="sm" onClick={() => void store.refreshSetup()}>
            Re-check
          </Button>
        </div>
      )}
      {org && (
        <div className="mt-1.5 text-sm text-muted-foreground">
          Connected to {org.orgName} as {org.viewerName}.
        </div>
      )}
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
      <div className="flex flex-col gap-1.5">
        {setup.repos.map((repo) => {
          const options = teams ?? prefill(repo.teamId)
          const items = options.map((t) => ({ value: t.id, label: `${t.name} (${t.key})` }))
          return (
            <div key={repo.name} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate font-mono text-sm">{repo.name}</span>
              <Select
                items={items}
                value={repo.teamId ?? ''}
                onValueChange={(v) => void assign(repo.name, String(v ?? ''))}
                disabled={!teams}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue placeholder="— pick default team —" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((t) => (
                    <SelectItem key={t.id} value={t.id} disabled={taken.has(t.id) && repo.teamId !== t.id}>
                      {t.name} ({t.key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Input placeholder="new team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} />
        <Button variant="outline" size="sm" disabled={!newTeam.trim() || busy} onClick={() => void create()}>
          + Create team
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={taken.size === 0 || busy}
          onClick={() => void provision()}
          title="create vocabulary labels + disable auto-close automations"
        >
          {provisioned ? <Check /> : null}
          {provisioned ? 'Provisioned' : 'Provision teams'}
        </Button>
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
      <div className="mb-2 text-sm text-muted-foreground">
        Stamp the threadmap label vocabulary into each confirmed repo — sessions fail to create labelled issues
        without it.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || setup.repos.length === 0 || !setup.auth.ok}
          onClick={() => void provision()}
          title="gh label create the wayfinder:*/threadmap:* vocabulary in every confirmed repo"
        >
          {busy && <Spinner />}
          {busy ? 'Stamping…' : allOk ? 'Provisioned' : 'Provision labels'}
        </Button>
        {results?.map((r) => (
          <TonePill key={r.name} tone={r.ok ? 'success' : 'warning'} title={r.detail}>
            {r.ok ? '✓' : '!'} {r.name}
          </TonePill>
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
      <div className="mb-2 text-sm text-muted-foreground">
        <span className="font-mono">mattpocock/skills#{setup.skills.pin}</span> — {setup.skills.detail}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || setup.skills.ok} onClick={() => void install()}>
          {busy && <Spinner />}
          {busy ? 'Installing…' : setup.skills.ok ? 'Installed' : 'Install + link'}
        </Button>
        {error && (
          <Button variant="outline" size="sm" onClick={escalate} title="spawn a Claude Code session to fix the install">
            <Wand2 />
            Let an agent fix it
          </Button>
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
      <div className="flex flex-col gap-2">
        {setup.repos.map((repo) => (
          <RepoDocs key={repo.name} repo={repo} />
        ))}
      </div>
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
    <div className="border-t pt-2.5 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{repo.name}</span>
        {repo.docs.map((d) => (
          <TonePill key={d.path} tone={d.present ? 'success' : 'muted'} title={d.path}>
            {d.present ? '✓' : '·'} {d.path.split('/').pop()}
          </TonePill>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {templatesMissing.length > 0 && !plan && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadPlan()}>
            {busy && <Spinner />}
            Review templates
          </Button>
        )}
        {agentMissing.length > 0 && (
          <Button variant="outline" size="sm" onClick={seedWithAgent}>
            <Wand2 />
            Seed with agent session
          </Button>
        )}
        {landed && <span className="text-sm text-muted-foreground">{landed}</span>}
      </div>
      {plan && (
        <div className="mt-2 flex flex-col gap-2">
          {plan.map((entry) => (
            <CodeBlock key={entry.path} title={entry.path} meta={entry.action}>
              {entry.proposed}
            </CodeBlock>
          ))}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || plan.every((e) => e.action === 'unchanged')}
              onClick={() => void apply(plan.filter((e) => e.action !== 'unchanged').map((e) => e.path))}
            >
              Write + commit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPlan(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <ErrorLine text={error} />}
    </div>
  )
}

function ErrorLine({ text }: { text: string }) {
  return <div className="mt-1.5 text-[13px] text-destructive">{text}</div>
}
