// Per-repo agent docs (#7 §6–8). Split by file: the tracker-specific
// issue-tracker.md and the ADR template are stamped from templates by plain
// code here; CONTEXT.md, glossary, and coding standards come from one Claude
// Code session per repo (the UI starts it — visible in the session chat).
// Existing files are never overwritten silently: the plan marks each file
// create/unchanged/differs and apply only writes what the user picked, then
// commits directly — falling back to a PR when branch protection blocks push.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultExec, type Exec } from './exec.js'

export const TEMPLATE_DOCS_COMMIT_MESSAGE = 'docs: threadmap setup — stamp doc templates'
export const AGENT_DOCS_COMMIT_MESSAGE = 'docs: threadmap setup — agent docs'
export const DOCS_FALLBACK_BRANCH = 'tm/setup/agent-docs'

/** All docs readiness checks; the first two are template-stamped, the rest agent-seeded. */
export const REQUIRED_DOCS = [
  { path: 'docs/agents/issue-tracker.md', source: 'template' },
  { path: 'docs/adr/template.md', source: 'template' },
  { path: 'CONTEXT.md', source: 'agent' },
  { path: 'docs/agents/glossary.md', source: 'agent' },
  { path: 'docs/agents/coding-standards.md', source: 'agent' },
] as const

export type DocAction = 'create' | 'unchanged' | 'differs'

export interface DocPlanEntry {
  path: string
  action: DocAction
  proposed: string
  /** Present when action is 'differs' — what's on disk now, for the diff view. */
  current?: string
}

export async function planDocs(tracker: 'github' | 'linear', repoDir?: string): Promise<DocPlanEntry[]> {
  const templates: { path: string; content: string }[] = [
    { path: 'docs/agents/issue-tracker.md', content: tracker === 'linear' ? ISSUE_TRACKER_LINEAR : ISSUE_TRACKER_GITHUB },
    { path: 'docs/adr/template.md', content: ADR_TEMPLATE },
  ]
  return Promise.all(
    templates.map(async ({ path, content }) => {
      const current = repoDir ? await readFile(join(repoDir, path), 'utf8').catch(() => null) : null
      if (current === null) return { path, action: 'create' as const, proposed: content }
      if (current === content) return { path, action: 'unchanged' as const, proposed: content }
      return { path, action: 'differs' as const, proposed: content, current }
    }),
  )
}

export interface ApplyResult {
  mode: 'committed' | 'pr' | 'noop'
  prUrl?: string
}

/**
 * Write the picked files and land them: direct commit to the current branch,
 * automatic PR fallback when the push is rejected (#7 §7).
 */
export async function applyDocs(
  repoDir: string,
  tracker: 'github' | 'linear',
  files: string[],
  exec: Exec = defaultExec,
): Promise<ApplyResult> {
  const plan = await planDocs(tracker, repoDir)
  const picked = plan.filter((e) => files.includes(e.path) && e.action !== 'unchanged')
  if (picked.length === 0) return { mode: 'noop' }

  for (const entry of picked) {
    const abs = join(repoDir, entry.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, entry.proposed, 'utf8')
  }
  await exec('git', ['add', '--', ...picked.map((e) => e.path)], repoDir)
  await exec('git', ['commit', '-m', TEMPLATE_DOCS_COMMIT_MESSAGE], repoDir)
  try {
    await exec('git', ['push'], repoDir)
    return { mode: 'committed' }
  } catch {
    // Branch protection: move the commit onto a branch and open a PR.
    await exec('git', ['checkout', '-b', DOCS_FALLBACK_BRANCH], repoDir)
    await exec('git', ['push', '-u', 'origin', DOCS_FALLBACK_BRANCH], repoDir)
    const out = await exec(
      'gh',
      ['pr', 'create', '--title', TEMPLATE_DOCS_COMMIT_MESSAGE, '--body', 'Automated threadmap setup docs.', '--head', DOCS_FALLBACK_BRANCH],
      repoDir,
    )
    return { mode: 'pr', prUrl: out.trim().split('\n').pop() ?? '' }
  }
}

/** Prompt for the one-per-repo agent session seeding the non-template docs (#7 §6). */
export function docAgentPrompt(): string {
  return [
    'Run /setup-matt-pocock-skills for this repository.',
    'Seed CONTEXT.md at the repo root, docs/agents/glossary.md, and docs/agents/coding-standards.md',
    'from what the codebase actually contains. Do not overwrite docs/agents/issue-tracker.md',
    'or docs/adr/template.md — threadmap stamps those from templates.',
    `Commit the new docs with the message "${AGENT_DOCS_COMMIT_MESSAGE}" and push to origin.`,
    'If the push is rejected (branch protection), move the commit onto a branch and open a PR instead.',
  ].join(' ')
}

const ISSUE_TRACKER_GITHUB = `# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the \`gh\` CLI for all operations.

## Conventions

- **Create an issue**: \`gh issue create --title "..." --body "..."\`. Use a heredoc for multi-line bodies.
- **Read an issue**: \`gh issue view <number> --comments\`.
- **List issues**: \`gh issue list --state open --json number,title,labels\` with appropriate \`--label\` filters.
- **Comment**: \`gh issue comment <number> --body "..."\`
- **Labels**: \`gh issue edit <number> --add-label "..."\` / \`--remove-label "..."\`
- **Close**: \`gh issue close <number> --comment "..."\`

Infer the repo from \`git remote -v\` — \`gh\` does this automatically inside a clone.

## Wayfinding operations

Used by \`/wayfinder\`. The **map** is a single issue with **child** issues as tickets.

- **Map**: one issue labelled \`wayfinder:map\`. Child tickets are GitHub sub-issues of it.
- **Blocking**: GitHub native issue dependencies; \`issue_dependencies_summary.blocked_by\` counts open blockers.
- **Frontier**: open, unblocked, unassigned children — first in map order wins.
- **Claim**: \`gh issue edit <n> --add-assignee @me\` before any work.
- **Resolve**: comment the answer, close the issue, append a pointer to the map's Decisions-so-far.
`

const ISSUE_TRACKER_LINEAR = `# Issue tracker: Linear

Issues and PRDs for this repo live in Linear. Use the **threadmap-tracker** MCP tools for all
operations — issue identity is the Linear UUID (\`ENG-123\` identifiers are display-only).

## Conventions

- **Create an issue**: \`create_issue\` (routes to this repo's team; pass labels by logical name).
- **Read an issue**: \`view_issue\`.
- **List children**: \`list_children\` on a parent issue.
- **Comment**: \`comment\`.
- **Labels**: \`stamp\` / \`unstamp\` with logical names (\`ticket\`, \`spec\`, \`ticketed\`, \`override:<stage>\`).
- **Close**: \`resolve_issue\` with outcome \`done\` or \`wontfix\`.
- **PR linkage**: \`attach_pr\` with the GitHub PR URL.

## Wayfinding operations

Used by \`/wayfinder\`. The **map** is a single issue with **child** issues as tickets.

- **Map**: one issue labelled \`wayfinder:map\`; tickets are its sub-issues.
- **Blocking**: \`add_blocked_by\` creates the native relation; the frontier query filters on it server-side.
- **Frontier**: \`frontier\` on the map — open, unblocked, unassigned children.
- **Claim**: assign the issue to yourself before any work.
- **Resolve**: \`resolve_issue\` with the answer as the closing comment, then append a pointer to the map's Decisions-so-far.
`

const ADR_TEMPLATE = `# ADR-NNNN: <title>

## Status

Proposed | Accepted | Superseded by ADR-NNNN

## Context

<What forces are at play — the situation that demands a decision.>

## Decision

<The change we're making, stated in full sentences with the reasoning.>

## Consequences

<What becomes easier, what becomes harder, what we've committed to.>
`
