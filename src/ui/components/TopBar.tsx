// Top bar of the Mint Workspace shell (#78): diamond logo + wordmark, the
// workspace identity pill, an effort breadcrumb, then the right cluster —
// "Needs you" inbox, readiness gear (with a status dot), theme toggle. Matches
// the Threadline Workspace design exactly; the workspace-cost and dev badges
// the mockup omits are dropped (per-session cost still lives in the pane).
// Store wiring is unchanged from the #64 bar.

import { Moon, Settings2, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { needsYou } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import { DiamondLogo, MintPill, RefBadge, WorkspacePill } from './particles.js'

export function TopBar() {
  const state = useStore()
  const queue = needsYou(state)
  const inboxCount = queue.length + state.notices.length
  const effort = state.efforts.find((e) => e.ref.id === state.selectedEffort) ?? null
  const workspaceName = state.workspace ? state.workspace.root.split('/').filter(Boolean).pop() : '…'
  const repoCount = state.workspace?.repos?.length
  const setupReady = state.setup?.ready ?? true

  return (
    <header className="flex flex-none items-center gap-3.5 border-b px-4 py-[11px]">
      {/* brand */}
      <div className="flex items-center gap-[9px] text-[15px] font-bold tracking-[-0.015em]">
        <DiamondLogo />
        Threadmap
      </div>

      {/* workspace identity */}
      <WorkspacePill name={workspaceName ?? '…'} repoCount={repoCount} />

      {/* effort breadcrumb */}
      {effort && (
        <div className="flex min-w-0 items-center gap-[7px] text-[12.5px] text-[var(--fg3)]">
          <span aria-hidden>/</span>
          <span className="truncate font-medium text-muted-foreground">{effort.title}</span>
          <RefBadge>{effort.ref.display}</RefBadge>
        </div>
      )}

      {/* connection state — not in the mockup, restyled to the design language */}
      {state.conn !== 'open' && (
        <MintPill
          indicator="pulse"
          className="animate-enter-soft border-[color:color-mix(in_srgb,var(--amber)_38%,transparent)] bg-warning/[0.08] text-warning"
        >
          {state.conn === 'connecting' ? 'connecting…' : 'reconnecting…'}
        </MintPill>
      )}

      {/* right cluster */}
      <div className="ml-auto flex items-center gap-[9px]">
        {inboxCount > 0 && (
          <button
            type="button"
            onClick={() => store.setInboxOpen(true)}
            className="inline-flex items-center gap-2 rounded-[9px] border border-warning/40 bg-warning/[0.08] px-3 py-1.5 text-[12.5px] font-semibold text-warning transition-opacity hover:opacity-85"
          >
            <span aria-hidden className="tl-pulse size-[7px] rounded-full bg-warning" />
            Needs you
            <span className="min-w-4 rounded-full bg-warning px-[5px] text-center text-[11px] font-bold text-primary-foreground">
              {inboxCount}
            </span>
          </button>
        )}

        <span aria-hidden className="h-5 w-px bg-border" />

        <button
          type="button"
          title="Workspace readiness"
          onClick={() => store.setSetupOpen(true)}
          className="relative flex size-8 items-center justify-center rounded-[9px] border border-input bg-muted transition-colors hover:bg-secondary"
        >
          <Settings2 className="size-4 text-muted-foreground" />
          <span
            aria-hidden
            className={cn(
              'absolute top-[5px] right-[5px] size-1.5 rounded-full border-[1.5px] border-muted',
              setupReady ? 'bg-primary' : 'tl-pulse bg-warning',
            )}
          />
          <span className="sr-only">Workspace setup</span>
        </button>

        <button
          type="button"
          title="Toggle theme"
          onClick={() => store.toggleTheme()}
          className="flex size-8 items-center justify-center rounded-[9px] border border-input bg-muted transition-colors hover:bg-secondary"
        >
          {state.theme === 'dark' ? (
            <Sun className="size-4 text-muted-foreground" />
          ) : (
            <Moon className="size-4 text-muted-foreground" />
          )}
          <span className="sr-only">Toggle theme</span>
        </button>
      </div>
    </header>
  )
}
