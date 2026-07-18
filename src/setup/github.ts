// GitHub side of setup provisioning (#43): stamp the label vocabulary into
// each confirmed repo, symmetric with Linear provisioning (#20/#21). Without
// this, `gh issue create --label` hard-fails in any repo where a session
// hasn't ad-hoc created the label first. `gh label create --force` updates
// an existing label in place, so re-running is idempotent (#7 §8).

import { VOCABULARY_LABELS, THREADMAP_PREFIX, WAYFINDER_PREFIX } from '../tracker/labels.js'
import type { Exec } from './exec.js'

export interface GitHubProvisionResult {
  name: string
  ok: boolean
  detail: string
}

const OVERRIDE_PREFIX = `${THREADMAP_PREFIX}override:`

/** wayfinder = purple, overrides = alarm orange, other threadmap = green. */
export function labelColor(label: string): string {
  if (label.startsWith(WAYFINDER_PREFIX)) return '5319E7'
  if (label.startsWith(OVERRIDE_PREFIX)) return 'D93F0B'
  return '0E8A16'
}

/**
 * Create/update every vocabulary label in each repo (`gh` infers the GitHub
 * repo from the cwd's remote). One result per repo — a failure is reported,
 * not thrown, so the panel can show which repos still need provisioning.
 */
export async function provisionGitHub(
  repos: { name: string; path: string }[],
  exec: Exec,
): Promise<GitHubProvisionResult[]> {
  return Promise.all(
    repos.map(async (repo) => {
      try {
        for (const label of VOCABULARY_LABELS) {
          await exec(
            'gh',
            ['label', 'create', label, '--force', '--color', labelColor(label), '--description', 'threadmap-managed'],
            repo.path,
          )
        }
        return { name: repo.name, ok: true, detail: `${VOCABULARY_LABELS.length} labels stamped` }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { name: repo.name, ok: false, detail: message.split('\n')[0] ?? message }
      }
    }),
  )
}
