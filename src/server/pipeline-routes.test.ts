import { describe, expect, it } from 'vitest'
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js'
import { createPipelineApp, type OverrideContext } from './pipeline-routes.js'

function appWith(orchestrator: Partial<PipelineOrchestrator>, overrides?: Partial<OverrideContext>) {
  return createPipelineApp({
    orchestrator: async () => orchestrator as PipelineOrchestrator,
    overrides: async () => overrides as OverrideContext,
  })
}

/** Override context over a recording fake tracker. */
function fakeOverrides() {
  const comments: string[] = []
  const stamps: string[] = []
  const unstamps: string[] = []
  const invalidated: string[] = []
  const ctx: Partial<OverrideContext> = {
    tracker: {
      comment: async (_ref: unknown, md: string) => void comments.push(md),
      stamp: async (_ref: unknown, name: string) => void stamps.push(name),
      unstamp: async (_ref: unknown, name: string) => void unstamps.push(name),
    } as never,
    mintEffortRef: (id) => ({ id, display: id, url: '' }),
    snapshot: async () =>
      ({
        stage: 'to-spec',
        gates: [{ stage: 'to-spec', met: false, overridden: false, unmet: ['no closed spec sub-issue'] }],
        tickets: [],
        readyToComplete: false,
        warnings: [],
      }) as never,
    invalidate: (effortId) => void invalidated.push(effortId),
    whoami: async () => 'geemeows',
  }
  return { ctx, comments, stamps, unstamps, invalidated }
}

const post = (app: ReturnType<typeof createPipelineApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('pipeline routes', () => {
  it('starts an implement session and returns its meta', async () => {
    const calls: string[][] = []
    const app = appWith({
      startImplement: async (effort: string, ticket: string) => {
        calls.push([effort, ticket])
        return { id: 's1', status: 'running' } as never
      },
    })
    const res = await post(app, '/implement', { effort: 'o/home#1', ticket: 'o/web#42' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 's1', status: 'running' })
    expect(calls).toEqual([['o/home#1', 'o/web#42']])
  })

  it('starts a review session and returns its meta (#52)', async () => {
    const calls: string[][] = []
    const app = appWith({
      startReview: async (effort: string, ticket: string) => {
        calls.push([effort, ticket])
        return { id: 's2', status: 'running' } as never
      },
    })
    const res = await post(app, '/review', { effort: 'o/home#1', ticket: 'o/web#42' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 's2', status: 'running' })
    expect(calls).toEqual([['o/home#1', 'o/web#42']])
  })

  it('400s on missing parameters', async () => {
    const app = appWith({})
    expect((await post(app, '/implement', { effort: 'o/home#1' })).status).toBe(400)
    expect((await post(app, '/review', { ticket: 'o/web#42' })).status).toBe(400)
    expect((await post(app, '/reconcile', {})).status).toBe(400)
    expect((await post(app, '/land', {})).status).toBe(400)
    expect((await post(app, '/cleanup', {})).status).toBe(400)
    expect((await post(app, '/complete', {})).status).toBe(400)
  })

  it('502s with the orchestrator error message', async () => {
    const app = appWith({
      land: async () => {
        throw new Error('trunk exploded')
      },
    })
    const res = await post(app, '/land', { effort: 'o/home#1' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'trunk exploded' })
  })

  it('passes force through to completeEffort', async () => {
    const seen: unknown[] = []
    const app = appWith({
      completeEffort: async (_effort: string, opts: unknown) => {
        seen.push(opts)
        return { results: [], mapClosed: true }
      },
    })
    await post(app, '/complete', { effort: 'o/home#1', force: true })
    expect(seen).toEqual([{ force: true }])
  })

  it('applies an override: audit comment first, then the stamp, then cache invalidation', async () => {
    const { ctx, comments, stamps, invalidated } = fakeOverrides()
    const app = appWith({}, ctx)
    const res = await post(app, '/override', { effort: 'o/home#1', stage: 'to-spec', reason: 'demo cut' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ overridden: true })
    expect(stamps).toEqual(['override:to-spec'])
    expect(comments[0]).toContain('## Override: to-spec')
    expect(comments[0]).toContain('- **Who**: geemeows')
    expect(comments[0]).toContain('no closed spec sub-issue')
    expect(comments[0]).toContain('- **Reason**: demo cut')
    expect(invalidated).toEqual(['o/home#1'])
  })

  it('rejects an override without a reason or with an unknown stage', async () => {
    const { ctx, stamps } = fakeOverrides()
    const app = appWith({}, ctx)
    expect((await post(app, '/override', { effort: 'o/home#1', stage: 'to-spec' })).status).toBe(400)
    expect((await post(app, '/override', { effort: 'o/home#1', stage: 'to-spec', reason: '  ' })).status).toBe(400)
    expect((await post(app, '/override', { effort: 'o/home#1', stage: 'setup', reason: 'x' })).status).toBe(400)
    expect((await post(app, '/override', { stage: 'to-spec', reason: 'x' })).status).toBe(400)
    expect(stamps).toEqual([])
  })

  it('revokes an override: audit comment plus unstamp', async () => {
    const { ctx, comments, unstamps, invalidated } = fakeOverrides()
    const app = appWith({}, ctx)
    const res = await post(app, '/override/revoke', { effort: 'o/home#1', stage: 'to-spec' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: true })
    expect(unstamps).toEqual(['override:to-spec'])
    expect(comments[0]).toContain('## Override revoked: to-spec')
    expect(invalidated).toEqual(['o/home#1'])
  })

  it('502s with the tracker error message on a failed override write', async () => {
    const { ctx } = fakeOverrides()
    ctx.tracker = {
      comment: async () => {
        throw new Error('gh exploded')
      },
    } as never
    const app = appWith({}, ctx)
    const res = await post(app, '/override', { effort: 'o/home#1', stage: 'to-spec', reason: 'x' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'gh exploded' })
  })
})
