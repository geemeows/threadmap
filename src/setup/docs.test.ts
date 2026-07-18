import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Exec } from './exec.js'
import { DOCS_FALLBACK_BRANCH, applyDocs, planDocs } from './docs.js'

let dir: string

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function makeRepo(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'threadmap-docs-'))
  return dir
}

function recordingExec(failOn?: (cmd: string, args: string[]) => boolean) {
  const calls: { cmd: string; args: string[] }[] = []
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args })
    if (failOn?.(cmd, args)) throw new Error('rejected')
    if (cmd === 'gh' && args[0] === 'pr') return 'https://github.com/o/r/pull/9\n'
    return ''
  }
  return { calls, exec }
}

describe('planDocs', () => {
  it('proposes creates on a bare repo, tracker-specific content', async () => {
    const repo = await makeRepo()
    const plan = await planDocs('github', repo)
    expect(plan.map((e) => e.action)).toEqual(['create', 'create'])
    expect(plan[0]?.proposed).toContain('gh issue create')
    const linear = await planDocs('linear', repo)
    expect(linear[0]?.proposed).toContain('threadmap-tracker')
    expect(linear[0]?.proposed).toContain('resolve_issue')
  })

  it('marks unchanged and differs correctly on re-runs (#7 §8)', async () => {
    const repo = await makeRepo()
    const [first] = await planDocs('github', repo)
    await mkdir(join(repo, 'docs', 'agents'), { recursive: true })
    await writeFile(join(repo, 'docs/agents/issue-tracker.md'), first!.proposed)
    await mkdir(join(repo, 'docs', 'adr'), { recursive: true })
    await writeFile(join(repo, 'docs/adr/template.md'), '# custom template\n')

    const plan = await planDocs('github', repo)
    expect(plan.find((e) => e.path.endsWith('issue-tracker.md'))?.action).toBe('unchanged')
    const adr = plan.find((e) => e.path.endsWith('template.md'))
    expect(adr?.action).toBe('differs')
    expect(adr?.current).toBe('# custom template\n')
  })
})

describe('applyDocs', () => {
  it('writes picked files and commits directly', async () => {
    const repo = await makeRepo()
    const { calls, exec } = recordingExec()
    const result = await applyDocs(repo, 'github', ['docs/agents/issue-tracker.md'], exec)
    expect(result.mode).toBe('committed')
    const written = await readFile(join(repo, 'docs/agents/issue-tracker.md'), 'utf8')
    expect(written).toContain('# Issue tracker: GitHub')
    expect(calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(['git add', 'git commit', 'git push'])
    // only the picked file is staged
    expect(calls[0]?.args).toContain('docs/agents/issue-tracker.md')
    expect(calls[0]?.args).not.toContain('docs/adr/template.md')
  })

  it('falls back to a PR when push is rejected (#7 §7)', async () => {
    const repo = await makeRepo()
    const { calls, exec } = recordingExec((cmd, args) => cmd === 'git' && args[0] === 'push' && args.length === 1)
    const result = await applyDocs(repo, 'github', ['docs/adr/template.md'], exec)
    expect(result.mode).toBe('pr')
    expect(result.prUrl).toBe('https://github.com/o/r/pull/9')
    expect(calls.some((c) => c.cmd === 'git' && c.args.join(' ') === `checkout -b ${DOCS_FALLBACK_BRANCH}`)).toBe(true)
  })

  it('no-ops when every picked file is already up to date', async () => {
    const repo = await makeRepo()
    const { exec: seedExec } = recordingExec()
    await applyDocs(repo, 'github', ['docs/agents/issue-tracker.md'], seedExec)
    const { calls, exec } = recordingExec()
    const result = await applyDocs(repo, 'github', ['docs/agents/issue-tracker.md'], exec)
    expect(result.mode).toBe('noop')
    expect(calls).toEqual([])
  })
})
