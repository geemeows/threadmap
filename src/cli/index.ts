import { startServer, DEFAULT_PORT } from '../server/index.js'

const [, , command, ...rest] = process.argv

if (command === 'tracker-mcp') {
  // Stdio MCP server for Linear workspaces, injected into agent sessions via
  // StartOptions.mcpConfig (#19 §7). `--org <workspace-org-uuid>` selects the
  // credentials.json entry; LINEAR_API_KEY overrides.
  const { LinearAdapter, LinearClient, resolveLinearApiKey, runTrackerMcpServer } = await import(
    '../tracker/index.js'
  )
  const orgFlag = rest.indexOf('--org')
  const orgId = orgFlag !== -1 ? rest[orgFlag + 1] : process.env.THREADMAP_LINEAR_ORG
  // `--stage <stage>` binds the server to its session's pipeline stage so
  // create_issue can enforce which artifacts that stage may mint (#19 §7).
  const stageFlag = rest.indexOf('--stage')
  const stage = stageFlag !== -1 ? rest[stageFlag + 1] : process.env.THREADMAP_STAGE
  const client = new LinearClient({ apiKey: await resolveLinearApiKey(orgId) })
  await runTrackerMcpServer({
    adapter: new LinearAdapter({ client }),
    client,
    ...(stage ? { stage } : {}),
  })
} else {
  const port = Number(process.env.PORT ?? process.env.THREADMAP_PORT ?? DEFAULT_PORT)
  await startServer(port)
}
