// Pure stage derivation — no I/O, no clocks. Computed from artifacts alone so
// the Stage pointer can never drift (ADR-0002); no event ever sets it.

import type { GateInputs, GateStatus, Stage, StageSnapshot } from './types.js'
import { STAGES } from './types.js'

export function overrideStamp(stage: Stage): string {
  return `override:${stage}`
}

export function deriveStage(inputs: GateInputs): StageSnapshot {
  const gates = STAGES.map((stage) => evaluateGate(stage, inputs))
  const firstUnpassed = gates.find((g) => !g.met && !g.overridden)
  return {
    stage: firstUnpassed?.stage ?? 'code-review',
    gates,
    tickets: inputs.tickets,
    readyToComplete: firstUnpassed === undefined,
    warnings: collectWarnings(inputs),
  }
}

/** Needs-you notices that never block a gate (#26's `Ticket: #<n>` backstop). */
function collectWarnings(inputs: GateInputs): string[] {
  return inputs.tickets
    .filter((t) => t.pr && t.pr.state !== 'closed' && t.pr.missingTicketRef)
    .map((t) => `${t.ref.display}'s PR body is missing its "Ticket: #<n>" reference`)
}

function evaluateGate(stage: Stage, inputs: GateInputs): GateStatus {
  const unmet = unmetConditions(stage, inputs)
  return {
    stage,
    met: unmet.length === 0,
    overridden: inputs.stamps.includes(overrideStamp(stage)),
    unmet,
  }
}

function unmetConditions(stage: Stage, inputs: GateInputs): string[] {
  const unmet: string[] = []
  switch (stage) {
    case 'planning': {
      if (inputs.openPlanningChildren > 0)
        unmet.push(`${inputs.openPlanningChildren} open wayfinder child(ren) on the map issue`)
      break
    }
    case 'to-spec': {
      if (inputs.spec === 'none') unmet.push('no spec sub-issue exists')
      else if (inputs.spec === 'open') unmet.push('spec sub-issue is still open (closing = approval)')
      else if (inputs.spec === 'auto-closed')
        unmet.push('spec sub-issue was closed by an automation, not a human — approval not granted')
      break
    }
    case 'to-tickets': {
      if (inputs.tickets.length === 0) unmet.push('no tickets exist yet')
      if (!inputs.stamps.includes('ticketed'))
        unmet.push('map issue lacks the human "ticketed" sign-off stamp')
      break
    }
    case 'implement': {
      if (inputs.tickets.length === 0) unmet.push('no tickets exist yet')
      for (const t of inputs.tickets) {
        // A closed-unmerged PR is abandoned, not linkage.
        if (!t.pr || t.pr.state === 'closed')
          unmet.push(`${t.ref.display} has no PR targeting the effort trunk`)
      }
      break
    }
    case 'code-review': {
      if (inputs.tickets.length === 0) unmet.push('no tickets exist yet')
      for (const t of inputs.tickets) {
        if (!t.pr || t.pr.state === 'closed') {
          unmet.push(`${t.ref.display} has no PR targeting the effort trunk`)
          continue
        }
        if (t.pr.state !== 'merged') unmet.push(`${t.ref.display}'s PR is not merged`)
        if (t.pr.unresolvedReviewThreads > 0)
          unmet.push(
            `${t.ref.display}'s PR has ${t.pr.unresolvedReviewThreads} unresolved review thread(s)`,
          )
        if (!t.closed) unmet.push(`${t.ref.display} is not closed`)
      }
      break
    }
  }
  return unmet
}
