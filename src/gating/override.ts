// Override record write path (#6): `threadmap:override:<stage>` label on the
// map issue + a structured audit comment. Derivation treats the labelled gate
// as passed; revoking removes the label (the audit trail stays in comments).

import type { TrackerAdapter, TicketRef } from '../tracker/types.js'
import type { Stage } from './types.js'
import { overrideStamp } from './derive.js'

export interface OverrideRecord {
  who: string
  /** ISO 8601 — caller supplies the clock. */
  when: string
  /** The gate conditions unmet at override time, from the current snapshot. */
  unmetConditions: string[]
  /** Required — an override without a reason is not recordable. */
  reason: string
}

export async function applyOverride(
  tracker: TrackerAdapter,
  effort: TicketRef,
  stage: Stage,
  record: OverrideRecord,
): Promise<void> {
  if (!record.reason.trim()) throw new Error('an override requires a reason')
  // Comment first: if the stamp write fails we have a dangling audit note,
  // which is harmless; a stamp without its audit record is not.
  await tracker.comment(effort, formatOverrideComment(stage, record))
  await tracker.stamp(effort, overrideStamp(stage))
}

export async function revokeOverride(
  tracker: TrackerAdapter,
  effort: TicketRef,
  stage: Stage,
  who: string,
  when: string,
): Promise<void> {
  await tracker.comment(effort, `## Override revoked: ${stage}\n\n- **Who**: ${who}\n- **When**: ${when}`)
  await tracker.unstamp(effort, overrideStamp(stage))
}

export function formatOverrideComment(stage: Stage, record: OverrideRecord): string {
  const unmet =
    record.unmetConditions.length > 0
      ? record.unmetConditions.map((c) => `  - ${c}`).join('\n')
      : '  - (none recorded)'
  return [
    `## Override: ${stage}`,
    '',
    `- **Who**: ${record.who}`,
    `- **When**: ${record.when}`,
    `- **Unmet condition(s)**:`,
    unmet,
    `- **Reason**: ${record.reason}`,
  ].join('\n')
}

/**
 * Close the effort's map issue. Completion is user-triggered, never automatic
 * (#6): the orchestrator's completeEffort calls this after a fully-clean
 * sweep, on the user's "Complete effort" click.
 */
export async function closeEffort(
  tracker: TrackerAdapter,
  effort: TicketRef,
  summary: string,
): Promise<void> {
  await tracker.resolve(effort, 'done', summary)
}
