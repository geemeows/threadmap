import { describe, expect, it } from 'vitest'
import { assertCreatable } from './mcp.js'

describe('assertCreatable — per-stage create_issue gate', () => {
  it('lets a planning session create wayfinder:* children', () => {
    expect(() => assertCreatable('planning', ['wayfinder:research'])).not.toThrow()
    expect(() => assertCreatable('planning', ['wayfinder:task'])).not.toThrow()
  })

  it('blocks a planning session from minting implementation tickets or the spec', () => {
    expect(() => assertCreatable('planning', ['ticket'])).toThrow(/wayfinder:\* children/)
    expect(() => assertCreatable('planning', ['spec'])).toThrow(/wayfinder:\* children/)
    // A wayfinder label alongside a ticket is still a ticket — reject.
    expect(() => assertCreatable('planning', ['wayfinder:task', 'ticket'])).toThrow()
  })

  it('blocks a planning session from creating an unlabelled child (the "implement: …" hole)', () => {
    expect(() => assertCreatable('planning', [])).toThrow(/wayfinder:\* children/)
  })

  it('keeps each downstream stage to its own artifact', () => {
    expect(() => assertCreatable('to-spec', ['spec'])).not.toThrow()
    expect(() => assertCreatable('to-spec', ['ticket'])).toThrow(/those come from \/to-tickets/)
    expect(() => assertCreatable('to-tickets', ['ticket'])).not.toThrow()
    expect(() => assertCreatable('to-tickets', ['spec'])).toThrow(/not the spec/)
  })

  it('imposes no restriction when the stage is unknown or unset', () => {
    expect(() => assertCreatable(undefined, ['ticket'])).not.toThrow()
    expect(() => assertCreatable('implement', ['ticket'])).not.toThrow()
  })
})
