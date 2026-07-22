import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionMeta } from './transcripts.js'
import { TranscriptStore } from './transcripts.js'

let dir: string
let store: TranscriptStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadmap-transcripts-'))
  store = new TranscriptStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function meta(id: string, createdAt: string): SessionMeta {
  return {
    id,
    adapter: 'fake',
    cwd: '/repo',
    prompt: '/grilling go',
    createdAt,
    status: 'ended',
  }
}

describe('TranscriptStore', () => {
  it('appends events and reads them back in order', async () => {
    await store.append('s1', { type: 'assistant_delta', text: 'hel', raw: 1 })
    await store.append('s1', { type: 'assistant_delta', text: 'lo', raw: 2 })

    const events = await store.readEvents('s1')
    expect(events).toEqual([
      { type: 'assistant_delta', text: 'hel', raw: 1 },
      { type: 'assistant_delta', text: 'lo', raw: 2 },
    ])
  })

  it('returns [] for an unknown session transcript', async () => {
    expect(await store.readEvents('nope')).toEqual([])
    expect(await store.readMeta('nope')).toBeNull()
  })

  it('round-trips metadata and lists sessions newest first', async () => {
    await store.writeMeta(meta('old', '2026-07-01T00:00:00Z'))
    await store.writeMeta(meta('new', '2026-07-17T00:00:00Z'))

    expect(await store.readMeta('old')).toMatchObject({ id: 'old', status: 'ended' })
    expect((await store.list()).map((m) => m.id)).toEqual(['new', 'old'])
  })

  it('detachEffort removes only the effort key, leaving other meta intact', async () => {
    await store.writeMeta({ ...meta('s1', '2026-07-17T00:00:00Z'), effort: 'o/r#1', stage: 'planning' })
    await store.append('s1', { type: 'assistant_delta', text: 'kept', raw: 1 })

    await store.detachEffort('s1')

    const detached = await store.readMeta('s1')
    expect(detached?.effort).toBeUndefined()
    expect(detached).toMatchObject({ id: 's1', stage: 'planning', prompt: '/grilling go' })
    // The transcript is untouched.
    expect(await store.readEvents('s1')).toEqual([{ type: 'assistant_delta', text: 'kept', raw: 1 }])
  })

  it('detachEffort is a no-op for an unknown or already-ad-hoc session', async () => {
    await expect(store.detachEffort('nope')).resolves.toBeUndefined()
    await store.writeMeta(meta('adhoc', '2026-07-17T00:00:00Z')) // no effort
    await store.detachEffort('adhoc')
    expect(await store.readMeta('adhoc')).toMatchObject({ id: 'adhoc' })
  })
})
