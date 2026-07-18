// Git plumbing for the implement pipeline (#11, renamed by #26): per-repo
// effort trunks created lazily off the default-branch head, one detached
// worktree per ticket (sessions mint their own branch, so the worktree starts
// detached at the trunk head), clean-checked removal on ticket-PR merge, and
// the main→trunk landing merge. Everything runs through the injectable Exec
// shape shared with the setup module.

import { basename, join } from 'node:path'
import { defaultExec, type Exec } from '../setup/exec.js'
import type { TicketRef } from '../tracker/types.js'
import { refSlug } from '../gating/branches.js'

export { defaultExec, type Exec } from '../setup/exec.js'

/** `<workspace>/.threadmap/worktrees/<repo>/<ticket-ref-slug>/` (#11). */
export function worktreePath(workspaceRoot: string, repoName: string, ticket: TicketRef): string {
  return join(workspaceRoot, '.threadmap', 'worktrees', repoName, refSlug(ticket))
}

/** The remote default branch (`origin/HEAD` symref); falls back to `main`. */
export async function defaultBranch(repoDir: string, exec: Exec = defaultExec): Promise<string> {
  const out = await exec('git', ['ls-remote', '--symref', 'origin', 'HEAD'], repoDir)
  return /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out)?.[1] ?? 'main'
}

export async function remoteBranchExists(
  repoDir: string,
  branch: string,
  exec: Exec = defaultExec,
): Promise<boolean> {
  const out = await exec('git', ['ls-remote', '--heads', 'origin', branch], repoDir)
  return out.trim().length > 0
}

/**
 * Lazy trunk creation (#11): first implement session in a repo pushes the
 * trunk off the remote default-branch head; later sessions find it existing.
 */
export async function ensureTrunk(
  repoDir: string,
  trunk: string,
  exec: Exec = defaultExec,
): Promise<{ created: boolean }> {
  await exec('git', ['fetch', 'origin', '--prune'], repoDir)
  if (await remoteBranchExists(repoDir, trunk, exec)) return { created: false }
  const base = await defaultBranch(repoDir, exec)
  await exec('git', ['push', 'origin', `refs/remotes/origin/${base}:refs/heads/${trunk}`], repoDir)
  await exec('git', ['fetch', 'origin', '--prune'], repoDir)
  return { created: true }
}

/** Absolute worktree paths registered in the repo. */
export async function listWorktrees(repoDir: string, exec: Exec = defaultExec): Promise<string[]> {
  const out = await exec('git', ['worktree', 'list', '--porcelain'], repoDir)
  return [...out.matchAll(/^worktree (.+)$/gm)].map((m) => m[1] as string)
}

/**
 * Detached worktree at the trunk head. Detached because the ticket branch
 * name is session-minted (#26) — the session's first act is
 * `git checkout -b tm/<type>/<id>-<context>`.
 */
export async function addWorktree(
  repoDir: string,
  path: string,
  trunk: string,
  exec: Exec = defaultExec,
): Promise<void> {
  await exec('git', ['fetch', 'origin', trunk], repoDir)
  await exec('git', ['worktree', 'add', '--detach', path, `origin/${trunk}`], repoDir)
}

/**
 * No uncommitted changes and no commits unreachable from origin — the #11
 * bar for automatic removal after the ticket PR merges.
 */
export async function isWorktreeClean(worktreeDir: string, exec: Exec = defaultExec): Promise<boolean> {
  const status = await exec('git', ['status', '--porcelain'], worktreeDir)
  if (status.trim().length > 0) return false
  const unpushed = await exec('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], worktreeDir)
  return unpushed.trim() === '0'
}

export async function removeWorktree(
  repoDir: string,
  path: string,
  opts: { force?: boolean } = {},
  exec: Exec = defaultExec,
): Promise<void> {
  await exec('git', ['worktree', 'remove', ...(opts.force ? ['--force'] : []), path], repoDir)
  await exec('git', ['worktree', 'prune'], repoDir)
}

export type MergeResult = { merged: true } | { merged: false; conflict: boolean }

/**
 * The one main→trunk sync before landing (#11), attempted mechanically in
 * `worktreeDir` (a checkout of the trunk): merge the remote default branch
 * and push. A conflicted merge is left in progress — the caller spawns an
 * agent session in the worktree to resolve it.
 */
export async function mergeDefaultIntoTrunk(
  worktreeDir: string,
  trunk: string,
  base: string,
  exec: Exec = defaultExec,
): Promise<MergeResult> {
  try {
    await exec('git', ['merge', '--no-edit', `origin/${base}`], worktreeDir)
  } catch {
    const conflicted = await exec('git', ['diff', '--name-only', '--diff-filter=U'], worktreeDir)
      .then((out) => out.trim().length > 0)
      .catch(() => false)
    if (!conflicted) throw new Error(`merge of origin/${base} into ${trunk} failed without conflicts`)
    return { merged: false, conflict: true }
  }
  await exec('git', ['push', 'origin', `HEAD:refs/heads/${trunk}`], worktreeDir)
  return { merged: true }
}

/**
 * Landing worktree: a real checkout of the trunk (unlike ticket worktrees,
 * the sync commits to the trunk itself). Reused across land attempts.
 */
export async function addTrunkWorktree(
  repoDir: string,
  path: string,
  trunk: string,
  exec: Exec = defaultExec,
): Promise<void> {
  await exec('git', ['fetch', 'origin', trunk], repoDir)
  await exec('git', ['worktree', 'add', '-B', trunk, path, `origin/${trunk}`], repoDir)
}

/** Post-landing trunk deletion (#11); tolerates an already-deleted branch. */
export async function deleteRemoteBranch(
  repoDir: string,
  branch: string,
  exec: Exec = defaultExec,
): Promise<void> {
  try {
    await exec('git', ['push', 'origin', '--delete', branch], repoDir)
  } catch (err) {
    if (await remoteBranchExists(repoDir, branch, exec)) throw err
  }
}

/** Workspace-local repo handle — worktree paths are keyed by directory name. */
export function repoNameOf(repoDir: string): string {
  return basename(repoDir)
}
