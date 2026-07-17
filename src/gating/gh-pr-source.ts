// gh-backed PRSource. PR linkage rides the branch-naming convention and the
// `gh` CLI's auth, regardless of which tracker the workspace uses (#19 §6).
// Sessions mint branch names (#26), so exact names are not recomputable —
// this lists PRs targeting the effort trunk and matches by ticket-id regex.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TicketRef } from '../tracker/types.js'
import type { PRInfo, PRSource } from './types.js'
import { githubIssueNumber, ticketBranchPattern } from './branches.js'

const execFileAsync = promisify(execFile)

/** Injectable for tests: runs `gh` in a repo dir, resolves stdout. */
export type GhExec = (args: string[], repoDir: string) => Promise<string>

const defaultExec: GhExec = async (args, repoDir) => {
  const { stdout } = await execFileAsync('gh', args, { cwd: repoDir, maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

interface GhPr {
  number: number
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  headRefName: string
  body: string
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
}

export class GhPrSource implements PRSource {
  constructor(private exec: GhExec = defaultExec) {}

  async ticketPR(repoDir: string, ticket: TicketRef, trunk: string): Promise<PRInfo | null> {
    const out = await this.exec(
      ['pr', 'list', '--base', trunk, '--state', 'all', '--json', 'number,url,state,headRefName,body,mergeable', '--limit', '100'],
      repoDir,
    )
    const pattern = ticketBranchPattern(ticket)
    const pr = pickPR((JSON.parse(out) as GhPr[]).filter((p) => pattern.test(p.headRefName)))
    if (!pr) return null
    const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed'
    // Closed-unmerged PRs are abandoned — thread/verdict state is irrelevant.
    const review =
      state === 'closed' ? { unresolved: 0 } : await this.reviewState(repoDir, pr.number)
    const info: PRInfo = { url: pr.url, number: pr.number, state, unresolvedReviewThreads: review.unresolved }
    if (review.verdict) info.agentVerdict = review.verdict
    if (state === 'open' && pr.mergeable === 'CONFLICTING') info.conflicting = true
    // `Ticket: #<n>` body backstop (#26) — GitHub-tracker refs only; Linear
    // linkage rides the branch name itself. Warning, never a gate.
    const issue = githubIssueNumber(ticket)
    if (issue !== null && !new RegExp(`Ticket:\\s*#${issue}\\b`, 'i').test(pr.body ?? ''))
      info.missingTicketRef = true
    return info
  }

  /** Threads and reviews ride one GraphQL call — same PR node, one round trip. */
  private async reviewState(
    repoDir: string,
    prNumber: number,
  ): Promise<{ unresolved: number; verdict?: 'approve' | 'request-changes' }> {
    const query =
      'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}} reviews(last:100){nodes{body}}}}}'
    const out = await this.exec(
      ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-F', `number=${prNumber}`, '-f', `query=${query}`],
      repoDir,
    )
    const graphql = JSON.parse(out)
    const verdict = parseVerdict(reviewBodies(graphql))
    return { unresolved: countUnresolved(graphql), ...(verdict && { verdict }) }
  }
}

/** One PR per ticket is the convention; if several exist, live beats merged beats abandoned. */
export function pickPR(prs: GhPr[]): GhPr | undefined {
  return (
    prs.find((p) => p.state === 'OPEN') ??
    prs.find((p) => p.state === 'MERGED') ??
    prs[0]
  )
}

/**
 * Latest advisory verdict (#41): reviews arrive oldest-first (`reviews(last:100)`),
 * and the newest one carrying a `Verdict:` first line wins — re-reviews after
 * fixes supersede earlier verdicts. Reviews without the line are ignored.
 */
export function parseVerdict(bodies: string[]): 'approve' | 'request-changes' | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const first = (bodies[i] ?? '').split('\n', 1)[0]!.trim()
    const match = /^verdict:\s*(approve|request-changes)$/i.exec(first)
    if (match) return match[1]!.toLowerCase() as 'approve' | 'request-changes'
  }
  return null
}

export function reviewBodies(graphql: unknown): string[] {
  const nodes = (graphql as { data?: { repository?: { pullRequest?: { reviews?: { nodes?: { body?: string }[] } } } } })
    .data?.repository?.pullRequest?.reviews?.nodes
  return nodes?.map((n) => n.body ?? '') ?? []
}

export function countUnresolved(graphql: unknown): number {
  const nodes = (graphql as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved: boolean }[] } } } } })
    .data?.repository?.pullRequest?.reviewThreads?.nodes
  return nodes?.filter((n) => !n.isResolved).length ?? 0
}
