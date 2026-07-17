// Label spelling shared by both adapters. #19 §9 gave each adapter its own
// spelling, with a flat colon-free fallback for Linear; #20 verified literal
// colons are safe via the Linear API (§10.1 of docs/research/linear-api.md),
// so both trackers spell the vocabulary identically and the fallback is dead.
//
// Logical names arrive namespace-free ('ticket', 'spec', 'ticketed',
// 'override:<stage>') and are spelled `threadline:<name>`; `wayfinder:*`
// names arrive already namespaced and pass through literally.

export const THREADLINE_PREFIX = 'threadline:'
export const WAYFINDER_PREFIX = 'wayfinder:'

export function spellLabel(logical: string): string {
  return logical.startsWith(WAYFINDER_PREFIX) ? logical : `${THREADLINE_PREFIX}${logical}`
}

/** Inverse of spellLabel; null for labels outside the vocabulary. */
export function logicalName(spelled: string): string | null {
  if (spelled.startsWith(THREADLINE_PREFIX)) return spelled.slice(THREADLINE_PREFIX.length)
  if (spelled.startsWith(WAYFINDER_PREFIX)) return spelled
  return null
}

export const TICKET_LABEL = spellLabel('ticket')
export const SPEC_LABEL = spellLabel('spec')

/** True when `spelled` falls in the given namespace filter. */
export function inNamespace(spelled: string, ns: 'wayfinder' | 'ticket'): boolean {
  return ns === 'wayfinder' ? spelled.startsWith(WAYFINDER_PREFIX) : spelled === TICKET_LABEL
}
