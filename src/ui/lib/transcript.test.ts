import { describe, expect, it } from 'vitest'
import { pendingApprovals, reduceTranscript, sessionStatus, summarizeInput } from './transcript.js'
import type { SessionMeta, TranscriptEvent } from './types.js'

const meta: SessionMeta = {
  id: 's1',
  adapter: 'claude-code',
  cwd: '/repo',
  prompt: '/grilling go',
  createdAt: '2026-07-17T00:00:00Z',
  status: 'running',
}

describe('reduceTranscript', () => {
  it('opens with the session prompt as the first user message', () => {
    expect(reduceTranscript(meta, [])).toEqual([{ kind: 'user', text: '/grilling go' }])
  })

  it('accumulates deltas into one streaming agent bubble, finalized by the full message', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant_delta', text: 'Hel', raw: {} },
      { type: 'assistant_delta', text: 'lo', raw: {} },
      { type: 'assistant_message', content: [{ type: 'text', text: 'Hello there' }], raw: {} },
    ]
    const items = reduceTranscript(meta, events)
    expect(items).toHaveLength(2)
    expect(items[1]).toEqual({ kind: 'agent', text: 'Hello there', streaming: false })
  })

  it('renders tool calls as command rows and errors from tool results', () => {
    const events: TranscriptEvent[] = [
      { type: 'tool_call', name: 'Bash', input: { command: 'pnpm test' }, callId: 'c1', raw: {} },
      { type: 'tool_result', callId: 'c1', output: 'boom', isError: true, raw: {} },
    ]
    expect(reduceTranscript(meta, events).slice(1)).toEqual([
      { kind: 'tool', text: '$ Bash pnpm test' },
      { kind: 'tool', text: 'boom', error: true },
    ])
  })

  it('marks approvals resolved by their permission_response', () => {
    const events: TranscriptEvent[] = [
      { type: 'permission_request', id: 'p1', tool: 'Bash', input: { command: 'rm x' }, raw: {} },
      { type: 'permission_response', id: 'p1', decision: { behavior: 'deny' } },
    ]
    const approval = reduceTranscript(meta, events)[1]
    expect(approval).toMatchObject({ kind: 'approval', id: 'p1', resolved: 'deny' })
    expect(pendingApprovals(events)).toEqual([])
  })

  it('interleaves recorded user messages and the ended marker', () => {
    const events: TranscriptEvent[] = [
      { type: 'user_message', text: 'carry on' },
      { type: 'session_ended', outcome: 'completed', resumable: true },
    ]
    expect(reduceTranscript(meta, events).slice(1)).toEqual([
      { kind: 'user', text: 'carry on' },
      { kind: 'system', text: 'session ended — completed' },
    ])
  })
})

describe('sessionStatus', () => {
  it('is needs-approval while a permission_request is unanswered', () => {
    const events: TranscriptEvent[] = [
      { type: 'permission_request', id: 'p1', tool: 'Bash', input: {}, raw: {} },
    ]
    expect(sessionStatus(meta, events)).toBe('needs-approval')
  })

  it('is waiting-human after a full assistant message with nothing pending', () => {
    const events: TranscriptEvent[] = [
      { type: 'assistant_message', content: [{ type: 'text', text: 'your call?' }], raw: {} },
      { type: 'usage_update', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} },
    ]
    expect(sessionStatus(meta, events)).toBe('waiting-human')
  })

  it('is running mid-tool-call and done once meta says ended', () => {
    const events: TranscriptEvent[] = [
      { type: 'tool_call', name: 'Read', input: {}, callId: 'c1', raw: {} },
    ]
    expect(sessionStatus(meta, events)).toBe('running')
    expect(sessionStatus({ ...meta, status: 'ended' }, events)).toBe('done')
  })
})

describe('summarizeInput', () => {
  it('picks the human-relevant field and truncates to one line', () => {
    expect(summarizeInput({ command: 'ls -la' })).toBe('ls -la')
    expect(summarizeInput({ file_path: '/a/b.ts', content: 'x' })).toBe('/a/b.ts')
    expect(summarizeInput({ nested: { deep: true } })).toBe('')
    expect(summarizeInput(`x${'y'.repeat(200)}`)).toHaveLength(121)
  })
})
