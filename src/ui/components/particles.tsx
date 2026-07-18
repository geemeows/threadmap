// Shared Soft Depth particles (#64): the session-status vocabulary rendered
// as dots and Badge pills, plus the cost badge. The redesigned surfaces use
// these; the legacy panes keep primitives.tsx until their own rebuild.

import type { MouseEventHandler, ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { fmtTokens } from '../lib/derive.js'
import type { SessionStatus, Usage } from '../lib/types.js'

/** Status → Soft Depth styling: dot classes + tinted Badge pill classes. */
export const STATUS_UI: Record<SessionStatus, { label: string; dot: string; pill: string }> = {
  running: {
    label: 'Active',
    dot: 'bg-success animate-pulse',
    pill: 'bg-success/12 text-success',
  },
  'needs-approval': {
    label: 'Needs you',
    dot: 'bg-warning animate-pulse',
    pill: 'bg-warning/12 text-warning',
  },
  'waiting-human': {
    label: 'Waiting',
    dot: 'bg-info',
    pill: 'bg-info/12 text-info',
  },
  done: {
    label: 'Done',
    dot: 'bg-muted-foreground/60',
    pill: 'bg-muted text-muted-foreground',
  },
}

export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_UI[status].dot, className)} />
}

/* ---------------------------------------------------------------------------
 * Mint Workspace frame particles (#78) — the shared vocabulary the redesigned
 * shell (top bar + three panes) reuses so surfaces don't diverge. Each mirrors
 * an inline-styled element in the Threadline Workspace design, rebuilt on the
 * mint token contract (#77): mint = primary, mint-tint = accent, mint-ink =
 * primary-foreground; the raw --mint-line / --fg3 vars carry design-only tones.
 * ------------------------------------------------------------------------- */

/** Diamond logo: a 45°-rotated mint square haloed by a mint-tint ring. The
 *  workspace brand mark — top bar, onboarding rail, and the agent avatar. */
export function DiamondLogo({ className, size = 18 }: { className?: string; size?: number }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rotate-45 rounded-[4px] bg-primary', className)}
      style={{ width: size, height: size, boxShadow: '0 0 0 4px var(--mint-tint)' }}
    />
  )
}

/** Workspace pill: mint dot + workspace name + optional repo count, on a
 *  bordered popover-surface pill. The top bar's workspace identity. */
export function WorkspacePill({ name, repoCount, className }: { name: string; repoCount?: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-[9px] border bg-popover px-[11px] py-[5px] text-[12.5px] font-semibold text-foreground',
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      {name}
      {repoCount != null && (
        <span className="text-[11px] font-normal text-[var(--fg3)]">
          {repoCount} {repoCount === 1 ? 'repo' : 'repos'}
        </span>
      )}
    </span>
  )
}

/** RefBadge: a branch/issue ref in mono, tertiary tone. Reused wherever the
 *  design shows a `ref` beside a title (breadcrumb, effort rows, tickets). */
export function RefBadge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[11.5px] text-[var(--fg3)]', className)}>{children}</span>
}

/** SectionLabel: the uppercase micro-heading over a pane section (Efforts,
 *  Repos, Pipeline). Tight tracking, tertiary tone. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('text-[11px] font-semibold tracking-[0.04em] text-[var(--fg3)] uppercase', className)}>
      {children}
    </span>
  )
}

/** MintPill: the accent status pill (active stage, running session, ready) —
 *  mint-tint fill, mint-line hairline, mint text, with an optional leading
 *  indicator: a `pulse` dot or a `spin` ring (both from the tl-* vocabulary). */
export function MintPill({
  children,
  indicator = 'none',
  className,
}: {
  children: ReactNode
  indicator?: 'pulse' | 'spin' | 'none'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[7px] rounded-full border border-[color:var(--mint-line)] bg-accent px-3 py-1 text-xs font-semibold text-primary',
        className,
      )}
    >
      {indicator === 'pulse' && <span aria-hidden className="tl-pulse size-[7px] rounded-full bg-primary" />}
      {indicator === 'spin' && (
        <span aria-hidden className="tl-spin inline-block size-2.5 rounded-full border-[1.5px] border-primary border-r-transparent" />
      )}
      {children}
    </span>
  )
}

/** Rounded status pill: dot + label (or custom children), tinted per status.
 *  Pass `onClick` to render it as a clickable pill. */
export function StatusBadge({
  status,
  children,
  className,
  onClick,
  title,
}: {
  status: SessionStatus
  children?: ReactNode
  className?: string
  onClick?: MouseEventHandler<HTMLButtonElement>
  title?: string
}) {
  return (
    <Badge
      variant="outline"
      render={onClick ? <button type="button" onClick={onClick} /> : undefined}
      title={title}
      className={cn(
        'gap-1.5 border-transparent',
        STATUS_UI[status].pill,
        onClick && 'cursor-pointer transition-opacity hover:opacity-80',
        className,
      )}
    >
      <StatusDot status={status} />
      {children ?? STATUS_UI[status].label}
    </Badge>
  )
}

/** Ticks: discrete micro-progress — `done` of `total` small segments filled.
 *  Reads at a glance on the pipeline rail (e.g. ticket PRs merged). */
export function Ticks({ done, total, className }: { done: number; total: number; className?: string }) {
  if (total <= 0) return null
  return (
    <span aria-hidden className={cn('inline-flex items-center gap-0.5', className)}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn('h-1 w-3 rounded-full transition-colors', i < done ? 'bg-success' : 'bg-muted-foreground/20')}
        />
      ))}
    </span>
  )
}

export function CostBadge({ usage, className }: { usage?: Usage; className?: string }) {
  if (!usage) return null
  const cost = usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(2)}` : ''
  const tokens = `${fmtTokens(usage.inputTokens)}▸${fmtTokens(usage.outputTokens)}`
  return (
    <Badge variant="outline" title="cost · tokens in▸out" className={cn('font-mono text-muted-foreground', className)}>
      {[cost, tokens].filter(Boolean).join(' · ')}
    </Badge>
  )
}

/** CodeBlock: a titled, scrollable mono panel for proposed file content / diffs
 *  — the setup docs-plan review renders each planned file through this. The
 *  header carries the file path (title) and an action tag (meta). */
export function CodeBlock({
  title,
  meta,
  children,
  className,
}: {
  title?: ReactNode
  meta?: ReactNode
  children: string
  className?: string
}) {
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-card/50', className)}>
      {(title || meta) && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-2.5 py-1.5">
          {title && <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground">{title}</span>}
          {meta && <span className="ml-auto shrink-0 text-[11px] tracking-wide text-muted-foreground uppercase">{meta}</span>}
        </div>
      )}
      <pre className="max-h-56 overflow-auto px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {children}
      </pre>
    </div>
  )
}
