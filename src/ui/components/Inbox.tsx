// Global approvals inbox (#8), rebuilt to the mint Threadline Workspace design
// (#83) on the shared OverlayShell particle (#78 vocabulary). The Soft Depth
// right-side Sheet (#67) is retired for the mockup's centered "Needs you"
// modal: one flat list of everything blocked on the human — pipeline notices
// and per-session approvals — as dot + title + mono sub + trailing pill rows.
// Inline-in-chat stays canonical: an approval row jumps to its session's chat
// (closing the modal). Notices keep their Dismiss. Behavior is otherwise
// unchanged from the #8 inbox.

import { Inbox as InboxIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { needsYou, sessionLabel } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import { pendingApprovals } from '../lib/transcript.js'
import { OverlayShell, StatusBadge, StatusDot } from './particles.js'

export function Inbox() {
  const state = useStore()
  const queue = needsYou(state)
  const waiting = queue.length + state.notices.length

  return (
    <OverlayShell
      open={state.inboxOpen}
      onOpenChange={(open) => store.setInboxOpen(open)}
      title="Needs you"
      description="Sessions and notices waiting on your input, workspace-wide."
      width={540}
      afterTitle={
        <span className="text-xs text-[var(--fg3)]">
          {waiting} item{waiting === 1 ? '' : 's'} waiting
        </span>
      }
    >
      {waiting === 0 ? (
        <Empty className="border-none py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>You’re all caught up</EmptyTitle>
            <EmptyDescription>Nothing is waiting on you right now.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="max-h-[64vh]">
          <div className="flex flex-col">
            {state.notices.map((n) => (
              <div key={n.id} className="flex items-center gap-3 border-b border-border px-[18px] py-3.5 last:border-b-0">
                <StatusDot status="needs-approval" className="size-2" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-foreground">{n.title}</div>
                  <div className="truncate font-mono text-[11px] text-[var(--fg3)]">
                    {n.effort} · {n.text}
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => store.dismissNotice(n.id)}>
                  Dismiss
                </Button>
              </div>
            ))}
            {queue.map(({ view, status }) => {
              const approvals = pendingApprovals(view.events)
              return (
                <button
                  key={view.meta.id}
                  type="button"
                  onClick={() => store.selectSession(view.meta.id)}
                  className="flex w-full items-center gap-3 border-b border-border px-[18px] py-3.5 text-left transition-colors last:border-b-0 hover:bg-secondary/60"
                >
                  <StatusDot status={status} className="size-2" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-foreground">{sessionLabel(view)}</div>
                    <div className="truncate font-mono text-[11px] text-[var(--fg3)]">
                      {view.meta.effort ?? view.meta.cwd}
                      {approvals.length > 0 && ` · ${approvals.map((a) => a.tool).join(', ')} pending`}
                    </div>
                  </div>
                  <StatusBadge status={status} className="shrink-0" />
                </button>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </OverlayShell>
  )
}
