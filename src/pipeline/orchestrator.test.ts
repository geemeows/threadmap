import { describe, expect, it } from 'vitest'
import type { SessionRegistry, StartSessionOptions } from '../server/registry.js'
import type { SessionMeta } from '../server/transcripts.js'
import type { PRInfo, PRSource } from '../gating/types.js'
import type { TicketRef, TrackerAdapter } from '../tracker/types.js'
import type { Exec } from './git.js'
import { PipelineOrchestrator, type OrchestratorDeps } from './orchestrator.js'

const EFFORT_ID = 'acme/home#1'
const TICKET: TicketRef = {
  id: 'acme/web#42',
  display: 'acme/web#42',
  url: 'https://github.com/acme/web/issues/42',
}
const WT = '/ws/.threadline/worktrees/web/acme-web-42'
const LAND_WT = '/ws/.threadline/worktrees/web/land-acme-home-1'

function fakeExec(routes: Record<string, string | Error | ((joined: string) => string)>) {
  const calls: string[] = []
  const exec: Exec = async (cmd, args, _cwd) => {
    const joined = `${cmd} ${args.join(' ')}`
    calls.push(joined)
    const key = Object.keys(routes).find((k) => joined.includes(k))
    if (key === undefined) return ''
    const value = routes[key]
    if (value instanceof Error) throw value
    return typeof value === 'function' ? value(joined) : (value as string)
  }
  return { exec, calls }
}

function fakeRegistry() {
  const started: StartSessionOptions[] = []
  let running = false
  const registry = {
    start(opts: StartSessionOptions): SessionMeta {
      started.push(opts)
      running = true
      return { id: `s${started.length}`, adapter: 'fake', cwd: opts.cwd, prompt: opts.prompt, createdAt: 't', status: 'running' } as SessionMeta
    },
    get(id: string): SessionMeta | undefined {
      return running ? ({ id, status: 'running' } as SessionMeta) : undefined
    },
    endAll() {
      running = false
    },
  }
  return { registry: registry as unknown as SessionRegistry & { endAll(): void }, started }
}

function fakeTracker(over: Partial<Record<string, unknown>> = {}): TrackerAdapter {
  return {
    children: async () => [{ ref: TICKET, state: 'open' as const }],
    ticketTarget: async () => ({ id: 'acme/web', display: 'web' }),
    ticketBody: async (ref: TicketRef) =>
      ref.id === EFFORT_ID
        ? { title: 'SDLC pipeline MVP', body: 'map body' }
        : { title: 'Add the flux capacitor', body: 'Wire 1.21 gigawatts.' },
    ...over,
  } as unknown as TrackerAdapter
}

function fakePrSource(byTicket: Record<string, PRInfo | null> = {}): PRSource {
  return {
    async ticketPR(_dir, ticket) {
      return byTicket[ticket.id] ?? null
    },
  }
}

function makeDeps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    workspace: { root: '/ws', repos: [{ name: 'web', path: '/ws/web' }] },
    registry: fakeRegistry().registry,
    tracker: fakeTracker(),
    prSource: fakePrSource(),
    resolveRepoDir: () => '/ws/web',
    mintEffortRef: (id) => ({ id, display: id, url: `https://github.com/acme/home/issues/1` }),
    ...over,
  }
}

describe('startImplement', () => {
  it('lazily creates the trunk, adds a detached worktree, and starts the session on ticket body + conventions', async () => {
    const { registry, started } = fakeRegistry()
    const { exec, calls } = fakeExec({
      'ls-remote --heads origin tm/effort/1': '',
      'ls-remote --symref': 'ref: refs/heads/main\tHEAD\n',
      'worktree list': 'worktree /ws/web\n',
    })
    const orch = new PipelineOrchestrator(makeDeps({ registry, exec }))
    const meta = await orch.startImplement(EFFORT_ID, TICKET.id)

    expect(calls).toContain('git push origin refs/remotes/origin/main:refs/heads/tm/effort/1')
    expect(calls).toContain(`git worktree add --detach ${WT} origin/tm/effort/1`)
    expect(meta.status).toBe('running')
    const opts = started[0]!
    expect(opts.cwd).toBe(WT)
    expect(opts.stage).toBe('implement')
    expect(opts.effort).toBe(EFFORT_ID)
    expect(opts.prompt).toContain('Add the flux capacitor')
    expect(opts.prompt).toContain('Wire 1.21 gigawatts.')
    expect(opts.prompt).toContain('tm/<type>/42-<context>')
    expect(opts.prompt).toContain('tm/effort/1')
    expect(opts.permissionPolicy).toEqual({ mode: 'default', intercept: true })
  })

  it('reuses an existing worktree and existing trunk', async () => {
    const { registry } = fakeRegistry()
    const { exec, calls } = fakeExec({
      'ls-remote --heads origin tm/effort/1': 'abc\trefs/heads/tm/effort/1\n',
      'worktree list': `worktree /ws/web\n\nworktree ${WT}\n`,
    })
    const orch = new PipelineOrchestrator(makeDeps({ registry, exec }))
    await orch.startImplement(EFFORT_ID, TICKET.id)
    expect(calls.some((c) => c.includes('worktree add'))).toBe(false)
    expect(calls.some((c) => c.includes('push origin refs/remotes'))).toBe(false)
  })

  it('rejects tickets that are not children of the effort', async () => {
    const orch = new PipelineOrchestrator(makeDeps({ exec: fakeExec({}).exec }))
    await expect(orch.startImplement(EFFORT_ID, 'acme/web#99')).rejects.toThrow(/not a ticket child/)
  })
})

describe('startReview', () => {
  const openPr: PRInfo = {
    url: 'https://github.com/acme/web/pull/7',
    number: 7,
    state: 'open',
    unresolvedReviewThreads: 0,
  }

  it('starts a review session in the ticket worktree on ticket body + PR + verdict convention', async () => {
    const { registry, started } = fakeRegistry()
    const { exec, calls } = fakeExec({ 'worktree list': `worktree ${WT}\n` })
    const orch = new PipelineOrchestrator(
      makeDeps({ registry, exec, prSource: fakePrSource({ [TICKET.id]: openPr }) }),
    )
    const meta = await orch.startReview(EFFORT_ID, TICKET.id)

    expect(calls.some((c) => c.includes('worktree add'))).toBe(false)
    expect(meta.status).toBe('running')
    const opts = started[0]!
    expect(opts.cwd).toBe(WT)
    expect(opts.stage).toBe('review')
    expect(opts.effort).toBe(EFFORT_ID)
    expect(opts.prompt).toContain('Add the flux capacitor')
    expect(opts.prompt).toContain('Wire 1.21 gigawatts.')
    expect(opts.prompt).toContain('gh pr diff 7')
    expect(opts.prompt).toContain('gh pr review 7 --comment')
    expect(opts.prompt).toContain('Verdict: approve')
    expect(opts.permissionPolicy).toEqual({ mode: 'default', intercept: true })
  })

  it('adds a fresh worktree detached at the trunk head when the implement worktree is gone', async () => {
    const { registry, started } = fakeRegistry()
    const { exec, calls } = fakeExec({ 'worktree list': 'worktree /ws/web\n' })
    const orch = new PipelineOrchestrator(
      makeDeps({ registry, exec, prSource: fakePrSource({ [TICKET.id]: openPr }) }),
    )
    await orch.startReview(EFFORT_ID, TICKET.id)
    expect(calls).toContain(`git worktree add --detach ${WT} origin/tm/effort/1`)
    expect(started[0]!.cwd).toBe(WT)
  })

  it('derives the PR number from the URL when the source omits it', async () => {
    const { registry, started } = fakeRegistry()
    const { exec } = fakeExec({ 'worktree list': `worktree ${WT}\n` })
    const { number: _dropped, ...urlOnly } = openPr
    const orch = new PipelineOrchestrator(
      makeDeps({ registry, exec, prSource: fakePrSource({ [TICKET.id]: urlOnly }) }),
    )
    await orch.startReview(EFFORT_ID, TICKET.id)
    expect(started[0]!.prompt).toContain('gh pr review 7 --comment')
  })

  it('rejects when the ticket has no open PR', async () => {
    const { exec } = fakeExec({ 'worktree list': `worktree ${WT}\n` })
    const noPr = new PipelineOrchestrator(makeDeps({ exec }))
    await expect(noPr.startReview(EFFORT_ID, TICKET.id)).rejects.toThrow(/no open PR/)

    const mergedPr = new PipelineOrchestrator(
      makeDeps({
        exec,
        prSource: fakePrSource({ [TICKET.id]: { ...openPr, state: 'merged' } }),
      }),
    )
    await expect(mergedPr.startReview(EFFORT_ID, TICKET.id)).rejects.toThrow(/no open PR/)
  })
})

describe('startReconcile', () => {
  it('requires the ticket worktree to exist', async () => {
    const { exec } = fakeExec({ 'worktree list': 'worktree /ws/web\n' })
    const orch = new PipelineOrchestrator(makeDeps({ exec }))
    await expect(orch.startReconcile(EFFORT_ID, TICKET.id)).rejects.toThrow(/no worktree/)
  })

  it('starts a merge-trunk-into-ticket session in the ticket worktree', async () => {
    const { registry, started } = fakeRegistry()
    const { exec } = fakeExec({ 'worktree list': `worktree ${WT}\n` })
    const orch = new PipelineOrchestrator(makeDeps({ registry, exec }))
    await orch.startReconcile(EFFORT_ID, TICKET.id)
    const opts = started[0]!
    expect(opts.cwd).toBe(WT)
    expect(opts.stage).toBe('reconcile')
    expect(opts.prompt).toContain('merge `origin/tm/effort/1` into the ticket branch')
  })
})

describe('land', () => {
  const baseRoutes = {
    'ls-remote --heads origin tm/effort/1': 'abc\trefs/heads/tm/effort/1\n',
    'ls-remote --symref': 'ref: refs/heads/main\tHEAD\n',
    'worktree list': 'worktree /ws/web\n',
  }

  it('merges main into the trunk mechanically and opens the landing PR', async () => {
    const { exec, calls } = fakeExec({
      ...baseRoutes,
      'pr list': '[]',
      'pr create': 'https://github.com/acme/web/pull/9\n',
    })
    const orch = new PipelineOrchestrator(makeDeps({ exec }))
    const results = await orch.land(EFFORT_ID)
    expect(results).toEqual([{ repo: 'web', status: 'pr_opened', prUrl: 'https://github.com/acme/web/pull/9' }])
    expect(calls).toContain(`git worktree add -B tm/effort/1 ${LAND_WT} origin/tm/effort/1`)
    expect(calls).toContain('git push origin HEAD:refs/heads/tm/effort/1')
    const create = calls.find((c) => c.includes('pr create'))!
    expect(create).toContain('--base main --head tm/effort/1')
    expect(create).toContain('Closes #42')
    expect(create).toContain('Land effort: SDLC pipeline MVP')
  })

  it('reuses an already-open landing PR', async () => {
    const { exec } = fakeExec({
      ...baseRoutes,
      'pr list': '[{"url":"https://github.com/acme/web/pull/9"}]',
    })
    const orch = new PipelineOrchestrator(makeDeps({ exec }))
    expect(await orch.land(EFFORT_ID)).toEqual([
      { repo: 'web', status: 'pr_exists', prUrl: 'https://github.com/acme/web/pull/9' },
    ])
  })

  it('spawns one sync session on merge conflict and never double-spawns', async () => {
    const { registry, started } = fakeRegistry()
    const { exec } = fakeExec({
      ...baseRoutes,
      'merge --no-edit': new Error('CONFLICT'),
      'diff --name-only --diff-filter=U': 'src/a.ts\n',
    })
    const orch = new PipelineOrchestrator(makeDeps({ registry, exec }))
    const first = await orch.land(EFFORT_ID)
    expect(first[0]!.status).toBe('sync_session_started')
    expect(started[0]!.cwd).toBe(LAND_WT)
    expect(started[0]!.stage).toBe('land-sync')
    expect(started[0]!.prompt).toContain('git push origin HEAD:refs/heads/tm/effort/1')

    const second = await orch.land(EFFORT_ID)
    expect(second).toEqual([{ repo: 'web', status: 'sync_in_progress' }])
    expect(started).toHaveLength(1)
  })

  it('skips repos whose trunk never existed', async () => {
    const { exec } = fakeExec({ 'ls-remote --heads': '' })
    const orch = new PipelineOrchestrator(makeDeps({ exec }))
    expect(await orch.land(EFFORT_ID)).toEqual([])
  })
})

describe('cleanupMerged', () => {
  const merged: PRInfo = { url: 'u', state: 'merged', unresolvedReviewThreads: 0 }

  it('removes a clean worktree once its PR merged', async () => {
    const { exec, calls } = fakeExec({
      'worktree list': `worktree ${WT}\n`,
      'status --porcelain': '',
      'rev-list --count': '0\n',
    })
    const orch = new PipelineOrchestrator(
      makeDeps({ exec, prSource: fakePrSource({ [TICKET.id]: merged }) }),
    )
    expect(await orch.cleanupMerged(EFFORT_ID)).toEqual([
      { ticket: TICKET.display, repo: 'web', status: 'removed' },
    ])
    expect(calls).toContain(`git worktree remove ${WT}`)
  })

  it('keeps dirty worktrees and reports them', async () => {
    const { exec, calls } = fakeExec({
      'worktree list': `worktree ${WT}\n`,
      'status --porcelain': ' M src/a.ts\n',
    })
    const orch = new PipelineOrchestrator(
      makeDeps({ exec, prSource: fakePrSource({ [TICKET.id]: merged }) }),
    )
    expect(await orch.cleanupMerged(EFFORT_ID)).toEqual([
      { ticket: TICKET.display, repo: 'web', status: 'kept_dirty' },
    ])
    expect(calls.some((c) => c.includes('worktree remove'))).toBe(false)
  })

  it('leaves unmerged tickets alone', async () => {
    const { exec } = fakeExec({ 'worktree list': `worktree ${WT}\n` })
    const orch = new PipelineOrchestrator(
      makeDeps({
        exec,
        prSource: fakePrSource({ [TICKET.id]: { url: 'u', state: 'open', unresolvedReviewThreads: 0 } }),
      }),
    )
    expect(await orch.cleanupMerged(EFFORT_ID)).toEqual([
      { ticket: TICKET.display, repo: 'web', status: 'pr_not_merged' },
    ])
  })
})

describe('completeEffort', () => {
  it('sweeps clean worktrees, deletes the trunk, and closes the map issue', async () => {
    const { exec, calls } = fakeExec({
      'worktree list': `worktree ${WT}\nworktree ${LAND_WT}\n`,
      'status --porcelain': '',
      'rev-list --count': '0\n',
      'ls-remote --heads': '',
    })
    const resolved: unknown[] = []
    const tracker = fakeTracker({
      resolve: async (ref: TicketRef, outcome: string) => {
        resolved.push([ref.id, outcome])
      },
    })
    const orch = new PipelineOrchestrator(makeDeps({ exec, tracker }))
    const { results: [result], mapClosed } = await orch.completeEffort(EFFORT_ID)
    expect(result).toEqual({
      repo: 'web',
      removedWorktrees: [WT, LAND_WT],
      keptWorktrees: [],
      trunkDeleted: true,
    })
    expect(calls).toContain('git push origin --delete tm/effort/1')
    expect(mapClosed).toBe(true)
    expect(resolved).toEqual([[EFFORT_ID, 'done']])
  })

  it('a dirty worktree blocks trunk deletion and map closing unless forced', async () => {
    const { exec, calls } = fakeExec({
      'worktree list': `worktree ${WT}\n`,
      'status --porcelain': ' M src/a.ts\n',
    })
    const resolved: unknown[] = []
    const tracker = fakeTracker({
      resolve: async (ref: TicketRef, outcome: string) => {
        resolved.push([ref.id, outcome])
      },
    })
    const orch = new PipelineOrchestrator(makeDeps({ exec, tracker }))
    const { results: [kept], mapClosed } = await orch.completeEffort(EFFORT_ID)
    expect(kept).toEqual({
      repo: 'web',
      removedWorktrees: [],
      keptWorktrees: [WT],
      trunkDeleted: false,
    })
    expect(calls.some((c) => c.includes('--delete'))).toBe(false)
    expect(mapClosed).toBe(false)
    expect(resolved).toEqual([])

    const forced = new PipelineOrchestrator(makeDeps({ exec, tracker }))
    const swept = await forced.completeEffort(EFFORT_ID, { force: true })
    expect(swept.results[0]!.removedWorktrees).toEqual([WT])
    expect(swept.results[0]!.trunkDeleted).toBe(true)
    expect(swept.mapClosed).toBe(true)
    expect(resolved).toEqual([[EFFORT_ID, 'done']])
  })
})
