// Label spelling shared by both adapters. #19 §9 gave each adapter its own
// spelling, with a flat colon-free fallback for Linear; #20 verified literal
// colons are safe via the Linear API (§10.1 of docs/research/linear-api.md),
// so both trackers spell the vocabulary identically and the fallback is dead.
//
// Logical names arrive namespace-free ('ticket', 'spec', 'ticketed',
// 'override:<stage>') and are spelled `threadmap:<name>`; `wayfinder:*`
// names arrive already namespaced and pass through literally.

export const THREADMAP_PREFIX = 'threadmap:'
export const WAYFINDER_PREFIX = 'wayfinder:'

export function spellLabel(logical: string): string {
  return logical.startsWith(WAYFINDER_PREFIX) ? logical : `${THREADMAP_PREFIX}${logical}`
}

/** Inverse of spellLabel; null for labels outside the vocabulary. */
export function logicalName(spelled: string): string | null {
  if (spelled.startsWith(THREADMAP_PREFIX)) return spelled.slice(THREADMAP_PREFIX.length)
  if (spelled.startsWith(WAYFINDER_PREFIX)) return spelled
  return null
}

export const TICKET_LABEL = spellLabel('ticket')
export const SPEC_LABEL = spellLabel('spec')

/**
 * The full label vocabulary threadmap stamps and queries (flat, colon-safe).
 * Provisioned into every Linear workspace (#20/#21) and every confirmed
 * GitHub repo (#43) during setup.
 */
export const VOCABULARY_LABELS = [
  'wayfinder:map',
  'wayfinder:research',
  'wayfinder:prototype',
  'wayfinder:grilling',
  'wayfinder:task',
  'threadmap:ticket',
  'threadmap:spec',
  'threadmap:ticketed',
  'threadmap:override:planning',
  'threadmap:override:to-spec',
  'threadmap:override:to-tickets',
  'threadmap:override:implement',
  'threadmap:override:code-review',
]

/** True when `spelled` falls in the given namespace filter. */
export function inNamespace(spelled: string, ns: 'wayfinder' | 'ticket'): boolean {
  return ns === 'wayfinder' ? spelled.startsWith(WAYFINDER_PREFIX) : spelled === TICKET_LABEL
}
