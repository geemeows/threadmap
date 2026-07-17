// Pipeline orchestrator (#30) — wires the locked decisions into running
// sessions: implement sessions in per-ticket worktrees off the effort trunk
// (#11), prompts composed from the ticket body plus the branch/PR conventions
// (#26), reactive reconcile sessions on ticket-PR conflict, and the landing
// flow (one main→trunk sync, then the threadmap-composed trunk→main PR —
// humans click every merge).

import { join } from 'node:path'
import type { SessionMeta } from '../server/transcripts.js'
import type { SessionRegistry } from '../server/registry.js'
import type { Workspace } from '../server/workspace.js'
import type { PRSource, RepoResolver } from '../gating/types.js'
import { refSlug, trunkBranch } from '../gating/branches.js'
import { closeEffort } from '../gating/override.js'
import type { TicketRef, TrackerAdapter } from '../tracker/types.js'
import { implementSessionInstructions, trunkToMainPrBody } from './implement-prompt.js'
import { reviewSessionInstructions } from './review-prompt.js'
import {
  addTrunkWorktree,
  addWorktree,
  defaultBranch,
  defaultExec,
  deleteRemoteBranch,
  ensureTrunk,
  isWorktreeClean,
  listWorktrees,
  mergeDefaultIntoTrunk,
  remoteBranchExists,
  removeWorktree,
  worktreePath,
  type Exec,
} from './git.js'

export interface OrchestratorDeps {
  workspace: Workspace
  registry: SessionRegistry
  tracker: TrackerAdapter
  prSource: PRSource
  resolveRepoDir: RepoResolver
  /** Tracker-specific effort ref minting (stage.ts owns the rule). */
  mintEffortRef: (id: string) => TicketRef
  exec?: Exec
}

export interface LandResult {
  repo: string
  status: 'pr_opened' | 'pr_exists' | 'sync_session_started' | 'sync_in_progress'
  prUrl?: string
  session?: SessionMeta
}

export interface CleanupResult {
  ticket: string
  repo: string
  status: 'removed' | 'kept_dirty' | 'no_worktree' | 'pr_not_merged'
}

export interface CompleteResult {
  repo: string
  removedWorktrees: string[]
  keptWorktrees: string[]
  trunkDeleted: boolean
}

export interface CompleteOutcome {
  results: CompleteResult[]
  /** True when the sweep was fully clean and the map issue was closed (#6). */
  mapClosed: boolean
}

export class PipelineOrchestrator {
  private exec: Exec
  /** Live sync sessions per repo trunk, so land() never double-spawns. */
  private syncSessions = new Map<string, string>()

  constructor(private deps: OrchestratorDeps) {
    this.exec = deps.exec ?? defaultExec
  }

  /**
   * One implement session per ticket (#11): ensure the trunk, add a detached
   * worktree at its head, and start the agent on ticket body + conventions.
   */
  async startImplement(effortId: string, ticketId: string): Promise<SessionMeta> {
    const effort = this.deps.mintEffortRef(effortId)
    const ticket = await this.findTicket(effort, ticketId)
    const { repoDir, repoName } = await this.repoFor(ticket)
    const trunk = trunkBranch(effort)
    await ensureTrunk(repoDir, trunk, this.exec)
    const wt = worktreePath(this.deps.workspace.root, repoName, ticket)
    if (!(await listWorktrees(repoDir, this.exec)).includes(wt)) {
      await addWorktree(repoDir, wt, trunk, this.exec)
    }
    const { title, body } = await this.deps.tracker.ticketBody(ticket)
    const prompt = [
      `You are implementing one ticket of effort ${effort.display} (${effort.url}).`,
      ``,
      `# Ticket ${ticket.display}: ${title}`,
      ``,
      body,
      ``,
      implementSessionInstructions(ticket, effort),
      ``,
      `Implement the ticket. When the work is complete and checks pass: commit, push the branch, and open the PR exactly as specified above.`,
    ].join('\n')
    return this.deps.registry.start({
      cwd: wt,
      prompt,
      permissionPolicy: { mode: 'default', intercept: true },
      effort: effortId,
      stage: 'implement',
    })
  }

  /**
   * One review session per ticket PR (#52): same shape as startImplement, but
   * the session reads the open PR instead of writing code — it runs in the
   * ticket's worktree (or a fresh one detached at the trunk head when the
   * implement worktree is gone) and records its verdict per the #41 advisory
   * convention. Re-review is the same call again; the latest verdict wins.
   */
  async startReview(effortId: string, ticketId: string): Promise<SessionMeta> {
    const effort = this.deps.mintEffortRef(effortId)
    const ticket = await this.findTicket(effort, ticketId)
    const { repoDir, repoName } = await this.repoFor(ticket)
    const trunk = trunkBranch(effort)
    const pr = await this.deps.prSource.ticketPR(repoDir, ticket, trunk)
    if (pr?.state !== 'open') {
      throw new Error(`no open PR for ticket ${ticket.display} — nothing to review`)
    }
    const prNumber = pr.number ?? this.prNumberFromUrl(pr.url)
    const wt = worktreePath(this.deps.workspace.root, repoName, ticket)
    if (!(await listWorktrees(repoDir, this.exec)).includes(wt)) {
      await addWorktree(repoDir, wt, trunk, this.exec)
    }
    const { title, body } = await this.deps.tracker.ticketBody(ticket)
    const prompt = [
      `You are reviewing the PR for one ticket of effort ${effort.display} (${effort.url}).`,
      ``,
      `# Ticket ${ticket.display}: ${title}`,
      ``,
      body,
      ``,
      `Review PR #${prNumber} (${pr.url}) against the ticket above: read the full diff (\`gh pr diff ${prNumber}\`), check correctness and test coverage, and judge whether the change does what the ticket asks. Do not push commits or merge anything — your output is the review itself.`,
      ``,
      reviewSessionInstructions(prNumber),
    ].join('\n')
    return this.deps.registry.start({
      cwd: wt,
      prompt,
      permissionPolicy: { mode: 'default', intercept: true },
      effort: effortId,
      stage: 'review',
    })
  }

  /**
   * One-click reconcile (#11): when a ticket PR conflicts with the trunk, an
   * agent session in that ticket's worktree merges the trunk into the ticket
   * branch; the resolution commit is reviewed on the PR like any other change.
   */
  async startReconcile(effortId: string, ticketId: string): Promise<SessionMeta> {
    const effort = this.deps.mintEffortRef(effortId)
    const ticket = await this.findTicket(effort, ticketId)
    const { repoDir, repoName } = await this.repoFor(ticket)
    const trunk = trunkBranch(effort)
    const wt = worktreePath(this.deps.workspace.root, repoName, ticket)
    if (!(await listWorktrees(repoDir, this.exec)).includes(wt)) {
      throw new Error(`no worktree for ticket ${ticket.display} — start an implement session first`)
    }
    const prompt = [
      `The PR for ticket ${ticket.display} conflicts with the effort trunk \`${trunk}\` (a sibling ticket merged first).`,
      ``,
      `In this worktree: fetch origin, merge \`origin/${trunk}\` into the ticket branch, and resolve every conflict preserving both the ticket's changes and the sibling work already on the trunk. Run the repo's checks, then push the branch so the PR updates.`,
    ].join('\n')
    return this.deps.registry.start({
      cwd: wt,
      prompt,
      permissionPolicy: { mode: 'default', intercept: true },
      effort: effortId,
      stage: 'reconcile',
    })
  }

  /**
   * Landing flow (#11), per member repo that grew a trunk: one mechanical
   * main→trunk merge — an agent session takes over only when it conflicts —
   * then the trunk→main PR with the threadmap-composed body. Humans merge.
   */
  async land(effortId: string): Promise<LandResult[]> {
    const effort = this.deps.mintEffortRef(effortId)
    const trunk = trunkBranch(effort)
    const results: LandResult[] = []
    for (const [repoDir, entry] of await this.ticketsByRepo(effort)) {
      await this.exec('git', ['fetch', 'origin', '--prune'], repoDir)
      if (!(await remoteBranchExists(repoDir, trunk, this.exec))) continue

      const syncKey = `${repoDir}:${trunk}`
      const liveSync = this.syncSessions.get(syncKey)
      if (liveSync && this.deps.registry.get(liveSync)?.status === 'running') {
        results.push({ repo: entry.repoName, status: 'sync_in_progress' })
        continue
      }

      const base = await defaultBranch(repoDir, this.exec)
      const landWt = join(
        this.deps.workspace.root,
        '.threadline',
        'worktrees',
        entry.repoName,
        `land-${refSlug(effort)}`,
      )
      if (!(await listWorktrees(repoDir, this.exec)).includes(landWt)) {
        await addTrunkWorktree(repoDir, landWt, trunk, this.exec)
      } else {
        await this.exec('git', ['fetch', 'origin'], landWt)
      }

      const merge = await mergeDefaultIntoTrunk(landWt, trunk, base, this.exec)
      if (!merge.merged) {
        const session = this.deps.registry.start({
          cwd: landWt,
          prompt: [
            `This worktree is on the effort trunk \`${trunk}\` with a merge of \`origin/${base}\` in progress that has conflicts.`,
            ``,
            `Resolve every conflict preserving both the effort's changes and what landed on ${base}, complete the merge commit, run the repo's checks, then push: \`git push origin HEAD:refs/heads/${trunk}\`.`,
          ].join('\n'),
          permissionPolicy: { mode: 'default', intercept: true },
          effort: effortId,
          stage: 'land-sync',
        })
        this.syncSessions.set(syncKey, session.id)
        results.push({ repo: entry.repoName, status: 'sync_session_started', session })
        continue
      }

      const existing = await this.openLandingPr(repoDir, trunk, base)
      if (existing) {
        results.push({ repo: entry.repoName, status: 'pr_exists', prUrl: existing })
        continue
      }
      const { title } = await this.deps.tracker.ticketBody(effort)
      const out = await this.exec(
        'gh',
        [
          'pr', 'create',
          '--base', base,
          '--head', trunk,
          '--title', `Land effort: ${title}`,
          '--body', trunkToMainPrBody(effort, entry.tickets),
        ],
        repoDir,
      )
      results.push({ repo: entry.repoName, status: 'pr_opened', prUrl: out.trim().split('\n').pop() ?? '' })
    }
    return results
  }

  /**
   * Auto-removal on ticket-PR merge (#11): a merged ticket's worktree goes
   * away if it holds no uncommitted/unpushed work; otherwise it is kept and
   * reported so the UI can flag it.
   */
  async cleanupMerged(effortId: string): Promise<CleanupResult[]> {
    const effort = this.deps.mintEffortRef(effortId)
    const trunk = trunkBranch(effort)
    const results: CleanupResult[] = []
    for (const child of await this.deps.tracker.children(effort, 'ticket')) {
      const { repoDir, repoName } = await this.repoFor(child.ref)
      const wt = worktreePath(this.deps.workspace.root, repoName, child.ref)
      const entry = (status: CleanupResult['status']) =>
        results.push({ ticket: child.ref.display, repo: repoName, status })
      if (!(await listWorktrees(repoDir, this.exec)).includes(wt)) {
        entry('no_worktree')
        continue
      }
      const pr = await this.deps.prSource.ticketPR(repoDir, child.ref, trunk)
      if (pr?.state !== 'merged') {
        entry('pr_not_merged')
        continue
      }
      if (await isWorktreeClean(wt, this.exec)) {
        await removeWorktree(repoDir, wt, {}, this.exec)
        entry('removed')
      } else {
        entry('kept_dirty')
      }
    }
    return results
  }

  /**
   * Post-landing sweep (#11): remove the effort's remaining worktrees (only
   * with `force` when dirty) and delete each repo's trunk. When the sweep is
   * fully clean, close the map issue — the click is the user's completion act
   * (#6); a kept-dirty worktree leaves the map open for a forced re-run.
   */
  async completeEffort(effortId: string, opts: { force?: boolean } = {}): Promise<CompleteOutcome> {
    const effort = this.deps.mintEffortRef(effortId)
    const trunk = trunkBranch(effort)
    const results: CompleteResult[] = []
    for (const [repoDir, entry] of await this.ticketsByRepo(effort)) {
      const removed: string[] = []
      const kept: string[] = []
      const landWt = join(
        this.deps.workspace.root, '.threadline', 'worktrees', entry.repoName, `land-${refSlug(effort)}`,
      )
      const paths = [...entry.tickets.map((t) => worktreePath(this.deps.workspace.root, entry.repoName, t)), landWt]
      const registered = await listWorktrees(repoDir, this.exec)
      for (const wt of paths) {
        if (!registered.includes(wt)) continue
        if (opts.force || (await isWorktreeClean(wt, this.exec))) {
          await removeWorktree(repoDir, wt, { force: opts.force ?? false }, this.exec)
          removed.push(wt)
        } else {
          kept.push(wt)
        }
      }
      let trunkDeleted = false
      if (kept.length === 0) {
        await deleteRemoteBranch(repoDir, trunk, this.exec)
        // The landing worktree left a local trunk branch behind; drop it too.
        await this.exec('git', ['branch', '-D', trunk], repoDir).catch(() => {})
        trunkDeleted = true
      }
      results.push({ repo: entry.repoName, removedWorktrees: removed, keptWorktrees: kept, trunkDeleted })
    }
    const mapClosed = results.every((r) => r.keptWorktrees.length === 0)
    if (mapClosed) {
      await closeEffort(
        this.deps.tracker,
        effort,
        'Effort completed via threadmap — worktrees swept and effort trunks deleted.',
      )
    }
    return { results, mapClosed }
  }

  // -- internals -------------------------------------------------------------

  /** Resolve a ticket id to its ref via the effort's children — validates membership and recovers the display (Linear ids are UUIDs). */
  private async findTicket(effort: TicketRef, ticketId: string): Promise<TicketRef> {
    const children = await this.deps.tracker.children(effort, 'ticket')
    const child = children.find((c) => c.ref.id === ticketId)
    if (!child) throw new Error(`ticket ${ticketId} is not a ticket child of effort ${effort.display}`)
    return child.ref
  }

  private async repoFor(ticket: TicketRef): Promise<{ repoDir: string; repoName: string }> {
    const target = await this.deps.tracker.ticketTarget(ticket)
    const repoDir = this.deps.resolveRepoDir(target)
    const repoName =
      this.deps.workspace.repos.find((r) => r.path === repoDir)?.name ??
      repoDir.split('/').filter(Boolean).pop() ??
      repoDir
    return { repoDir, repoName }
  }

  private async ticketsByRepo(
    effort: TicketRef,
  ): Promise<Map<string, { repoName: string; tickets: TicketRef[] }>> {
    const byRepo = new Map<string, { repoName: string; tickets: TicketRef[] }>()
    for (const child of await this.deps.tracker.children(effort, 'ticket')) {
      const { repoDir, repoName } = await this.repoFor(child.ref)
      const entry = byRepo.get(repoDir) ?? { repoName, tickets: [] }
      entry.tickets.push(child.ref)
      byRepo.set(repoDir, entry)
    }
    return byRepo
  }

  /** All ticket PRs live on GitHub regardless of tracker (#19 §6), so `/pull/<n>` is always present. */
  private prNumberFromUrl(url: string): number {
    const match = /\/pull\/(\d+)(?:\D|$)/.exec(url)
    if (!match) throw new Error(`cannot derive a PR number from ${url}`)
    return Number(match[1])
  }

  private async openLandingPr(repoDir: string, trunk: string, base: string): Promise<string | null> {
    const out = await this.exec(
      'gh',
      ['pr', 'list', '--head', trunk, '--base', base, '--state', 'open', '--json', 'url'],
      repoDir,
    )
    const prs = JSON.parse(out || '[]') as { url: string }[]
    return prs[0]?.url ?? null
  }
}
