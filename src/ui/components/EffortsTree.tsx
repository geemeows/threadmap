// Left pane of the locked IA (#8), rebuilt to the Mint Workspace design (#79)
// on the #78 particle set: a mint search box that opens ⌘K, the efforts tree
// (kept expandable so per-effort sessions stay switchable here — the hybrid the
// human chose over the mockup's flat rows), a Repos readiness list, and a
// dev-server footer. Needs-you moved to the top-bar inbox (#78); ad-hoc sessions
// keep their left-pane home since session switching lives here.

import { Menu } from '@base-ui/react/menu'
import { ChevronRight, Circle, FolderGit2, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import {
  adhocSessions,
  type EffortStatus,
  effortSessions,
  effortStatus,
  sessionLabel,
} from '../lib/derive.js'
import type { SessionRowView } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import type { EffortSummary } from '../lib/types.js'
import { RefBadge, SectionLabel, StatusDot } from './particles.js'

/** Effort-row dot: running/needs-you pulse in the mint motion vocabulary; idle
 *  and done read as a static tertiary dot (matching the mockup's grey rows). */
const EFFORT_DOT: Record<EffortStatus, string> = {
  running: 'bg-success tl-pulse',
  'needs-approval': 'bg-warning tl-pulse',
  'waiting-human': 'bg-info',
  idle: 'bg-[var(--fg3)]',
  done: 'bg-[var(--fg3)]',
}

export function EffortsTree() {
  const state = useStore()
  const adhoc = adhocSessions(state)
  const repos = reposView(state)
  const devHost = typeof window !== 'undefined' ? window.location.host : 'localhost'
  const connDot =
    state.conn === 'open'
      ? 'bg-success'
      : state.conn === 'connecting'
        ? 'bg-warning tl-pulse'
        : 'bg-destructive'

  return (
    <Sidebar collapsible="none" className="border-r bg-[color-mix(in_srgb,var(--panel)_60%,var(--bg))]">
      <SidebarHeader className="px-3 pt-3 pb-2.5">
        <InputGroup className="cursor-pointer rounded-[10px] bg-popover" onClick={() => store.setPaletteOpen(true)}>
          <InputGroupAddon>
            <Circle className="text-[var(--fg3)]" />
          </InputGroupAddon>
          <InputGroupInput
            readOnly
            tabIndex={-1}
            placeholder="Search efforts, tickets, repos…"
            className="cursor-pointer text-[12.5px]"
            // Button in disguise: don't let it grab focus on click, or the
            // resulting focusout dismisses the palette it just opened. Opening
            // is handled by the InputGroup's onClick.
            onMouseDown={(event) => event.preventDefault()}
          />
          <InputGroupAddon align="inline-end">
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </InputGroupAddon>
        </InputGroup>
      </SidebarHeader>

      <SidebarContent className="px-2 pb-3">
        <SidebarGroup className="p-0">
          <div className="flex items-center justify-between px-2 pt-2 pb-1.5">
            <SectionLabel>Efforts</SectionLabel>
            <button
              type="button"
              title="New effort"
              onClick={() => store.setNewEffortOpen(true)}
              className="inline-flex size-5 items-center justify-center rounded-md text-[var(--fg3)] transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-4" />
            </button>
          </div>
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
              {state.efforts.map((effort) => (
                <EffortRow key={effort.ref.id} effort={effort} state={state} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {adhoc.length > 0 && (
          <SidebarGroup className="p-0">
            <div className="px-2 pt-4 pb-1.5">
              <SectionLabel>Ad-hoc sessions</SectionLabel>
            </div>
            <SidebarGroupContent>
              <SidebarMenu>
                {adhoc.map((row) => (
                  <SessionItem key={row.view.meta.id} row={row} active={state.selectedSession === row.view.meta.id} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup className="p-0">
          <div className="px-2 pt-4 pb-1.5">
            <SectionLabel>Repos</SectionLabel>
          </div>
          <SidebarGroupContent>
            {!state.loaded && (
              <div className="flex flex-col gap-1.5 px-2 py-1">
                {[0, 1].map((i) => (
                  <Skeleton key={i} className="h-6 w-full" style={{ opacity: 1 - i * 0.3 }} />
                ))}
              </div>
            )}
            {state.loaded && repos.length === 0 && (
              <div className="px-2 text-xs text-muted-foreground">No repos discovered in this workspace.</div>
            )}
            {repos.map((repo) => (
              <div
                key={repo.name}
                className="flex items-center gap-[9px] rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted-foreground"
              >
                <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', repo.dot)} />
                <FolderGit2 className="size-3.5 shrink-0 text-[var(--fg3)]" />
                <span className="flex-1 truncate font-mono text-[11.5px]">{repo.name}</span>
                {repo.state && <span className="text-[10.5px] text-[var(--fg3)]">{repo.state}</span>}
              </div>
            ))}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="flex-row items-center gap-2 border-t px-3.5 py-2.5 text-[11.5px] text-[var(--fg3)]">
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', connDot)} />
        dev server · {devHost}
      </SidebarFooter>
    </Sidebar>
  )
}

/** One effort: a mockup-shaped header row (status dot + title + ref) that
 *  selects the effort, and — kept expandable per the human's call — the effort's
 *  sessions nested beneath while active. */
function EffortRow({ effort, state }: { effort: EffortSummary; state: ReturnType<typeof useStore> }) {
  const active = state.selectedEffort === effort.ref.id
  const status = effortStatus(state, effort)
  const sessions = effortSessions(state, effort.ref.id)

  return (
    <Collapsible open={active}>
      <SidebarMenuItem>
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              isActive={active}
              onClick={() => store.selectEffort(effort.ref.id)}
              className="gap-[9px] rounded-lg text-[13px] font-medium data-[active=true]:bg-[var(--surface2)]"
            />
          }
        >
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-[var(--fg3)] transition-transform', active && 'rotate-90')}
          />
          <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full', EFFORT_DOT[status])} />
          <span className="flex-1 truncate">{effort.title}</span>
          <RefBadge className="text-[10.5px]">{effort.ref.display}</RefBadge>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 pr-0">
            {sessions.length === 0 && (
              <span className="flex h-6 items-center px-2 text-xs text-muted-foreground">No sessions yet.</span>
            )}
            {sessions.map((row) => (
              <SidebarMenuSubItem key={row.view.meta.id} className="group/session relative">
                <SidebarMenuSubButton
                  size="sm"
                  isActive={state.selectedSession === row.view.meta.id}
                  render={<button type="button" onClick={() => store.selectSession(row.view.meta.id)} />}
                >
                  <StatusDot status={row.status} />
                  <span className="truncate">{sessionLabel(row.view)}</span>
                </SidebarMenuSubButton>
                <SessionMenu row={row} />
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

/** Per-session `⋯` menu on an effort's rows. Its one item, "Move to ad-hoc",
 *  detaches a mis-bound session's effort (#102) and is offered on **ended**
 *  sessions only — a running session's in-memory meta would overwrite the disk
 *  edit, so the server refuses it. Revealed on row hover/focus. */
function SessionMenu({ row }: { row: SessionRowView }) {
  const { id, status } = row.view.meta
  if (status !== 'ended') return null

  const moveToAdhoc = () => {
    store.detachEffort(id)
    toast.success('Moved to ad-hoc')
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        title="Session actions"
        className="absolute inset-y-0 right-1 my-auto inline-flex size-5 items-center justify-center rounded-md text-[var(--fg3)] opacity-0 transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/session:opacity-100 data-[popup-open]:opacity-100"
      >
        <MoreHorizontal className="size-3.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className="min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none">
            <Menu.Item
              onClick={moveToAdhoc}
              className="flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-[12.5px] outline-none data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
            >
              Move to ad-hoc
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function SessionItem({ row, active }: { row: SessionRowView; active: boolean }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="sm" isActive={active} onClick={() => store.selectSession(row.view.meta.id)}>
        <StatusDot status={row.status} />
        <span className="truncate">{sessionLabel(row.view)}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

interface RepoView {
  name: string
  /** Readiness label — omitted when readiness is unknown (setup not yet run). */
  state: string | null
  dot: string
}

/** Repo rows: readiness from the setup snapshot when present (#6), else a plain
 *  discovered-repo list from the workspace with no readiness verdict yet. */
function reposView(state: ReturnType<typeof useStore>): RepoView[] {
  if (state.setup?.repos.length) {
    return state.setup.repos.map((r) => ({
      name: r.name,
      state: r.ready ? 'ready' : 'setup needed',
      dot: r.ready ? 'bg-success' : 'bg-warning',
    }))
  }
  return (state.workspace?.repos ?? []).map((r) => ({ name: r.name, state: null, dot: 'bg-[var(--fg3)]' }))
}
