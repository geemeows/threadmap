import { describe, expect, it } from 'vitest'
import { deriveStage } from './derive.js'
import type { GateInputs, PRInfo, TicketView } from './types.js'

function ticket(n: number, over: Partial<TicketView> = {}): TicketView {
  return {
    ref: { id: `o/r#${n}`, display: `o/r#${n}`, url: `https://github.com/o/r/issues/${n}` },
    closed: false,
    pr: null,
    ...over,
  }
}

function pr(over: Partial<PRInfo> = {}): PRInfo {
  return { url: 'https://github.com/o/r/pull/9', state: 'open', unresolvedReviewThreads: 0, ...over }
}

function inputs(over: Partial<GateInputs> = {}): GateInputs {
  return { openPlanningChildren: 0, spec: 'none', stamps: [], tickets: [], ...over }
}

describe('deriveStage', () => {
  it('exposes the ticket views on the snapshot for per-ticket UI actions', () => {
    const tickets = [ticket(2, { pr: pr({ conflicting: true }) }), ticket(3)]
    expect(deriveStage(inputs({ tickets })).tickets).toEqual(tickets)
  })

  it('sits at planning while wayfinder children are open', () => {
    const snap = deriveStage(inputs({ openPlanningChildren: 2 }))
    expect(snap.stage).toBe('planning')
    expect(snap.gates[0]!.unmet[0]).toMatch(/2 open wayfinder/)
  })

  it('moves to to-spec when planning children close', () => {
    expect(deriveStage(inputs()).stage).toBe('to-spec')
  })

  it('holds to-spec on an open or auto-closed spec, passes on approved', () => {
    expect(deriveStage(inputs({ spec: 'open' })).stage).toBe('to-spec')
    expect(deriveStage(inputs({ spec: 'auto-closed' })).stage).toBe('to-spec')
    expect(deriveStage(inputs({ spec: 'auto-closed' })).gates[1]!.unmet[0]).toMatch(/automation/)
    expect(deriveStage(inputs({ spec: 'approved' })).stage).toBe('to-tickets')
  })

  it('to-tickets needs both tickets and the human ticketed stamp', () => {
    const base = { spec: 'approved' as const }
    expect(deriveStage(inputs({ ...base, tickets: [ticket(2)] })).stage).toBe('to-tickets')
    expect(deriveStage(inputs({ ...base, stamps: ['ticketed'] })).stage).toBe('to-tickets')
    expect(deriveStage(inputs({ ...base, stamps: ['ticketed'], tickets: [ticket(2)] })).stage).toBe(
      'implement',
    )
  })

  it('implement requires every ticket to have a live-or-merged PR into the trunk', () => {
    const base = inputs({ spec: 'approved', stamps: ['ticketed'] })
    const noPr = deriveStage({ ...base, tickets: [ticket(2, { pr: pr() }), ticket(3)] })
    expect(noPr.stage).toBe('implement')
    expect(noPr.gates[3]!.unmet).toEqual(['o/r#3 has no PR targeting the effort trunk'])

    const abandoned = deriveStage({ ...base, tickets: [ticket(2, { pr: pr({ state: 'closed' }) })] })
    expect(abandoned.stage).toBe('implement')

    const allLinked = deriveStage({ ...base, tickets: [ticket(2, { pr: pr() })] })
    expect(allLinked.stage).toBe('code-review')
  })

  it('code-review requires merged PRs, resolved threads, and closed tickets', () => {
    const base = inputs({ spec: 'approved', stamps: ['ticketed'] })
    const cases: [TicketView, RegExp][] = [
      [ticket(2, { pr: pr({ state: 'open' }), closed: true }), /not merged/],
      [ticket(2, { pr: pr({ state: 'merged', unresolvedReviewThreads: 3 }), closed: true }), /3 unresolved/],
      [ticket(2, { pr: pr({ state: 'merged' }), closed: false }), /not closed/],
    ]
    for (const [t, why] of cases) {
      const snap = deriveStage({ ...base, tickets: [t] })
      expect(snap.stage).toBe('code-review')
      expect(snap.readyToComplete).toBe(false)
      expect(snap.gates[4]!.unmet.join('; ')).toMatch(why)
    }
  })

  it('is readyToComplete only when every gate passes', () => {
    const snap = deriveStage(
      inputs({
        spec: 'approved',
        stamps: ['ticketed'],
        tickets: [ticket(2, { pr: pr({ state: 'merged' }), closed: true })],
      }),
    )
    expect(snap.stage).toBe('code-review')
    expect(snap.readyToComplete).toBe(true)
  })

  it('an override stamp passes a failing gate without marking it met', () => {
    const snap = deriveStage(inputs({ openPlanningChildren: 1, stamps: ['override:planning'] }))
    expect(snap.stage).toBe('to-spec')
    expect(snap.gates[0]).toMatchObject({ met: false, overridden: true })
  })

  it('a fully overridden pipeline is readyToComplete', () => {
    const snap = deriveStage(
      inputs({
        stamps: [
          'override:planning',
          'override:to-spec',
          'override:to-tickets',
          'override:implement',
          'override:code-review',
        ],
      }),
    )
    expect(snap.readyToComplete).toBe(true)
  })
})

describe('warnings', () => {
  it('surfaces a missing Ticket reference as a warning, never a gate condition', () => {
    const snap = deriveStage(
      inputs({
        tickets: [
          ticket(2, { pr: pr({ missingTicketRef: true }) }),
          ticket(3, { pr: pr() }),
          ticket(4, { pr: pr({ state: 'closed', missingTicketRef: true }) }), // abandoned — ignored
        ],
      }),
    )
    expect(snap.warnings).toEqual(['o/r#2\'s PR body is missing its "Ticket: #<n>" reference'])
    expect(snap.gates.flatMap((g) => g.unmet).join()).not.toContain('Ticket:')
  })
})
