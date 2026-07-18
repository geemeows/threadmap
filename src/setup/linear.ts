// Linear side of setup (#7 §3–4, #20, #21): validate a pasted API key against
// `viewer`, store it 0600 in ~/.threadmap/credentials.json, list/create teams
// for the repo↔team default mapping, and provision threadmap-managed teams —
// vocabulary labels created via API (UI creation group-splits on `:`, §10.1)
// and auto-close automations disabled (the approval gate trusts
// completed ⇒ approved on exactly that basis, #20 §10.4).

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LinearClient } from '../tracker/linear-client.js'
import { VOCABULARY_LABELS } from '../tracker/labels.js'

export { VOCABULARY_LABELS }

export interface LinearOrgInfo {
  orgId: string
  orgName: string
  viewerName: string
}

export interface LinearTeam {
  id: string
  key: string
  name: string
}

/** Throws (LinearApiError) on a bad key — the wizard shows the message inline. */
export async function validateLinearKey(client: LinearClient): Promise<LinearOrgInfo> {
  const data = await client.query<{
    viewer: { name: string }
    organization: { id: string; name: string }
  }>(`query { viewer { name } organization { id name } }`)
  return {
    orgId: data.organization.id,
    orgName: data.organization.name,
    viewerName: data.viewer.name,
  }
}

export function credentialsPath(home = homedir()): string {
  return join(home, '.threadmap', 'credentials.json')
}

/** Merge the key under `linear.<orgId>.apiKey`, file mode 0600 (#7 §3). */
export async function storeLinearKey(
  orgId: string,
  apiKey: string,
  path = credentialsPath(),
): Promise<void> {
  const raw = await readFile(path, 'utf8').catch(() => null)
  const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  const linear = { ...((parsed.linear as Record<string, unknown>) ?? {}), [orgId]: { apiKey } }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ ...parsed, linear }, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600) // writeFile mode is ignored when the file pre-exists
}

export async function listTeams(client: LinearClient): Promise<LinearTeam[]> {
  const data = await client.query<{ teams: { nodes: LinearTeam[] } }>(
    `query { teams(first: 100) { nodes { id key name } } }`,
  )
  return data.teams.nodes
}

export async function createTeam(client: LinearClient, name: string, key?: string): Promise<LinearTeam> {
  const data = await client.query<{ teamCreate: { team: LinearTeam } }>(
    `mutation($input: TeamCreateInput!) { teamCreate(input: $input) { team { id key name } } }`,
    { input: { name, ...(key ? { key } : {}) } },
  )
  return data.teamCreate.team
}

/**
 * Provision threadmap-managed teams: workspace-level vocabulary labels plus
 * `autoCloseParentIssues`/`autoCloseChildIssues` off per team (one teamUpdate
 * each). Idempotent — existing labels are found, teamUpdate re-applies.
 */
export async function provisionLinear(client: LinearClient, teamIds: string[]): Promise<void> {
  for (const name of VOCABULARY_LABELS) await ensureWorkspaceLabel(client, name)
  for (const teamId of teamIds) {
    await client.query(
      `mutation($id: String!, $input: TeamUpdateInput!) { teamUpdate(id: $id, input: $input) { success } }`,
      { id: teamId, input: { autoCloseParentIssues: false, autoCloseChildIssues: false } },
    )
  }
}

async function ensureWorkspaceLabel(client: LinearClient, name: string): Promise<void> {
  const found = await client.query<{ issueLabels: { nodes: { id: string }[] } }>(
    `query($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id } } }`,
    { name },
  )
  if (found.issueLabels.nodes.length > 0) return
  await client.query(
    `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
    { input: { name } }, // no teamId ⇒ workspace-level
  )
}
