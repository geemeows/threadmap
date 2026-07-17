import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { ClaudeCodeAdapter } from '../adapters/index.js'
import type { GhExec } from '../gating/index.js'
import { listEfforts } from './efforts.js'
import { SessionRegistry } from './registry.js'
import { TranscriptStore } from './transcripts.js'
import { createConnection } from './ws.js'
import { discoverWorkspace, type Workspace } from './workspace.js'

export const DEFAULT_PORT = 4664

export { threadlineHome, transcriptsDir } from './home.js'
export { listEfforts, type EffortSummary } from './efforts.js'
export { SessionRegistry, RegistryError, type StartSessionOptions } from './registry.js'
export { TranscriptStore, type SessionMeta, type TranscriptEvent } from './transcripts.js'
export { createConnection, type ClientMessage, type ServerMessage } from './ws.js'
export { discoverWorkspace, type RepoInfo, type Workspace } from './workspace.js'

export interface AppDeps {
  workspace: Workspace
  registry: SessionRegistry
  store: TranscriptStore
  /** Injectable for tests; defaults to the real `gh` CLI. */
  ghExec?: GhExec
}

export function createApp(deps: AppDeps) {
  const { workspace, registry, store, ghExec } = deps
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  app.get('/api/health', (c) => c.json({ ok: true, name: 'threadmap' }))
  app.get('/api/workspace', (c) => c.json(workspace))
  app.get('/api/efforts', async (c) =>
    c.json(await listEfforts(workspace.repos, ghExec, {
      includeClosed: c.req.query('state') === 'all',
    })),
  )
  // Stage derivation needs a TrackerAdapter (#21); the route exists now so the
  // UI's pipeline rail has one wire shape to bind to (StageSnapshot).
  app.get('/api/stage', (c) =>
    c.json({ error: 'stage derivation lands with the TrackerAdapter (#21)' }, 501),
  )
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
