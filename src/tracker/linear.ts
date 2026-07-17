// LinearAdapter — the TrackerAdapter seam (#19) over Linear GraphQL, per the
// verified findings in docs/research/linear-api.md (§10):
//   - identity is the issue UUID; `ENG-123` is display-only (mutates on team moves)
//   - server-side IssueFilter answers the gate questions in one call each;
//     `hasBlockedByRelations: {eq: false}` IS the unblocked predicate
//   - "closed" is a per-team stateId resolved from the issue's own team, in
//     two flavors: completed (done) vs canceled (wontfix)
//   - labels keep the literal `threadline:*`/`wayfinder:*` spelling (colons
//     are API-safe) as workspace-level flat labels, API-created
//   - approval: completed ⇒ 'approved'. Setup disables team auto-close
//     automations (#20 §10.4), so no synchronous actor check — the laggy
//     `history` botActor audit is a background concern, not a gate predicate.
//   - polling is an updatedAt-watermark delta query; never free, so
//     capabilities pace the loop slow

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
import { SPEC_LABEL, TICKET_LABEL, WAYFINDER_PREFIX, logicalName, spellLabel } from './labels.js'
import type { LinearClient } from './linear-client.js'

interface LinearIssueNode {
  id: string
  identifier: string
  url: string
  updatedAt: string
  state: { type: string }
  assignee: { id: string } | null
  labels: { nodes: { name: string }[] }
}

const ISSUE_FIELDS =
  'id identifier url updatedAt state { type } assignee { id } labels { nodes { name } }'

const namespaceFilter = (ns?: LabelNamespace) =>
  ns === 'wayfinder'
    ? { labels: { name: { startsWith: WAYFINDER_PREFIX } } }
    : ns === 'ticket'
      ? { labels: { name: { eq: TICKET_LABEL } } }
      : {}

const OPEN_STATE = { state: { type: { nin: ['completed', 'canceled'] } } }

export interface LinearAdapterOptions {
  client: LinearClient
  /** Routing targets: id = team UUID, display = team key. Queried live when omitted. */
  targets?: RoutingTarget[]
}

export class LinearAdapter implements TrackerAdapter {
  readonly name = 'linear'
  readonly capabilities: TrackerCapabilities = { minPollIntervalMs: 30_000, freePolling: false }
  private client: LinearClient
  private staticTargets?: RoutingTarget[]

  constructor(opts: LinearAdapterOptions) {
    this.client = opts.client
    this.staticTargets = opts.targets
  }

  // -- reads ---------------------------------------------------------------

  async openChildren(effort: TicketRef, labelNs?: LabelNamespace): Promise<TicketRef[]> {
    const nodes = await this.issues({
      parent: { id: { eq: effort.id } },
      ...OPEN_STATE,
      ...namespaceFilter(labelNs),
    })
    return nodes.map(toRef)
  }

  async children(effort: TicketRef, labelNs?: LabelNamespace): Promise<ChildTicket[]> {
    const nodes = await this.issues({
      parent: { id: { eq: effort.id } },
      ...namespaceFilter(labelNs),
    })
    return nodes.map((n) => ({ ref: toRef(n), state: isClosed(n) ? 'closed' as const : 'open' as const }))
  }

  async frontier(effort: TicketRef): Promise<TicketRef[]> {
    // Open ∧ unblocked ∧ unassigned, entirely server-side (§10.2).
    const nodes = await this.issues({
      parent: { id: { eq: effort.id } },
      ...OPEN_STATE,
      assignee: { null: true },
      hasBlockedByRelations: { eq: false },
    })
    return nodes.map(toRef)
  }

  async specStatus(effort: TicketRef): Promise<SpecStatus> {
    const specs = await this.issues({
      parent: { id: { eq: effort.id } },
      labels: { name: { eq: SPEC_LABEL } },
    })
    if (specs.length === 0) return 'none'
    // completed ⇒ approved: setup disables auto-close automations, so a
    // completed state is a human act (#20 §10.4 amending #19 §4).
    if (specs.some((s) => s.state.type === 'completed')) return 'approved'
    if (specs.every((s) => s.state.type === 'canceled')) return 'none'
    return 'open'
  }

  async mapStamps(effort: TicketRef): Promise<string[]> {
    const data = await this.client.query<{
      issue: { labels: { nodes: { name: string }[] } }
    }>(`query($id: String!) { issue(id: $id) { labels { nodes { name } } } }`, { id: effort.id })
    return data.issue.labels.nodes
      .map((l) => logicalName(l.name))
      .filter((n): n is string => n !== null)
  }

  async ticketTarget(ref: TicketRef): Promise<RoutingTarget> {
    const data = await this.client.query<{ issue: { team: { id: string; key: string } } }>(
      `query($id: String!) { issue(id: $id) { team { id key } } }`,
      { id: ref.id },
    )
    return { id: data.issue.team.id, display: data.issue.team.key }
  }

  async routingTargets(): Promise<RoutingTarget[]> {
    if (this.staticTargets) return this.staticTargets
    const data = await this.client.query<{ teams: { nodes: { id: string; key: string }[] } }>(
      `query { teams(first: 100) { nodes { id key } } }`,
    )
    return data.teams.nodes.map((t) => ({ id: t.id, display: t.key }))
  }

  // -- writes --------------------------------------------------------------

  async createChild(parent: TicketRef, opts: CreateOpts): Promise<TicketRef> {
    const labelIds = await Promise.all((opts.labels ?? []).map((l) => this.ensureLabel(spellLabel(l))))
    const data = await this.client.query<{
      issueCreate: { issue: { id: string; identifier: string; url: string } }
    }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id identifier url } }
      }`,
      {
        input: {
          teamId: opts.target.id,
          parentId: parent.id,
          title: opts.title,
          description: opts.body,
          labelIds,
        },
      },
    )
    const issue = data.issueCreate.issue
    return { id: issue.id, display: issue.identifier, url: issue.url }
  }

  async addBlockedBy(ref: TicketRef, blocker: TicketRef): Promise<void> {
    // Direction: `issue` blocks `relatedIssue` (§2).
    await this.client.query(
      `mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`,
      { input: { issueId: blocker.id, relatedIssueId: ref.id, type: 'blocks' } },
    )
  }

  async comment(ref: TicketRef, markdown: string): Promise<void> {
    await this.client.query(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: ref.id, body: markdown } },
    )
  }

  async stamp(ref: TicketRef, name: string): Promise<void> {
    const labelId = await this.ensureLabel(spellLabel(name))
    await this.client.query(
      `mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }`,
      { id: ref.id, labelId },
    )
  }

  async unstamp(ref: TicketRef, name: string): Promise<void> {
    const labelId = await this.findLabel(spellLabel(name))
    if (!labelId) return // never created ⇒ nothing stamped — idempotent
    await this.client.query(
      `mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }`,
      { id: ref.id, labelId },
    )
  }

  async resolve(ref: TicketRef, outcome: 'done' | 'wontfix', comment?: string): Promise<void> {
    if (comment) await this.comment(ref, comment)
    // stateIds are strictly per-team (§9.10): resolve from the issue's own team, every time.
    const stateId = await this.resolveStateId(ref, outcome === 'done' ? 'completed' : 'canceled')
    await this.client.query(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: ref.id, input: { stateId } },
    )
  }

  async attachPR(ref: TicketRef, prUrl: string): Promise<void> {
    await this.client.query(
      `mutation($input: AttachmentLinkURLInput!) { attachmentLinkURL(input: $input) { success } }`,
      { input: { issueId: ref.id, url: prUrl } },
    )
  }

  // -- change detection ------------------------------------------------------

  /**
   * Cursor = ISO updatedAt watermark over the effort and its children. Every
   * poll costs quota (no ETag equivalent, §6) — capabilities pace the loop.
   */
  async changesSince(
    effort: TicketRef,
    cursor?: string,
  ): Promise<{ changed: boolean; cursor: string }> {
    const scope = { or: [{ id: { eq: effort.id } }, { parent: { id: { eq: effort.id } } }] }
    const filter = cursor ? { ...scope, updatedAt: { gt: cursor } } : scope
    const data = await this.client.query<{
      issues: { nodes: { updatedAt: string }[] }
    }>(`query($filter: IssueFilter!) { issues(filter: $filter, first: 100) { nodes { updatedAt } } }`, {
      filter,
    })
    const stamps = data.issues.nodes.map((n) => n.updatedAt)
    const max = stamps.reduce((a, b) => (a > b ? a : b), cursor ?? new Date(0).toISOString())
    return { changed: cursor ? stamps.length > 0 : true, cursor: max }
  }

  // -- internals -------------------------------------------------------------

  private async issues(filter: Record<string, unknown>): Promise<LinearIssueNode[]> {
    const data = await this.client.query<{ issues: { nodes: LinearIssueNode[] } }>(
      `query($filter: IssueFilter!) { issues(filter: $filter, first: 100) { nodes { ${ISSUE_FIELDS} } } }`,
      { filter },
    )
    return data.issues.nodes
  }

  private labelIds = new Map<string, string>()

  private async findLabel(name: string): Promise<string | null> {
    const cached = this.labelIds.get(name)
    if (cached) return cached
    const data = await this.client.query<{ issueLabels: { nodes: { id: string }[] } }>(
      `query($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id } } }`,
      { name },
    )
    const id = data.issueLabels.nodes[0]?.id ?? null
    if (id) this.labelIds.set(name, id)
    return id
  }

  /** Vocabulary labels must be API-created — UI creation group-splits on `:` (§10.1). */
  private async ensureLabel(name: string): Promise<string> {
    const existing = await this.findLabel(name)
    if (existing) return existing
    const data = await this.client.query<{ issueLabelCreate: { issueLabel: { id: string } } }>(
      `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
      { input: { name } }, // no teamId ⇒ workspace-level, visible to every routed team (§3)
    )
    const id = data.issueLabelCreate.issueLabel.id
    this.labelIds.set(name, id)
    return id
  }

  private async resolveStateId(
    ref: TicketRef,
    type: 'completed' | 'canceled',
  ): Promise<string> {
    const data = await this.client.query<{
      issue: { team: { states: { nodes: { id: string; type: string; position: number }[] } } }
    }>(
      `query($id: String!) { issue(id: $id) { team { states { nodes { id type position } } } } }`,
      { id: ref.id },
    )
    const candidates = data.issue.team.states.nodes
      .filter((s) => s.type === type)
      .sort((a, b) => a.position - b.position)
    const state = candidates[0]
    if (!state) throw new Error(`issue ${ref.display}: owning team has no '${type}' workflow state`)
    return state.id
  }
}

function toRef(node: LinearIssueNode): TicketRef {
  return { id: node.id, display: node.identifier, url: node.url }
}

function isClosed(node: LinearIssueNode): boolean {
  return node.state.type === 'completed' || node.state.type === 'canceled'
}
