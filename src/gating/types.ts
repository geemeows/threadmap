// Gating engine types — ADR-0002 (one derived Stage per Effort) and the gates
// locked in #6 as amended by #11 (ticket PRs target the effort trunk, not main).

import type { RoutingTarget, SpecStatus, TicketRef } from '../tracker/types.js'

export const STAGES = ['planning', 'to-spec', 'to-tickets', 'implement', 'code-review'] as const

export type Stage = (typeof STAGES)[number]

/** Everything the pure derivation needs, gathered once per compute. */
export interface GateInputs {
  /** Open `wayfinder:*` children of the map issue. */
  openPlanningChildren: number
  spec: SpecStatus
  /** Logical stamp names on the map issue. */
  stamps: string[]
  /** Every `threadline:ticket` child, open and closed. */
  tickets: TicketView[]
}

export interface TicketView {
  ref: TicketRef
  closed: boolean
  /** The ticket's PR targeting the effort trunk, if any. */
  pr: PRInfo | null
}

export interface PRInfo {
  url: string
  state: 'open' | 'merged' | 'closed'
  unresolvedReviewThreads: number
  /** Open PR that GitHub reports as CONFLICTING with the trunk — the UI's cue to offer a reconcile session (#11). */
  conflicting?: boolean
  /**
   * Set (true) when a GitHub-tracker ticket's PR body lacks its `Ticket: #<n>`
   * reference (#26) — a Needs-you warning, never a gate condition.
   */
  missingTicketRef?: boolean
}

export interface GateStatus {
  stage: Stage
  /** The gate's exit condition holds (ignoring overrides). */
  met: boolean
  /** `override:<stage>` stamp present — gate treated as passed. */
  overridden: boolean
  /** Human-readable unmet conditions; empty when met. */
  unmet: string[]
}

export interface StageSnapshot {
  /** First stage whose gate is neither met nor overridden; code-review once all pass. */
  stage: Stage
  gates: GateStatus[]
  /** Per-ticket view (PR linkage included) so the UI can offer per-ticket actions. */
  tickets: TicketView[]
  /** All five gates pass — the UI may offer one-click "Complete effort" (never automatic). */
  readyToComplete: boolean
  /** Non-blocking Needs-you notices (e.g. a PR body missing `Ticket: #<n>`). */
  warnings: string[]
}

/**
 * Ticket ↔ PR linkage lives above the tracker seam (#19 §6): PRs are on
 * GitHub even in Linear workspaces. Queried by branch-naming convention.
 */
export interface PRSource {
  /**
   * The ticket's PR targeting `trunk` in the repo at `repoDir`, or null.
   * Matched by the ticket-id branch pattern (#26) — exact branch names are
   * session-minted and not recomputable.
   */
  ticketPR(repoDir: string, ticket: TicketRef, trunk: string): Promise<PRInfo | null>
}

/** Resolves a tracker RoutingTarget to the local clone owning it. */
export type RepoResolver = (target: RoutingTarget) => string
