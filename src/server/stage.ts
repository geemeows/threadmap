// Stage service — binds the gating engine (#14) to a workspace's tracker so
// `GET /api/stage` can answer with a StageSnapshot (#16's wire shape). The
// tracker choice and Linear team routing live in `.threadline/config.json` at
// the workspace root (#19 §9); absent config means GitHub.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GhPrSource,
  computeStage,
  type GatherDeps,
  type GhExec,
  type StageSnapshot,
} from '../gating/index.js'
import {
  GitHubAdapter,
  LinearAdapter,
  LinearClient,
  parseGitHubRef,
  resolveLinearApiKey,
  type RoutingTarget,
  type TicketRef,
  type TrackerAdapter,
} from '../tracker/index.js'
import type { Workspace } from './workspace.js'

export interface TrackerConfig {
  tracker: 'github' | 'linear'
  linear?: {
    orgId?: string
    /** Default repo↔team map (#19 §3, per-effort override rides the effort registry). */
    repoTeams?: Record<string, string>
  }
}

export async function loadTrackerConfig(root: string): Promise<TrackerConfig> {
  const raw = await readFile(join(root, '.threadline', 'config.json'), 'utf8').catch(() => null)
  if (raw === null) return { tracker: 'github' }
  const parsed = JSON.parse(raw) as Partial<TrackerConfig>
  return { tracker: parsed.tracker === 'linear' ? 'linear' : 'github', ...(parsed.linear ? { linear: parsed.linear } : {}) }
}

export interface StageService {
  snapshot(effortId: string): Promise<StageSnapshot>
}

export interface StageServiceOptions {
  ghExec?: GhExec
  config?: TrackerConfig
  /** Snapshot cache TTL so UI polling doesn't hammer the tracker. */
  cacheTtlMs?: number
}

const defaultGhExec: GhExec = async (args, repoDir) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)('gh', args, {
    cwd: repoDir,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

export async function createStageService(
  workspace: Workspace,
  opts: StageServiceOptions = {},
): Promise<StageService> {
  const ghExec = opts.ghExec ?? defaultGhExec
  const config = opts.config ?? (await loadTrackerConfig(workspace.root))
  const ttl = opts.cacheTtlMs ?? 5_000

  const deps = config.tracker === 'linear'
    ? await linearDeps(workspace, config, ghExec)
    : await githubDeps(workspace, ghExec)

  const cache = new Map<string, { at: number; snapshot: StageSnapshot }>()
  return {
    async snapshot(effortId: string): Promise<StageSnapshot> {
      const hit = cache.get(effortId)
      if (hit && Date.now() - hit.at < ttl) return hit.snapshot
      const snapshot = await computeStage(deps, mintEffortRef(config.tracker, effortId))
      cache.set(effortId, { at: Date.now(), snapshot })
      return snapshot
    },
  }
}

function mintEffortRef(tracker: 'github' | 'linear', id: string): TicketRef {
  if (tracker === 'github') {
    const { repo, number } = parseGitHubRef(id) // validates the ref shape early
    return { id, display: id, url: `https://github.com/${repo}/issues/${number}` }
  }
  return { id, display: id, url: '' }
}

async function githubDeps(workspace: Workspace, ghExec: GhExec): Promise<GatherDeps> {
  // Routing targets are nameWithOwner per workspace repo (efforts.ts mints the
  // same spelling); repos without a GitHub remote contribute none.
  const entries = await Promise.all(
    workspace.repos.map(async (repo) => {
      try {
        const out = await ghExec(['repo', 'view', '--json', 'nameWithOwner'], repo.path)
        const nameWithOwner = (JSON.parse(out) as { nameWithOwner: string }).nameWithOwner
        return { target: { id: nameWithOwner, display: repo.name }, path: repo.path }
      } catch {
        return null
      }
    }),
  )
  const resolved = entries.filter((e): e is NonNullable<typeof e> => e !== null)
  const tracker: TrackerAdapter = new GitHubAdapter({
    targets: resolved.map((e) => e.target),
    run: (args) => ghExec(args, workspace.root),
  })
  return {
    tracker,
    prSource: new GhPrSource(ghExec),
    resolveRepoDir: (target: RoutingTarget) => {
      const entry = resolved.find((e) => e.target.id === target.id)
      if (!entry) throw new Error(`no workspace clone for ${target.display} (${target.id})`)
      return entry.path
    },
  }
}

async function linearDeps(
  workspace: Workspace,
  config: TrackerConfig,
  ghExec: GhExec,
): Promise<GatherDeps> {
  const repoTeams = config.linear?.repoTeams ?? {}
  const targets: RoutingTarget[] = Object.entries(repoTeams).map(([repoName, teamId]) => ({
    id: teamId,
    display: repoName,
  }))
  const client = new LinearClient({ apiKey: await resolveLinearApiKey(config.linear?.orgId) })
  const tracker: TrackerAdapter = new LinearAdapter({
    client,
    ...(targets.length ? { targets } : {}),
  })
  return {
    tracker,
    prSource: new GhPrSource(ghExec), // PRs live on GitHub even in Linear workspaces (#19 §6)
    resolveRepoDir: (target: RoutingTarget) => {
      const repoName = Object.entries(repoTeams).find(([, teamId]) => teamId === target.id)?.[0]
      const repo = workspace.repos.find((r) => r.name === repoName)
      if (!repo) throw new Error(`no workspace clone mapped to team ${target.display} (${target.id})`)
      return repo.path
    },
  }
}
