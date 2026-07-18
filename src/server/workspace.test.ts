import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverWorkspace } from './workspace.js'

let dir: string

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function makeWorkspace(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'threadmap-ws-'))
  return dir
}

describe('discoverWorkspace', () => {
  it('finds direct child git clones', async () => {
    const root = await makeWorkspace()
    await mkdir(join(root, 'api', '.git'), { recursive: true })
    await mkdir(join(root, 'web', '.git'), { recursive: true })
    await mkdir(join(root, 'notes')) // no .git — not a repo

    const ws = await discoverWorkspace(root)
    expect(ws.repos.map((r) => r.name)).toEqual(['api', 'web'])
    expect(ws.repos[0]?.path).toBe(join(root, 'api'))
  })

  it('includes the root itself when it is a clone (single-repo case)', async () => {
    const root = await makeWorkspace()
    await mkdir(join(root, '.git'))

    const ws = await discoverWorkspace(root)
    expect(ws.repos).toHaveLength(1)
    expect(ws.repos[0]?.path).toBe(root)
  })

  it('counts a .git file (worktree) as a clone and skips hidden dirs', async () => {
    const root = await makeWorkspace()
    await mkdir(join(root, 'wt'))
    await writeFile(join(root, 'wt', '.git'), 'gitdir: elsewhere\n')
    await mkdir(join(root, '.threadmap', '.git'), { recursive: true })

    const ws = await discoverWorkspace(root)
    expect(ws.repos.map((r) => r.name)).toEqual(['wt'])
  })

  it('returns no repos for an empty directory', async () => {
    const root = await makeWorkspace()
    const ws = await discoverWorkspace(root)
    expect(ws.repos).toEqual([])
  })
})
