// Skills install (#4's research, locked in #7 §5): official mattpocock/skills
// at a pinned version, installed once into the machine-global canonical dir
// (~/.agents/skills via `npx skills add --global`), then symlinked into each
// detected agent's user-level skills dir — copy-fallback where symlinks fail
// (Windows without developer mode). Plain code first; the UI offers the
// agent-escalation session when this throws.

import { cp, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultExec, type Exec } from './exec.js'

/** Baked into the threadmap release (#7 §8) — upgrading the package bumps it. */
export const SKILLS_PIN = 'v1.1.0'
export const SKILLS_SPEC = `mattpocock/skills#${SKILLS_PIN}`

export interface SkillsPaths {
  /** Canonical machine-global install dir the skills CLI owns. */
  canonicalDir: string
  /** Agent-name → that agent's user-level skills dir. */
  agentDirs: Record<string, string>
  /** Marker recording the pin the last successful install used. */
  markerPath: string
}

export function defaultSkillsPaths(home = homedir()): SkillsPaths {
  return {
    canonicalDir: join(home, '.agents', 'skills'),
    agentDirs: { 'claude-code': join(home, '.claude', 'skills') },
    markerPath: join(home, '.threadmap', 'skills.json'),
  }
}

export interface SkillsStatus {
  ok: boolean
  pin: string
  installedPin: string | null
  detail: string
}

/** Check-only half of the idempotent check-then-fix pair (#7 §8). */
export async function skillsStatus(paths: SkillsPaths, pin = SKILLS_PIN): Promise<SkillsStatus> {
  const marker = await readMarker(paths.markerPath)
  if (!(await exists(paths.canonicalDir)))
    return { ok: false, pin, installedPin: marker, detail: 'skills not installed' }
  if (marker !== pin)
    return { ok: false, pin, installedPin: marker, detail: marker ? `stale pin ${marker} (want ${pin})` : 'install not recorded' }
  const missing = await missingLinks(paths)
  if (missing.length > 0)
    return { ok: false, pin, installedPin: marker, detail: `missing links: ${missing.join(', ')}` }
  return { ok: true, pin, installedPin: marker, detail: `pinned ${pin}, linked into ${Object.keys(paths.agentDirs).join(', ')}` }
}

/**
 * Fix half: install at the pin, (re)link every skill into every agent dir,
 * record the marker. Safe to re-run — stale pin reinstalls, missing links
 * relink, everything else no-ops.
 */
export async function installSkills(
  paths: SkillsPaths,
  exec: Exec = defaultExec,
  pin = SKILLS_PIN,
): Promise<SkillsStatus> {
  const marker = await readMarker(paths.markerPath)
  if (marker !== pin || !(await exists(paths.canonicalDir))) {
    await exec('npx', ['-y', 'skills', 'add', `mattpocock/skills#${pin}`, '--global'])
  }
  await linkIntoAgents(paths)
  await mkdir(join(paths.markerPath, '..'), { recursive: true })
  await writeFile(paths.markerPath, `${JSON.stringify({ pin }, null, 2)}\n`, 'utf8')
  return skillsStatus(paths, pin)
}

async function linkIntoAgents(paths: SkillsPaths): Promise<void> {
  const skills = await skillDirs(paths.canonicalDir)
  for (const agentDir of Object.values(paths.agentDirs)) {
    await mkdir(agentDir, { recursive: true })
    for (const name of skills) {
      const target = join(paths.canonicalDir, name)
      const link = join(agentDir, name)
      if (await exists(link)) continue // never overwrite — a user's own skill wins
      try {
        await symlink(target, link, 'junction')
      } catch {
        await cp(target, link, { recursive: true }) // Windows copy-fallback
      }
    }
  }
}

async function missingLinks(paths: SkillsPaths): Promise<string[]> {
  const skills = await skillDirs(paths.canonicalDir)
  const missing: string[] = []
  for (const [agent, agentDir] of Object.entries(paths.agentDirs)) {
    for (const name of skills) {
      if (!(await exists(join(agentDir, name)))) missing.push(`${agent}/${name}`)
    }
  }
  return missing
}

async function skillDirs(canonicalDir: string): Promise<string[]> {
  const entries = await readdir(canonicalDir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
}

async function readMarker(markerPath: string): Promise<string | null> {
  const raw = await readFile(markerPath, 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    return (JSON.parse(raw) as { pin?: string }).pin ?? null
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
