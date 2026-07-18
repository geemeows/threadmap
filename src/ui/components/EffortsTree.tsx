// Left pane of the locked IA (#8), rebuilt on shadcn Sidebar (#64): efforts
// tree with per-effort sessions, ad-hoc sessions, and the workspace-wide
// Needs-you section. The search box opens the ⌘K palette.

import { ChevronRight, Search } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { adhocSessions, effortSessions, needsYou, sessionLabel } from '../lib/derive.js'
import type { SessionRowView } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import { StatusDot } from './particles.js'

export function EffortsTree() {
  const state = useStore()
  const queue = needsYou(state)
  const adhoc = adhocSessions(state)

  return (
    <Sidebar collapsible="none" className="border-r bg-[color-mix(in_srgb,var(--panel)_60%,var(--bg))]">
      <SidebarHeader>
        <InputGroup className="cursor-pointer bg-popover" onClick={() => store.setPaletteOpen(true)}>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            readOnly
            tabIndex={-1}
            placeholder="Search…"
            className="cursor-pointer"
            onFocus={(event) => {
              event.currentTarget.blur()
              store.setPaletteOpen(true)
            }}
          />
          <InputGroupAddon align="inline-end">
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </InputGroupAddon>
        </InputGroup>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Efforts</SidebarGroupLabel>
          <SidebarGroupContent>
            {!state.loaded && (
              <div className="flex flex-col gap-1.5 px-2 py-1">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-6 w-full" style={{ opacity: 1 - i * 0.25 }} />
                ))}
              </div>
            )}
            {state.loaded && state.efforts.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">
                No efforts yet — a <span className="font-mono">wayfinder:map</span> issue in a workspace repo becomes
                one.
              </div>
            )}
            <SidebarMenu>
              {state.efforts.map((effort) => {
                const active = state.selectedEffort === effort.ref.id
                return (
                  <Collapsible key={effort.ref.id} open={active}>
                    <SidebarMenuItem>
                      <CollapsibleTrigger
                        render={
                          <SidebarMenuButton isActive={active} onClick={() => store.selectEffort(effort.ref.id)} />
                        }
                      >
                        <ChevronRight
                          className={cn('text-muted-foreground transition-transform', active && 'rotate-90')}
                        />
                        <span>{effort.title}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          <SidebarMenuSubItem>
                            <span className="flex h-6 items-center px-2 font-mono text-xs text-muted-foreground">
                              {effort.ref.display}
                            </span>
                          </SidebarMenuSubItem>
                          {effortSessions(state, effort.ref.id).map((row) => (
                            <SidebarMenuSubItem key={row.view.meta.id}>
                              <SidebarMenuSubButton
                                size="sm"
                                isActive={state.selectedSession === row.view.meta.id}
                                render={<button type="button" onClick={() => store.selectSession(row.view.meta.id)} />}
                              >
                                <StatusDot status={row.status} />
                                <span>{sessionLabel(row.view)}</span>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {adhoc.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Ad-hoc sessions</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adhoc.map((row) => (
                  <SessionItem key={row.view.meta.id} row={row} active={state.selectedSession === row.view.meta.id} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel>Needs you</SidebarGroupLabel>
          <SidebarGroupContent>
            {queue.length === 0 && <div className="px-2 text-xs text-muted-foreground">Nothing waiting on you.</div>}
            <SidebarMenu>
              {queue.map((row) => (
                <SessionItem key={row.view.meta.id} row={row} active={false} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}

function SessionItem({ row, active }: { row: SessionRowView; active: boolean }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="sm" isActive={active} onClick={() => store.selectSession(row.view.meta.id)}>
        <StatusDot status={row.status} />
        <span>{sessionLabel(row.view)}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
