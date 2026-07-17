import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GhExec } from '../gating/index.js'
import { createApp } from './index.js'
import { SessionRegistry } from './registry.js'
import { TranscriptStore } from './transcripts.js'
import { FakeAdapter } from './test-helpers.js'
import { createStageService, loadTrackerConfig } from './stage.js'
import type { Workspace } from './workspace.js'

function workspaceAt(root: string): Workspace {
  return { root, repos: [{ name: 'web', path: join(root, 'web') }] }
}

/** gh fake covering repo view, sub-issue listing, map read, and PR listing. */
const ghExec: GhExec = async (args) => {
  const joined = args.join(' ')
  if (joined.includes('repo view')) return JSON.stringify({ nameWithOwner: 'acme/web' })
  if (joined.includes('sub_issues')) return JSON.stringify([])
  if (joined.includes('repos/acme/web/issues/1')) return JSON.stringify({ labels: [] })
  if (joined.includes('pr list')) return JSON.stringify([])
  throw new Error(`unexpected gh call: ${joined}`)
}

describe('loadTrackerConfig', () => {
  it('defaults to github without config, reads .threadline/config.json when present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tl-ws-'))
    expect(await loadTrackerConfig(root)).toEqual({ tracker: 'github' })
    await mkdir(join(root, '.threadline'))
    await writeFile(
      join(root, '.threadline', 'config.json'),
      JSON.stringify({ tracker: 'linear', linear: { orgId: 'org-1', repoTeams: { web: 'team-1' } } }),
    )
    expect(await loadTrackerConfig(root)).toEqual({
      tracker: 'linear',
      linear: { orgId: 'org-1', repoTeams: { web: 'team-1' } },
    })
  })
})

describe('createStageService (github)', () => {
  it('derives a StageSnapshot for an effort through the seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tl-ws-'))
    const service = await createStageService(workspaceAt(root), { ghExec })
    const snapshot = await service.snapshot('acme/web#1')
    // Empty map: planning gate met (no open wayfinder children), to-spec unmet.
    expect(snapshot.stage).toBe('to-spec')
    expect(snapshot.gates.map((g) => g.stage)).toEqual([
      'planning',
      'to-spec',
      'to-tickets',
      'implement',
      'code-review',
    ])
  })

  it('rejects refs it did not mint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tl-ws-'))
    const service = await createStageService(workspaceAt(root), { ghExec })
    await expect(service.snapshot('not-a-ref')).rejects.toThrow(/not a GitHub ticket ref/)
  })
})

describe('GET /api/stage', () => {
  function makeApp(stageService?: Parameters<typeof createApp>[0]['stageService']) {
    const registry = new SessionRegistry({ fake: new FakeAdapter() }, new TranscriptStore())
    return createApp({
      workspace: { root: '/tmp/x', repos: [] },
      registry,
      store: new TranscriptStore(),
      ...(stageService ? { stageService } : {}),
    }).app
  }

  it('400s without an effort param', async () => {
    const res = await makeApp().request('/api/stage')
    expect(res.status).toBe(400)
  })

  it('returns the snapshot from the stage service', async () => {
    const snapshot = { stage: 'planning', gates: [], readyToComplete: false, warnings: [] }
    const app = makeApp({ snapshot: async () => snapshot } as never)
    const res = await app.request('/api/stage?effort=acme/web%231')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(snapshot)
  })

  it('502s when the tracker read fails', async () => {
    const app = makeApp({
      snapshot: async () => {
        throw new Error('gh exploded')
      },
    } as never)
    const res = await app.request('/api/stage?effort=acme/web%231')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'gh exploded' })
  })
})
