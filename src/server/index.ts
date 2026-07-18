import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { ClaudeCodeAdapter } from '../adapters/index.js'
import type { GhExec } from '../gating/index.js'
import type { Exec } from '../pipeline/git.js'
import { PipelineOrchestrator } from '../pipeline/orchestrator.js'
import { listEfforts } from './efforts.js'
import { createPipelineApp, type OverrideContext } from './pipeline-routes.js'
import { SessionRegistry } from './registry.js'
import { createSetupApp, type SetupRouteDeps } from './setup-routes.js'
import { createStageService, createTrackerContext, trackerWhoami, type StageService, type TrackerContext } from './stage.js'
import { TranscriptStore } from './transcripts.js'
import { createConnection } from './ws.js'
import { discoverWorkspace, type Workspace } from './workspace.js'

export const DEFAULT_PORT = 4664

export { threadmapHome, transcriptsDir } from './home.js'
export { listEfforts, type EffortSummary } from './efforts.js'
export { SessionRegistry, RegistryError, type StartSessionOptions } from './registry.js'
export { TranscriptStore, type SessionMeta, type TranscriptEvent } from './transcripts.js'
export { createConnection, type ClientMessage, type ServerMessage } from './ws.js'
export { discoverWorkspace, type RepoInfo, type Workspace } from './workspace.js'
export { createStageService, createTrackerContext, loadTrackerConfig, trackerWhoami, type StageService, type TrackerConfig, type TrackerContext } from './stage.js'
export { createSetupApp, type SetupRouteDeps } from './setup-routes.js'
export { createPipelineApp, type OverrideContext, type PipelineRouteDeps } from './pipeline-routes.js'
export {
  PipelineOrchestrator,
  type CleanupResult,
  type CompleteResult,
  type LandResult,
  type OrchestratorDeps,
} from '../pipeline/orchestrator.js'

export interface AppDeps {
  workspace: Workspace
  registry: SessionRegistry
  store: TranscriptStore
  /** Injectable for tests; defaults to the real `gh` CLI. */
  ghExec?: GhExec
  /** Injectable for tests; defaults to a tracker-config-driven service. */
  stageService?: StageService
  /** Injectable for tests; defaults to a tracker-config-driven orchestrator. */
  orchestrator?: PipelineOrchestrator
  /** Git exec for the orchestrator (tests); defaults to the real CLI. */
  exec?: Exec
  /** Overrides for the setup routes' external effects (tests). */
  setupDeps?: Partial<SetupRouteDeps>
}

export function createApp(deps: AppDeps) {
  const { workspace, registry, store, ghExec } = deps
  // Built lazily on first /api/stage hit — tracker config + repo resolution
  // need I/O, and createApp stays synchronous.
  let stagePromise: Promise<StageService> | undefined
  const stageService = () =>
    (stagePromise ??= deps.stageService
      ? Promise.resolve(deps.stageService)
      : createStageService(workspace, ghExec ? { ghExec } : {}))
  // One tracker context feeds both the orchestrator and the override routes.
  let ctxPromise: Promise<TrackerContext> | undefined
  const trackerContext = () =>
    (ctxPromise ??= createTrackerContext(workspace, ghExec ? { ghExec } : {}))
  let orchestratorPromise: Promise<PipelineOrchestrator> | undefined
  const orchestrator = () =>
    (orchestratorPromise ??= deps.orchestrator
      ? Promise.resolve(deps.orchestrator)
      : trackerContext().then(
          (ctx) =>
            new PipelineOrchestrator({
              workspace,
              registry,
              tracker: ctx.deps.tracker,
              prSource: ctx.deps.prSource,
              resolveRepoDir: ctx.deps.resolveRepoDir,
              mintEffortRef: ctx.mintEffortRef,
              ...(deps.exec ? { exec: deps.exec } : {}),
            }),
        ))
  // Override write path (#40): same tracker context + the stage service's
  // snapshot/cache, so the stamp is visible on the very next /api/stage pull.
  const overrides = async (): Promise<OverrideContext> => {
    const [ctx, stage] = await Promise.all([trackerContext(), stageService()])
    return {
      tracker: ctx.deps.tracker,
      mintEffortRef: ctx.mintEffortRef,
      snapshot: (effortId) => stage.snapshot(effortId),
      invalidate: (effortId) => stage.invalidate(effortId),
      whoami: () => trackerWhoami(workspace.root, ghExec),
    }
  }
  // Worktrees of merged ticket PRs auto-remove (#11); the UI polls /api/stage,
  // so a throttled fire-and-forget sweep there is the merge-reaction hook.
  const lastCleanup = new Map<string, number>()
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  app.get('/api/health', (c) => c.json({ ok: true, name: 'threadmap' }))
  app.route('/api/setup', createSetupApp({ workspace, ...deps.setupDeps }))
  app.get('/api/workspace', (c) => c.json(workspace))
  app.get('/api/efforts', async (c) =>
    c.json(await listEfforts(workspace.repos, ghExec, {
      includeClosed: c.req.query('state') === 'all',
    })),
  )
  app.get('/api/stage', async (c) => {
    const effort = c.req.query('effort')
    if (!effort) return c.json({ error: 'missing ?effort=<ref-id>' }, 400)
    try {
      const snapshot = await (await stageService()).snapshot(effort)
      if (Date.now() - (lastCleanup.get(effort) ?? 0) > 60_000) {
        lastCleanup.set(effort, Date.now())
        void orchestrator()
          .then((o) => o.cleanupMerged(effort))
          .catch(() => {})
      }
      return c.json(snapshot)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })
  app.route('/api/pipeline', createPipelineApp({ orchestrator, overrides }))
  app.get('/api/sessions', async (c) => c.json(await registry.list()))
  app.get('/api/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const meta = registry.get(id) ?? (await store.readMeta(id))
    return meta ? c.json(meta) : c.json({ error: 'unknown session' }, 404)
  })
  app.get('/api/sessions/:id/transcript', async (c) =>
    c.json(await store.readEvents(c.req.param('id'))),
  )

  app.get(
    '/ws',
    upgradeWebSocket(() => {
      let connection: ReturnType<typeof createConnection> | undefined
      return {
        onOpen(_event, ws) {
          connection = createConnection(registry, (msg) => ws.send(JSON.stringify(msg)))
        },
        onMessage(event, _ws) {
          void connection?.onMessage(String(event.data))
        },
        onClose() {
          connection?.close()
        },
      }
    }),
  )

  return { app, injectWebSocket }
}

export async function startServer(port = DEFAULT_PORT, root = process.cwd()) {
  const workspace = await discoverWorkspace(root)
  const store = new TranscriptStore()
  const registry = new SessionRegistry({ 'claude-code': new ClaudeCodeAdapter() }, store)
  const { app, injectWebSocket } = createApp({ workspace, registry, store })

  // dist layout: dist/server.js next to dist/ui/
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), 'ui')
  app.use('/assets/*', serveStatic({ root: uiDir }))
  app.get('*', async (c) => {
    const html = await readFile(join(uiDir, 'index.html'), 'utf8').catch(() => null)
    if (html === null) return c.text('threadmap: UI assets not found — run the build first', 500)
    return c.html(html)
  })

  const server = serve({ fetch: app.fetch, port })
  injectWebSocket(server)
  const shutdown = () => {
    registry.killAll()
    server.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.log(
    `threadmap listening on http://localhost:${port} — workspace ${root} (${workspace.repos.length} repo${workspace.repos.length === 1 ? '' : 's'})`,
  )
  return server
}
