// GitHubAdapter — the TrackerAdapter seam (#19) over the `gh` CLI. Reads lean
// on GitHub's free inline rollups (`issue_dependencies_summary`, sub-issue
// listings with labels/assignees in one payload); change detection rides
// conditional requests (ETag cursor set — 304s are quota-free, #3).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  ChildTicket,
  CreateOpts,
  LabelNamespace,
  RoutingTarget,
  SpecStatus,
  TicketRef,
  TrackerAdapter,
  TrackerCapabilities,
} from './types.js'
import { SPEC_LABEL, inNamespace, logicalName, spellLabel } from './labels.js'

const execFileAsync = promisify(execFile)

/** Injectable for tests: runs `gh` with the given args, resolves stdout. */
export type GhRun = (args: string[]) => Promise<string>

export const defaultGhRun: GhRun = async (args) => {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

interface GhIssuePayload {
  id: number
  number: number
  state: 'open' | 'closed'
  html_url: string
  repository_url: string
  labels: { name: string }[]
  assignees: { login: string }[]
  issue_dependencies_summary?: { blocked_by: number }
}

/** `owner/repo#42` → its parts. Throws on refs this adapter did not mint. */
export function parseGitHubRef(id: string): { repo: string; number: number } {
  const match = /^([^\s#]+\/[^\s#]+)#(\d+)$/.exec(id)
  if (!match?.[1] || !match[2]) throw new Error(`not a GitHub ticket ref: ${id}`)
  return { repo: match[1], number: Number(match[2]) }
}

export function mintGitHubRef(repo: string, number: number, url?: string): TicketRef {
  const id = `${repo}#${number}`
  return { id, display: id, url: url ?? `https://github.com/${repo}/issues/${number}` }
}

export interface GitHubAdapterOptions {
  /** Workspace repos as routing targets: id = `owner/repo`, display = repo name. */
  targets: RoutingTarget[]
  run?: GhRun
}

export class GitHubAdapter implements TrackerAdapter {
  readonly name = 'github'
  readonly capabilities: TrackerCapabilities = { minPollIntervalMs: 5_000, freePolling: true }
  private run: GhRun
  private targets: RoutingTarget[]

  constructor(opts: GitHubAdapterOptions) {
    this.run = opts.run ?? defaultGhRun
    this.targets = opts.targets
  }

  // -- reads ---------------------------------------------------------------

  async openChildren(effort: TicketRef, labelNs?: LabelNamespace): Promise<TicketRef[]> {
    const children = await this.subIssues(effort)
    return children
      .filter((c) => c.state === 'open' && matchesNamespace(c, labelNs))
      .map(toRef)
  }

  async children(effort: TicketRef, labelNs?: LabelNamespace): Promise<ChildTicket[]> {
    const children = await this.subIssues(effort)
    return children
      .filter((c) => matchesNamespace(c, labelNs))
      .map((c) => ({ ref: toRef(c), state: c.state }))
  }

  async frontier(effort: TicketRef): Promise<TicketRef[]> {
    const children = await this.subIssues(effort)
    return children
      .filter(
        (c) =>
          c.state === 'open' &&
          c.assignees.length === 0 &&
          (c.issue_dependencies_summary?.blocked_by ?? 0) === 0,
      )
      .map(toRef)
  }

  async specStatus(effort: TicketRef): Promise<SpecStatus> {
    const specs = (await this.subIssues(effort)).filter((c) =>
      c.labels.some((l) => l.name === SPEC_LABEL),
    )
    if (specs.length === 0) return 'none'
    if (specs.some((c) => c.state === 'closed')) return 'approved' // GitHub: closed ⇒ human-approved (#19 §4)
    return 'open'
  }

  async mapStamps(effort: TicketRef): Promise<string[]> {
    const { repo, number } = parseGitHubRef(effort.id)
    const out = await this.run(['api', `repos/${repo}/issues/${number}`])
    const issue = JSON.parse(out) as GhIssuePayload
    return issue.labels
      .map((l) => logicalName(l.name))
      .filter((n): n is string => n !== null)
  }

  async ticketTarget(ref: TicketRef): Promise<RoutingTarget> {
    const { repo } = parseGitHubRef(ref.id)
    return this.targets.find((t) => t.id === repo) ?? { id: repo, display: repo.split('/')[1] ?? repo }
  }

  async routingTargets(): Promise<RoutingTarget[]> {
    return this.targets
  }

  // -- writes --------------------------------------------------------------

  async createChild(parent: TicketRef, opts: CreateOpts): Promise<TicketRef> {
    const created = JSON.parse(
      await this.run([
        'api',
        '--method',
        'POST',
        `repos/${opts.target.id}/issues`,
        '-f',
        `title=${opts.title}`,
        '-f',
        `body=${opts.body}`,
      ]),
    ) as GhIssuePayload
    const ref = mintGitHubRef(opts.target.id, created.number, created.html_url)
    for (const label of opts.labels ?? []) await this.stamp(ref, label)
    const { repo, number } = parseGitHubRef(parent.id)
    await this.run([
      'api',
      '--method',
      'POST',
      `repos/${repo}/issues/${number}/sub_issues`,
      '-F',
      `sub_issue_id=${created.id}`,
    ])
    return ref
  }

  async addBlockedBy(ref: TicketRef, blocker: TicketRef): Promise<void> {
    const blocked = parseGitHubRef(ref.id)
    const blocking = parseGitHubRef(blocker.id)
    // Dependencies API wants the blocker's database id, not its number (#3).
    const dbId = JSON.parse(
      await this.run(['api', `repos/${blocking.repo}/issues/${blocking.number}`]),
    ).id as number
    await this.run([
      'api',
      '--method',
      'POST',
      `repos/${blocked.repo}/issues/${blocked.number}/dependencies/blocked_by`,
      '-F',
      `issue_id=${dbId}`,
    ])
  }

  async comment(ref: TicketRef, markdown: string): Promise<void> {
    const { repo, number } = parseGitHubRef(ref.id)
    await this.run([
      'api',
      '--method',
      'POST',
      `repos/${repo}/issues/${number}/comments`,
      '-f',
      `body=${markdown}`,
    ])
  }

  async stamp(ref: TicketRef, name: string): Promise<void> {
    const { repo, number } = parseGitHubRef(ref.id)
    const label = spellLabel(name)
    await this.ensureLabel(repo, label)
    await this.run([
      'api',
      '--method',
      'POST',
      `repos/${repo}/issues/${number}/labels`,
      '-f',
      `labels[]=${label}`,
    ])
  }

  async unstamp(ref: TicketRef, name: string): Promise<void> {
    const { repo, number } = parseGitHubRef(ref.id)
    try {
      await this.run([
        'api',
        '--method',
        'DELETE',
        `repos/${repo}/issues/${number}/labels/${encodeURIComponent(spellLabel(name))}`,
      ])
    } catch (err) {
      if (!isHttpStatus(err, 404)) throw err // already absent — unstamp is idempotent
    }
  }

  async resolve(ref: TicketRef, outcome: 'done' | 'wontfix', comment?: string): Promise<void> {
    if (comment) await this.comment(ref, comment)
    const { repo, number } = parseGitHubRef(ref.id)
    await this.run([
      'api',
      '--method',
      'PATCH',
      `repos/${repo}/issues/${number}`,
      '-f',
      'state=closed',
      '-f',
      `state_reason=${outcome === 'done' ? 'completed' : 'not_planned'}`,
    ])
  }

  async attachPR(ref: TicketRef, prUrl: string): Promise<void> {
    await this.comment(ref, `Linked PR: ${prUrl}`)
  }

  // -- change detection ------------------------------------------------------

  /**
   * Cursor = JSON set of ETags for the map issue and its sub-issue listing.
   * Conditional GETs answer 304 when nothing moved — quota-free, so the poll
   * loop can run fast (#3).
   */
  async changesSince(
    effort: TicketRef,
    cursor?: string,
  ): Promise<{ changed: boolean; cursor: string }> {
    const { repo, number } = parseGitHubRef(effort.id)
    const etags: Record<string, string> = cursor ? JSON.parse(cursor) : {}
    const paths = {
      map: `repos/${repo}/issues/${number}`,
      children: `repos/${repo}/issues/${number}/sub_issues?per_page=100`,
    }
    let changed = false
    for (const [key, path] of Object.entries(paths)) {
      const result = await this.conditionalGet(path, etags[key])
      if (result.changed) changed = true
      if (result.etag) etags[key] = result.etag
    }
    return { changed, cursor: JSON.stringify(etags) }
  }

  private async conditionalGet(
    path: string,
    etag?: string,
  ): Promise<{ changed: boolean; etag?: string }> {
    const args = ['api', '-i', path]
    if (etag) args.push('-H', `If-None-Match: ${etag}`)
    try {
      const out = await this.run(args)
      const nextEtag = /^etag:\s*(\S+)/im.exec(out)?.[1]
      return { changed: true, etag: nextEtag }
    } catch (err) {
      if (isHttpStatus(err, 304)) return { changed: false, etag }
      throw err
    }
  }

  // -- internals -------------------------------------------------------------

  private async subIssues(effort: TicketRef): Promise<GhIssuePayload[]> {
    const { repo, number } = parseGitHubRef(effort.id)
    const all: GhIssuePayload[] = []
    for (let page = 1; ; page++) {
      const out = await this.run([
        'api',
        `repos/${repo}/issues/${number}/sub_issues?per_page=100&page=${page}`,
      ])
      const batch = JSON.parse(out) as GhIssuePayload[]
      all.push(...batch)
      if (batch.length < 100) return all
    }
  }

  private ensuredLabels = new Set<string>()

  private async ensureLabel(repo: string, label: string): Promise<void> {
    const key = `${repo}:${label}`
    if (this.ensuredLabels.has(key)) return
    try {
      await this.run([
        'api',
        '--method',
        'POST',
        `repos/${repo}/labels`,
        '-f',
        `name=${label}`,
        '-f',
        'color=5319E7',
      ])
    } catch (err) {
      if (!isHttpStatus(err, 422)) throw err // 422 = already exists
    }
    this.ensuredLabels.add(key)
  }
}

function toRef(issue: GhIssuePayload): TicketRef {
  return mintGitHubRef(repoFromUrl(issue.repository_url), issue.number, issue.html_url)
}

function repoFromUrl(repositoryUrl: string): string {
  return repositoryUrl.replace(/^.*?\/repos\//, '')
}

function matchesNamespace(issue: GhIssuePayload, ns?: LabelNamespace): boolean {
  if (!ns) return true
  return issue.labels.some((l) => inNamespace(l.name, ns))
}

/** `gh` surfaces non-2xx as an error whose message carries `HTTP <status>`. */
function isHttpStatus(err: unknown, status: number): boolean {
  const text = err instanceof Error ? `${err.message}\n${(err as { stderr?: string }).stderr ?? ''}` : String(err)
  return new RegExp(`HTTP ${status}\\b`).test(text)
}
