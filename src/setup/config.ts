// `.threadmap/config.json` — the one durable per-workspace setup artifact
// (#21's shape, extended). The wizard owns writing it; the stage service and
// tracker MCP only ever read it. Everything else setup produces lives either
// in the tracker, in per-repo docs, or under ~/.threadmap (ephemeral).

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface WorkspaceConfig {
  tracker: 'github' | 'linear'
  /** Confirmed repo dir names (#7 §1) — discovery is a proposal, this is the answer. */
  repos?: string[]
  linear?: {
    orgId?: string
    /** Default repo↔team map (#19 §3 as amended by #7 §4). */
    repoTeams?: Record<string, string>
  }
}

export function configPath(root: string): string {
  return join(root, '.threadmap', 'config.json')
}

export async function readConfig(root: string): Promise<WorkspaceConfig | null> {
  const raw = await readFile(configPath(root), 'utf8').catch(() => null)
  if (raw === null) return null
  const parsed = JSON.parse(raw) as Partial<WorkspaceConfig>
  return {
    tracker: parsed.tracker === 'linear' ? 'linear' : 'github',
    ...(parsed.repos ? { repos: parsed.repos } : {}),
    ...(parsed.linear ? { linear: parsed.linear } : {}),
  }
}

export async function writeConfig(root: string, config: WorkspaceConfig): Promise<void> {
  const path = configPath(root)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}
