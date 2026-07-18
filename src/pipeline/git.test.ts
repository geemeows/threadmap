import { describe, expect, it } from 'vitest'
import type { Exec } from './git.js'
import {
  addWorktree,
  defaultBranch,
  deleteRemoteBranch,
  ensureTrunk,
  isWorktreeClean,
  listWorktrees,
  mergeDefaultIntoTrunk,
  worktreePath,
} from './git.js'

/** Fake exec: routes by substring of the joined command; records calls. */
function fakeExec(routes: Record<string, string | Error | ((args: string[]) => string)>) {
  const calls: string[] = []
  const exec: Exec = async (cmd, args, _cwd) => {
    const joined = `${cmd} ${args.join(' ')}`
    calls.push(joined)
    const key = Object.keys(routes).find((k) => joined.includes(k))
    if (key === undefined) return ''
    const value = routes[key]
    if (value instanceof Error) throw value
    return typeof value === 'function' ? value(args) : (value as string)
  }
  return { exec, calls }
}

describe('worktreePath', () => {
  it('keys worktrees by repo name and ticket ref slug (#11)', () => {
    expect(worktreePath('/ws', 'web', { id: 'acme/web#42', display: 'acme/web#42', url: '' })).toBe(
      '/ws/.threadmap/worktrees/web/acme-web-42',
    )
  })
})

describe('defaultBranch', () => {
  it('parses the origin HEAD symref', async () => {
    const { exec } = fakeExec({
      'ls-remote --symref': 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n',
    })
    expect(await defaultBranch('/repo', exec)).toBe('develop')
  })

  it('falls back to main when the symref is unreadable', async () => {
    const { exec } = fakeExec({ 'ls-remote --symref': 'abc123\tHEAD\n' })
    expect(await defaultBranch('/repo', exec)).toBe('main')
  })
})

describe('ensureTrunk', () => {
  it('is a no-op when the trunk already exists on origin', async () => {
    const { exec, calls } = fakeExec({
      'ls-remote --heads origin tm/effort/1': 'abc\trefs/heads/tm/effort/1\n',
    })
    expect(await ensureTrunk('/repo', 'tm/effort/1', exec)).toEqual({ created: false })
    expect(calls.some((c) => c.includes('push'))).toBe(false)
  })

  it('creates the trunk off the remote default-branch head when missing', async () => {
    const { exec, calls } = fakeExec({
      'ls-remote --heads origin tm/effort/1': '',
      'ls-remote --symref': 'ref: refs/heads/main\tHEAD\n',
    })
    expect(await ensureTrunk('/repo', 'tm/effort/1', exec)).toEqual({ created: true })
    expect(calls).toContain('git push origin refs/remotes/origin/main:refs/heads/tm/effort/1')
  })
})

describe('worktrees', () => {
  it('addWorktree fetches the trunk and adds a detached worktree at its head', async () => {
    const { exec, calls } = fakeExec({})
    await addWorktree('/repo', '/ws/.threadmap/worktrees/web/acme-web-42', 'tm/effort/1', exec)
    expect(calls).toEqual([
      'git fetch origin tm/effort/1',
      'git worktree add --detach /ws/.threadmap/worktrees/web/acme-web-42 origin/tm/effort/1',
    ])
  })

  it('listWorktrees parses porcelain output', async () => {
    const { exec } = fakeExec({
      'worktree list': 'worktree /repo\nHEAD abc\n\nworktree /ws/.threadmap/worktrees/web/x\nHEAD def\n',
    })
    expect(await listWorktrees('/repo', exec)).toEqual(['/repo', '/ws/.threadmap/worktrees/web/x'])
  })

  it('isWorktreeClean requires empty status and zero unpushed commits', async () => {
    const dirty = fakeExec({ 'status --porcelain': ' M src/a.ts\n' })
    expect(await isWorktreeClean('/wt', dirty.exec)).toBe(false)

    const unpushed = fakeExec({ 'status --porcelain': '', 'rev-list --count': '2\n' })
    expect(await isWorktreeClean('/wt', unpushed.exec)).toBe(false)

    const clean = fakeExec({ 'status --porcelain': '', 'rev-list --count': '0\n' })
    expect(await isWorktreeClean('/wt', clean.exec)).toBe(true)
  })
})

describe('mergeDefaultIntoTrunk', () => {
  it('pushes the trunk after a clean merge', async () => {
    const { exec, calls } = fakeExec({})
    expect(await mergeDefaultIntoTrunk('/wt', 'tm/effort/1', 'main', exec)).toEqual({ merged: true })
    expect(calls).toContain('git push origin HEAD:refs/heads/tm/effort/1')
  })

  it('reports a conflicted merge and leaves it in progress', async () => {
    const { exec, calls } = fakeExec({
      'merge --no-edit': new Error('CONFLICT'),
      'diff --name-only --diff-filter=U': 'src/a.ts\n',
    })
    expect(await mergeDefaultIntoTrunk('/wt', 'tm/effort/1', 'main', exec)).toEqual({
      merged: false,
      conflict: true,
    })
    expect(calls.some((c) => c.includes('push'))).toBe(false)
    expect(calls.some((c) => c.includes('merge --abort'))).toBe(false)
  })

  it('rethrows merge failures that are not conflicts', async () => {
    const { exec } = fakeExec({
      'merge --no-edit': new Error('fatal: not something we can merge'),
      'diff --name-only --diff-filter=U': '',
    })
    await expect(mergeDefaultIntoTrunk('/wt', 'tm/effort/1', 'main', exec)).rejects.toThrow(
      /failed without conflicts/,
    )
  })
})

describe('deleteRemoteBranch', () => {
  it('tolerates an already-deleted branch', async () => {
    const { exec } = fakeExec({
      'push origin --delete': new Error('remote ref does not exist'),
      'ls-remote --heads': '',
    })
    await expect(deleteRemoteBranch('/repo', 'tm/effort/1', exec)).resolves.toBeUndefined()
  })

  it('rethrows when the branch still exists after a failed delete', async () => {
    const { exec } = fakeExec({
      'push origin --delete': new Error('permission denied'),
      'ls-remote --heads': 'abc\trefs/heads/tm/effort/1\n',
    })
    await expect(deleteRemoteBranch('/repo', 'tm/effort/1', exec)).rejects.toThrow(/permission denied/)
  })
})
