import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Exec } from './exec.js'
import { SKILLS_PIN, installSkills, skillsStatus, type SkillsPaths } from './skills.js'

let dir: string

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function makePaths(): Promise<SkillsPaths> {
  dir = await mkdtemp(join(tmpdir(), 'threadmap-skills-'))
  return {
    canonicalDir: join(dir, 'agents', 'skills'),
    agentDirs: { 'claude-code': join(dir, 'claude', 'skills') },
    markerPath: join(dir, 'threadmap', 'skills.json'),
  }
}

/** Fake `npx skills add` that materializes two skills in the canonical dir. */
function fakeInstaller(paths: SkillsPaths) {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    for (const name of ['grilling', 'wayfinder']) {
      await mkdir(join(paths.canonicalDir, name), { recursive: true })
      await writeFile(join(paths.canonicalDir, name, 'SKILL.md'), '# skill\n')
    }
    return ''
  }
  return { calls, exec }
}

describe('skills install', () => {
  it('reports not installed on a bare machine', async () => {
    const paths = await makePaths()
    const status = await skillsStatus(paths)
    expect(status.ok).toBe(false)
    expect(status.detail).toBe('skills not installed')
  })

  it('installs at the pin, links into agent dirs, and records the marker', async () => {
    const paths = await makePaths()
    const { calls, exec } = fakeInstaller(paths)
    const status = await installSkills(paths, exec)
    expect(calls[0]).toEqual(['npx', '-y', 'skills', 'add', `mattpocock/skills#${SKILLS_PIN}`, '--global'])
    expect(status.ok).toBe(true)
    expect(status.installedPin).toBe(SKILLS_PIN)
    const link = await lstat(join(paths.agentDirs['claude-code']!, 'grilling'))
    expect(link.isSymbolicLink() || link.isDirectory()).toBe(true)
    const marker = JSON.parse(await readFile(paths.markerPath, 'utf8')) as { pin: string }
    expect(marker.pin).toBe(SKILLS_PIN)
  })

  it('re-run is idempotent: no reinstall, missing links repaired (#7 §8)', async () => {
    const paths = await makePaths()
    const first = fakeInstaller(paths)
    await installSkills(paths, first.exec)
    await rm(join(paths.agentDirs['claude-code']!, 'wayfinder'), { recursive: true, force: true })
    expect((await skillsStatus(paths)).detail).toContain('missing links')

    const second = fakeInstaller(paths)
    const status = await installSkills(paths, second.exec)
    expect(second.calls).toEqual([]) // pin already satisfied — no CLI run
    expect(status.ok).toBe(true)
  })

  it('flags a stale pin', async () => {
    const paths = await makePaths()
    await installSkills(paths, fakeInstaller(paths).exec)
    await writeFile(paths.markerPath, JSON.stringify({ pin: 'v0.9.0' }))
    const status = await skillsStatus(paths)
    expect(status.ok).toBe(false)
    expect(status.detail).toContain('stale pin v0.9.0')
  })

  it('never overwrites a user-owned skill of the same name', async () => {
    const paths = await makePaths()
    const userSkill = join(paths.agentDirs['claude-code']!, 'grilling')
    await mkdir(userSkill, { recursive: true })
    await writeFile(join(userSkill, 'SKILL.md'), '# mine\n')
    await installSkills(paths, fakeInstaller(paths).exec)
    expect(await readFile(join(userSkill, 'SKILL.md'), 'utf8')).toBe('# mine\n')
  })
})
