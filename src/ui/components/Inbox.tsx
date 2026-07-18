// Global approvals inbox (#8), rebuilt on shadcn (Base UI) in the Soft Depth
// direction (#67): a right-side Sheet drawer — every session blocked on the
// human, plus pipeline notices, in one list. Rows are Items; the empty state
// is an Empty. Inline-in-chat stays canonical — a row jumps to its session's
// chat (which closes the drawer). Behavior is unchanged from the #8 inbox.

import { Inbox as InboxIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { needsYou, sessionLabel } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import { pendingApprovals } from '../lib/transcript.js'
import { CostBadge, StatusBadge, StatusDot } from './particles.js'

export function Inbox() {
  const state = useStore()
  const queue = needsYou(state)
  const waiting = queue.length + state.notices.length

  return (
    <Sheet open={state.inboxOpen} onOpenChange={store.setInboxOpen}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="flex-row items-center gap-2.5 border-b">
          <SheetTitle>Needs you</SheetTitle>
          <SheetDescription className="sr-only">
            Sessions and notices waiting on your input, workspace-wide.
          </SheetDescription>
          <span className="text-xs text-muted-foreground">
            {waiting} item{waiting === 1 ? '' : 's'} waiting
          </span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => store.setInboxOpen(false)}>
            <X />
            <span className="sr-only">Close</span>
          </Button>
        </SheetHeader>

        {waiting === 0 ? (
          <Empty className="flex-1 border-none">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>You’re all caught up</EmptyTitle>
              <EmptyDescription>Nothing is waiting on you right now.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-3">
              {state.notices.map((n) => (
                <Item key={n.id} variant="outline" size="sm">
                  <ItemMedia>
                    <StatusDot status="needs-approval" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{n.title}</ItemTitle>
                    <ItemDescription className="font-mono">
                      {n.effort} · {n.text}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button variant="ghost" size="sm" onClick={() => store.dismissNotice(n.id)}>
                      Dismiss
                    </Button>
                  </ItemActions>
                </Item>
              ))}
              {queue.map(({ view, status }) => {
                const approvals = pendingApprovals(view.events)
                return (
                  <Item
                    key={view.meta.id}
                    variant="outline"
                    size="sm"
                    render={<button type="button" onClick={() => store.selectSession(view.meta.id)} />}
                    className="cursor-pointer text-left transition-colors hover:bg-muted/50"
                  >
                    <ItemMedia>
                      <StatusDot status={status} />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{sessionLabel(view)}</ItemTitle>
                      <ItemDescription className="font-mono">
                        {view.meta.effort ?? view.meta.cwd}
                        {approvals.length > 0 && ` · ${approvals.map((a) => a.tool).join(', ')} pending`}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <StatusBadge status={status} />
                      <CostBadge usage={view.meta.usage} />
                    </ItemActions>
                  </Item>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}
