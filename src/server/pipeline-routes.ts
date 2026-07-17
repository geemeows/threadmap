// REST surface for the implement pipeline (#30). Every route is a thin
// binding over the PipelineOrchestrator; the sessions it starts stream over
// the normal WS channel like any other session — these routes only trigger
// them and report git/PR side effects.

import { Hono } from 'hono'
import { STAGES, applyOverride, revokeOverride, type Stage, type StageSnapshot } from '../gating/index.js'
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js'
import type { TicketRef, TrackerAdapter } from '../tracker/types.js'

/** What the override routes need (#40): the #6 write path plus snapshot access for the audit trail. */
export interface OverrideContext {
  tracker: TrackerAdapter
  mintEffortRef: (id: string) => TicketRef
  /** Current gate state — the audit comment records the conditions unmet at override time. */
  snapshot: (effortId: string) => Promise<StageSnapshot>
  /** Drop the cached snapshot so the UI's refresh sees the stamp immediately. */
  invalidate: (effortId: string) => void
  /** Tracker-side identity for the audit comment's Who line. */
  whoami: () => Promise<string>
}

export interface PipelineRouteDeps {
  /** Lazy: tracker config + repo resolution need I/O, route creation doesn't. */
  orchestrator: () => Promise<PipelineOrchestrator>
  overrides: () => Promise<OverrideContext>
}

export function createPipelineApp(deps: PipelineRouteDeps): Hono {
  const app = new Hono()

  const body = async (c: { req: { json(): Promise<unknown> } }) =>
    (await c.req.json().catch(() => ({}))) as {
      effort?: string
      ticket?: string
      force?: boolean
      stage?: string
      reason?: string
    }

  app.post('/implement', async (c) => {
    const { effort, ticket } = await body(c)
    if (!effort || !ticket) return c.json({ error: 'missing effort or ticket' }, 400)
    try {
      return c.json(await (await deps.orchestrator()).startImplement(effort, ticket))
    } catch (err) {
      return c.json({ error: message(err) }, 502)
    }
  })

  app.post('/review', async (c) => {
    const { effort, ticket } = await body(c)
    if (!effort || !ticket) return c.json({ error: 'missing effort or ticket' }, 400)
    try {
      return c.json(await (await deps.orchestrator()).startReview(effort, ticket))
    } catch (err) {
      return c.json({ error: message(err) }, 502)
    }
  })

  app.post('/reconcile', async (c) => {
    const { effort, ticket } = await body(c)
    if (!effort || !ticket) return c.json({ error: 'missing effort or ticket' }, 400)
    try {
      return c.json(await (await deps.orchestrator()).startReconcile(effort, ticket))
    } catch (err) {
      return c.json({ error: message(err) }, 502)
    }
  })

  app.post('/land', async (c) => {
    const { effort } = await body(c)
    if (!effort) return c.json({ error: 'missing effort' }, 400)
    try {
      return c.json({ results: await (await deps.orchestrator()).land(effort) })
    } catch (err) {
      return c.json({ error: message(err) }, 502)
    }
  })

  app.post('/cleanup', async (c) => {
    const { effort } = await body(c)
    if (!effort) return c.json({ error: 'missing effort' }, 400)
    try {
      return c.json({ results: await (await deps.orchestrator()).cleanupMerged(effort) })
    } catch (err) {
      return c.json({ error: message(err) }, 502)
    }
  })

  app.post('/complete', async (c) => {
    const { effort, force } = await body(c)
    if (!effort) return c.json({ error: 'missing effort' }, 400)
    try {
      return c.json(await (await deps.orchestrator()).completeEffort(effort, { force: force ?? false }))
    } catch (err) {
      return c.json({ error: message(err) }, 502)
    }
  })

  // Gate override (#6/#40): audit comment first, then the stamp — reason required.
  app.post('/override', async (c) => {
    const { effort, stage, reason } = await body(c)
    if (!effort || !isStage(stage)) return c.json({ error: 'missing effort or invalid stage' }, 400)
    if (!reason?.trim()) return c.json({ error: 'an override requires a reason' }, 400)
    try {
      const ctx = await deps.overrides()
      const gate = (await ctx.snapshot(effort)).gates.find((g) => g.stage === stage)
      await applyOverride(ctx.tracker, ctx.mintEffortRef(effort), stage, {
        who: await ctx.whoami(),
        when: new Date().toISOString(),
        unmetConditions: gate?.unmet ?? [],
        reason,
      })
      ctx.invalidate(effort)
      return c.json({ overridden: true })
    } catch (err) {
      return c.json({ error: message(err) }, 502)
    }
  })

  app.post('/override/revoke', async (c) => {
    const { effort, stage } = await body(c)
    if (!effort || !isStage(stage)) return c.json({ error: 'missing effort or invalid stage' }, 400)
    try {
      const ctx = await deps.overrides()
      await revokeOverride(ctx.tracker, ctx.mintEffortRef(effort), stage, await ctx.whoami(), new Date().toISOString())
      ctx.invalidate(effort)
      return c.json({ revoked: true })
    } catch (err) {
      return c.json({ error: message(err) }, 502)
    }
  })

  return app
}

function isStage(value: string | undefined): value is Stage {
  return (STAGES as readonly string[]).includes(value ?? '')
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
