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

  it('pairs a tool call with its result onto one item, carrying input and output', () => {
    const events: TranscriptEvent[] = [
      { type: 'tool_call', name: 'Bash', input: { command: 'pnpm test' }, callId: 'c1', raw: {} },
      { type: 'tool_result', callId: 'c1', output: 'boom', isError: true, raw: {} },
    ]
    expect(reduceTranscript(meta, events).slice(1)).toEqual([
      { kind: 'tool', callId: 'c1', name: 'Bash', input: { command: 'pnpm test' }, output: 'boom', error: true },
    ])
  })

  it('keeps a successful tool result on its call item', () => {
    const events: TranscriptEvent[] = [
      { type: 'tool_call', name: 'Read', input: { file_path: '/a.ts' }, callId: 'c2', raw: {} },
      { type: 'tool_result', callId: 'c2', output: 'file contents', isError: false, raw: {} },
    ]
    expect(reduceTranscript(meta, events).slice(1)).toEqual([
      { kind: 'tool', callId: 'c2', name: 'Read', input: { file_path: '/a.ts' }, output: 'file contents', error: false },
    ])
  })

  it('surfaces AskUserQuestion as an interactive question item, not a raw tool row', () => {
    const events: TranscriptEvent[] = [
      {
        type: 'tool_call',
        name: 'AskUserQuestion',
        callId: 'q1',
        input: {
          questions: [
            {
              question: 'Which tracker?',
              header: 'Tracker',
              options: [
                { label: 'GitHub', description: 'gh issues' },
                { label: 'Linear', description: 'linear teams' },
              ],
              multiSelect: false,
            },
          ],
        },
        raw: {},
      },
    ]
    expect(reduceTranscript(meta, events).slice(1)).toEqual([
      {
        kind: 'question',
        callId: 'q1',
        answered: false,
        questions: [
          {
            question: 'Which tracker?',
            header: 'Tracker',
            options: [
              { label: 'GitHub', description: 'gh issues' },
              { label: 'Linear', description: 'linear teams' },
            ],
            multiSelect: false,
          },
        ],
      },
    ])
  })

  it('marks a question answered when its tool_result lands', () => {
    const events: TranscriptEvent[] = [
      {
        type: 'tool_call',
        name: 'AskUserQuestion',
        callId: 'q2',
        input: { questions: [{ question: 'Which tracker?', options: [{ label: 'GitHub' }], multiSelect: false }] },
        raw: {},
      },
      { type: 'tool_result', callId: 'q2', output: { answers: { 'Which tracker?': 'GitHub' } }, isError: false, raw: null },
    ]
    const item = reduceTranscript(meta, events)[1]
    expect(item).toMatchObject({ kind: 'question', answered: true, answers: { 'Which tracker?': 'GitHub' } })
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

  it('stops on the human (needs-approval) while an AskUserQuestion is unanswered', () => {
    const asked: TranscriptEvent[] = [
      { type: 'tool_call', name: 'AskUserQuestion', input: { questions: [] }, callId: 'q1', raw: {} },
    ]
    expect(sessionStatus(meta, asked)).toBe('needs-approval')
    // ...and resumes running once its answer (tool_result) lands.
    const answered: TranscriptEvent[] = [
      ...asked,
      { type: 'tool_result', callId: 'q1', output: { answers: {} }, isError: false, raw: null },
    ]
    expect(sessionStatus(meta, answered)).toBe('running')
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
