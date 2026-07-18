// ~/.threadmap holds only ephemeral session data — processes, logs,
// transcripts — plus a small effort registry. The tracker stays the database
// (ADR-0001); nothing here is ever authoritative pipeline state.

import { homedir } from 'node:os'
import { join } from 'node:path'

export function threadmapHome(): string {
  return process.env.THREADMAP_HOME ?? join(homedir(), '.threadmap')
}

export function transcriptsDir(home = threadmapHome()): string {
  return join(home, 'transcripts')
}
