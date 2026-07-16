import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'

export const DEFAULT_PORT = 4664

export function createApp() {
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  app.get('/api/health', (c) => c.json({ ok: true, name: 'threadmap' }))

  app.get(
    '/ws',
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        ws.send(JSON.stringify({ type: 'hello', message: 'threadmap server connected' }))
      },
      onMessage(event, ws) {
        ws.send(JSON.stringify({ type: 'echo', message: String(event.data) }))
      },
    })),
  )

  return { app, injectWebSocket }
}

export async function startServer(port = DEFAULT_PORT) {
  const { app, injectWebSocket } = createApp()

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
  console.log(`threadmap listening on http://localhost:${port}`)
  return server
}
