// threadmap-tracker MCP server (#19 §7): the one write path agent sessions
// get in Linear workspaces, injected via `StartOptions.mcpConfig` and backed
// by the same LinearAdapter the gating engine uses — so gate semantics
// (approved-close, stamp spelling, blocking direction) hold no matter who
// writes. GitHub workspaces don't use this; sessions keep `gh`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { TicketRef } from './types.js'
import type { LinearAdapter } from './linear.js'
import type { LinearClient } from './linear-client.js'

/** Tools take bare issue ids; the adapter wants refs. Display/url are cosmetic. */
const asRef = (id: string): TicketRef => ({ id, display: id, url: '' })

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

export interface TrackerMcpDeps {
  adapter: LinearAdapter
  client: LinearClient
  /**
   * The bound session's pipeline stage. When set, create_issue enforces which
   * artifacts that stage may mint (below), so pipeline ordering holds at the one
   * write path no matter who writes (mirrors the derived gates, ADR-0002).
   * Absent → no restriction (the server was launched without stage context).
   */
  stage?: string
}

/**
 * Reject out-of-stage issue creation. Labels arrive as logical names ('ticket',
 * 'spec', 'wayfinder:grilling'). Stages absent from the switch impose no rule.
 * Throws a message the agent can act on; the MCP layer surfaces it as a tool error.
 */
export function assertCreatable(stage: string | undefined, labels: string[]): void {
  const has = (logical: string) => labels.includes(logical)
  const hasWayfinder = labels.some((l) => l.startsWith('wayfinder:'))
  switch (stage) {
    case 'planning':
      // /wayfinder produces planning decisions only. Implementation tickets and
      // the spec are born downstream (/to-tickets, /to-spec) after the human
      // "ticketed" sign-off — never in the map (ADR-0002).
      if (has('ticket') || has('spec') || !hasWayfinder)
        throw new Error(
          `A planning (/wayfinder) session may only create wayfinder:* children on the map — ` +
            `not implementation tickets (threadmap:ticket) or the spec (threadmap:spec). ` +
            `Let the effort flow to /to-spec and /to-tickets instead of doing the work in the map.`,
        )
      break
    case 'to-spec':
      if (has('ticket'))
        throw new Error(
          `A /to-spec session creates the spec, not implementation tickets — those come from /to-tickets.`,
        )
      break
    case 'to-tickets':
      if (has('spec'))
        throw new Error(`A /to-tickets session creates implementation tickets, not the spec.`)
      break
  }
}

export function createTrackerMcpServer({ adapter, client, stage }: TrackerMcpDeps): McpServer {
  const server = new McpServer({ name: 'threadmap-tracker', version: '0.1.0' })

  server.registerTool(
    'view_issue',
    {
      description:
        'Read one Linear issue: title, body, state, labels, comments, and children. Accepts the issue UUID or its identifier (e.g. FE-123).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await client.query<{ issue: unknown }>(
        `query($id: String!) { issue(id: $id) {
          id identifier title description url
          state { name type } assignee { name }
          labels { nodes { name } }
          comments { nodes { body createdAt user { name } } }
          children { nodes { id identifier title state { type } } }
          parent { id identifier title }
        } }`,
        { id },
      )
      return text(data.issue)
    },
  )

  server.registerTool(
    'list_children',
    {
      description:
        'List child issues of an effort (map issue), open and closed, with state. Optional namespace filter: "wayfinder" (planning children) or "ticket" (threadmap:ticket children).',
      inputSchema: {
        effortId: z.string(),
        namespace: z.enum(['wayfinder', 'ticket']).optional(),
      },
    },
    async ({ effortId, namespace }) => text(await adapter.children(asRef(effortId), namespace)),
  )

  server.registerTool(
    'frontier',
    {
      description: 'Open, unblocked, unassigned children of an effort — the takeable tickets, in order.',
      inputSchema: { effortId: z.string() },
    },
    async ({ effortId }) => text(await adapter.frontier(asRef(effortId))),
  )

  server.registerTool(
    'create_issue',
    {
      description:
        'Create a child issue under a parent, routed to a team. Labels are logical names (e.g. "ticket", "spec", "wayfinder:grilling") — spelling is handled for you.',
      inputSchema: {
        parentId: z.string(),
        teamId: z.string().describe('Routing target team UUID (see routing_targets)'),
        title: z.string(),
        body: z.string(),
        labels: z.array(z.string()).optional(),
      },
    },
    async ({ parentId, teamId, title, body, labels }) => {
      assertCreatable(stage, labels ?? [])
      return text(
        await adapter.createChild(asRef(parentId), {
          title,
          body,
          target: { id: teamId, display: teamId },
          ...(labels ? { labels } : {}),
        }),
      )
    },
  )

  server.registerTool(
    'routing_targets',
    {
      description: 'List the teams new issues can be routed to (id + team key).',
      inputSchema: {},
    },
    async () => text(await adapter.routingTargets()),
  )

  server.registerTool(
    'add_blocked_by',
    {
      description: 'Mark an issue as blocked by another (native blocking relation).',
      inputSchema: { id: z.string(), blockerId: z.string() },
    },
    async ({ id, blockerId }) => {
      await adapter.addBlockedBy(asRef(id), asRef(blockerId))
      return text('blocked-by relation created')
    },
  )

  server.registerTool(
    'comment',
    {
      description: 'Post a markdown comment on an issue.',
      inputSchema: { id: z.string(), body: z.string() },
    },
    async ({ id, body }) => {
      await adapter.comment(asRef(id), body)
      return text('comment posted')
    },
  )

  server.registerTool(
    'resolve_issue',
    {
      description:
        'Close an issue: outcome "done" (completed — counts as approval where gates require it) or "wontfix" (canceled). Optionally posts a resolution comment first.',
      inputSchema: {
        id: z.string(),
        outcome: z.enum(['done', 'wontfix']),
        comment: z.string().optional(),
      },
    },
    async ({ id, outcome, comment }) => {
      await adapter.resolve(asRef(id), outcome, comment)
      return text(`issue resolved (${outcome})`)
    },
  )

  server.registerTool(
    'stamp',
    {
      description: 'Apply a logical stamp label (e.g. "ticketed", "override:implement") to an issue.',
      inputSchema: { id: z.string(), name: z.string() },
    },
    async ({ id, name }) => {
      await adapter.stamp(asRef(id), name)
      return text('stamped')
    },
  )

  server.registerTool(
    'unstamp',
    {
      description: 'Remove a logical stamp label from an issue.',
      inputSchema: { id: z.string(), name: z.string() },
    },
    async ({ id, name }) => {
      await adapter.unstamp(asRef(id), name)
      return text('unstamped')
    },
  )

  server.registerTool(
    'attach_pr',
    {
      description: 'Attach a pull-request URL to an issue so it shows in Linear.',
      inputSchema: { id: z.string(), prUrl: z.string() },
    },
    async ({ id, prUrl }) => {
      await adapter.attachPR(asRef(id), prUrl)
      return text('PR attached')
    },
  )

  return server
}

/** Entry point for `threadmap tracker-mcp` — stdio transport, per mcpConfig injection. */
export async function runTrackerMcpServer(deps: TrackerMcpDeps): Promise<void> {
  const server = createTrackerMcpServer(deps)
  await server.connect(new StdioServerTransport())
}
