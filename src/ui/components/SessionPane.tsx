// Right pane of the locked IA (#8), rebuilt to the Threadline Workspace mint
// design (#81) on the #78 particle vocabulary. Sessions ride a scrollable tab
// strip (status dot + label, mint underline on the active one) with a trailing
// `+` that opens the new-session dialog; a header carries the session title, its
// mono cwd, a live mint running pill, and — folded in from the real app, which
// the mockup omits — pause/kill controls. The transcript renders the design's
// message vocabulary: centered mono system lines, a hollow mint-diamond-avatar'd
// agent turn, an end-aligned user bubble, a flat mono tool row that stays
// EXPANDABLE into input/output (the #80 hybrid), and a full-width amber approval
// card. The composer sits in a surface card under clickable command chips that
// prefill it, with a `headless · <adapter>` runner line and a mint Send button.
// Behavior is unchanged from the #8/#66 pane — approvals resolve inline, the
// global inbox links here, drafts survive a dropped socket.

import { ChevronRight, Pause, Terminal, TriangleAlert, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { adhocSessions, effortSessions, sessionLabel, statusOf } from '../lib/derive.js'
import { store, useStore } from '../lib/store.js'
import type { SessionView } from '../lib/store.js'
import { pendingApprovals, reduceTranscript, summarizeInput, summarizeOutput } from '../lib/transcript.js'
import type { ChatItem, QuestionItem, QuestionSpec, ToolItem } from '../lib/transcript.js'
import { MintPill, StatusBadge, StatusDot } from './particles.js'

export function SessionPane() {
  const state = useStore()
  const rows = state.selectedEffort ? effortSessions(state, state.selectedEffort) : adhocSessions(state)
  const selected =
    (state.selectedSession && state.sessions[state.selectedSession]) || rows[rows.length - 1]?.view || null

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {rows.length > 0 && (
        <div className="flex shrink-0 items-center overflow-x-auto border-b">
          {rows.map(({ view, status }) => {
            const active = view.meta.id === selected?.meta.id
            return (
              <button
                key={view.meta.id}
                type="button"
                onClick={() => store.selectSession(view.meta.id)}
                className={cn(
                  'flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-xs transition-colors',
                  active
                    ? 'border-primary font-semibold text-foreground'
                    : 'border-transparent font-medium text-[var(--fg3)] hover:text-foreground',
                )}
              >
                <StatusDot status={status} />
                <span className="max-w-[16rem] truncate">{sessionLabel(view)}</span>
              </button>
            )
          })}
          <button
            type="button"
            title="New session"
            onClick={() => store.setNewSessionOpen(true)}
            className="px-3.5 py-2.5 text-[15px] text-[var(--fg3)] transition-colors hover:text-foreground"
          >
            +
          </button>
        </div>
      )}
      {selected ? (
        <Chat key={selected.meta.id} view={selected} />
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Terminal />
            </EmptyMedia>
            <EmptyTitle>No sessions yet</EmptyTitle>
            <EmptyDescription>Start a session from the pipeline rail — it docks here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}

/** Hollow mint diamond — the design's agent-turn avatar. A tinted, mint-lined
 *  45° square, distinct from the filled brand DiamondLogo. */
function AgentAvatar() {
  return (
    <span
      aria-hidden
      className="mt-0.5 size-[18px] shrink-0 rotate-45 rounded-[3px] border border-[color:var(--mint-line)] bg-accent"
    />
  )
}

function Chat({ view }: { view: SessionView }) {
  const state = useStore()
  const { meta } = view
  const status = statusOf(view)
  const items = reduceTranscript(meta, view.events)
  const disconnected = state.conn !== 'open'
  const repo = meta.cwd.split('/').filter(Boolean).pop()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-foreground">{sessionLabel(view)}</div>
          {repo && <div className="mt-px font-mono text-[11px] text-[var(--fg3)]">cwd geemeows/{repo}</div>}
        </div>
        {status === 'running' ? (
          <MintPill indicator="spin">running</MintPill>
        ) : (
          <StatusBadge status={status} />
        )}
        {meta.status === 'running' && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              title={disconnected ? 'Disconnected — reconnecting' : 'interrupt the agent'}
              disabled={disconnected}
              onClick={() => store.interrupt(meta.id)}
            >
              <Pause />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title={disconnected ? 'Disconnected — reconnecting' : 'kill the session'}
              disabled={disconnected}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => store.kill(meta.id)}
            >
              <X />
            </Button>
          </>
        )}
      </div>

      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-[13px] px-4 py-[18px]">
              {items.map((item, i) => {
                // A stable per-message identity is what lets the scroller's
                // stick-to-bottom track which item is which; without it (the
                // old index-only key left messageId undefined) a fresh
                // scrollAnchor read as unhandled and yanked the view down while
                // you were reading history. Tools/approvals carry natural ids;
                // append-only text items key off their position.
                const id = itemKey(item, i)
                return (
                  <MessageScrollerItem
                    key={id}
                    messageId={id}
                    scrollAnchor={i === items.length - 1}
                    className="animate-enter-soft"
                  >
                    <ChatMessage item={item} sessionId={meta.id} stage={meta.stage} disconnected={disconnected} />
                  </MessageScrollerItem>
                )
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <PendingApprovalBar sessionId={meta.id} events={view.events} disconnected={disconnected} />
      <Composer view={view} disconnected={disconnected} />
    </div>
  )
}

/** Stable identity for a transcript row (see the scroller note above). Tools and
 *  approvals have natural ids; the rest are append-only, so position is stable. */
function itemKey(item: ChatItem, i: number): string {
  if (item.kind === 'tool') return `tool-${item.callId}`
  if (item.kind === 'approval') return `approval-${item.id}`
  return `${item.kind}-${i}`
}

function ChatMessage({
  item,
  sessionId,
  stage,
  disconnected,
}: {
  item: ChatItem
  sessionId: string
  stage?: string
  disconnected: boolean
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="ml-auto max-w-[82%] rounded-[13px_13px_4px_13px] border border-[var(--border2)] bg-[var(--surface2)] px-[13px] py-[9px] text-[13px] whitespace-pre-wrap text-foreground">
          {item.text}
        </div>
      )
    case 'agent':
      return (
        <div className="flex max-w-[86%] gap-2.5">
          <AgentAvatar />
          <div className="min-w-0 text-[13px] whitespace-pre-wrap text-foreground">
            {item.text}
            {item.streaming && <Spinner className="ml-1.5 inline size-3 align-middle text-muted-foreground" />}
          </div>
        </div>
      )
    case 'tool':
      return <ToolCall item={item} />
    case 'question':
      return <QuestionCard item={item} sessionId={sessionId} stage={stage} disconnected={disconnected} />
    case 'system':
      return <div className="self-center font-mono text-[11px] text-[var(--fg3)]">{item.text}</div>
    case 'approval':
      return <ApprovalCard item={item} sessionId={sessionId} disconnected={disconnected} />
  }
}

/** Tool-call particle: the design's flat mono one-liner (tool name · summary) is
 *  the COLLAPSED state; it stays clickable to reveal the full input and (once it
 *  lands) output — the #80 hybrid that folds the real behavior into the mockup's
 *  look. Error results tint the row red. */
function ToolCall({ item }: { item: ToolItem }) {
  const summary = summarizeInput(item.input)
  return (
    <Collapsible className="ml-7 max-w-[90%]">
      <CollapsibleTrigger
        className={cn(
          'group/tool flex w-full min-w-0 items-center gap-2 rounded-lg border bg-[var(--surface)] px-[11px] py-1.5 text-left font-mono text-[11.5px] text-[var(--fg2)] transition-colors hover:bg-muted',
          item.error && 'border-destructive/30 text-destructive hover:bg-destructive/10',
        )}
      >
        <ChevronRight className="size-3.5 shrink-0 text-[var(--fg3)] transition-transform group-data-[panel-open]/tool:rotate-90" />
        <span className="shrink-0 text-[var(--fg3)]">{item.name}</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {item.error && <TriangleAlert className="size-3.5 shrink-0" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 flex flex-col gap-2 rounded-lg border bg-card/50 p-2.5">
          <ToolBlock label="input" value={item.input} />
          {item.output !== undefined && <ToolBlock label="output" value={item.output} error={item.error} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolBlock({ label, value, error }: { label: string; value: unknown; error?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <pre
        className={cn(
          'max-h-48 overflow-auto rounded-md bg-background px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-foreground',
          error && 'text-destructive',
        )}
      >
        {formatValue(value)}
      </pre>
    </div>
  )
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Interactive AskUserQuestion card (#82 follow-up): renders the agent's
 *  clarifying questions as selectable options and routes the choice back as the
 *  tool_result so the planning session continues. Interactive only in a planning
 *  session while unanswered; otherwise it shows the recorded answers read-only. */
function QuestionCard({
  item,
  sessionId,
  stage,
  disconnected,
}: {
  item: QuestionItem
  sessionId: string
  stage?: string
  disconnected: boolean
}) {
  const interactive = stage === 'planning' && !item.answered
  const [selected, setSelected] = useState<Record<string, string[]>>({})

  const toggle = (q: QuestionSpec, label: string) => {
    setSelected((prev) => {
      const cur = prev[q.question] ?? []
      if (q.multiSelect) {
        return { ...prev, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      }
      return { ...prev, [q.question]: cur[0] === label ? [] : [label] }
    })
  }

  const allAnswered =
    item.questions.length > 0 && item.questions.every((q) => (selected[q.question]?.length ?? 0) > 0)

  const submit = () => {
    const answers: Record<string, string | string[]> = {}
    for (const q of item.questions) {
      const picks = selected[q.question] ?? []
      answers[q.question] = q.multiSelect ? picks : (picks[0] ?? '')
    }
    store.answerQuestion(sessionId, item.callId, item.questions, answers)
  }

  return (
    <div className="flex max-w-[90%] gap-2.5">
      <AgentAvatar />
      <div className="min-w-0 flex-1 rounded-xl border border-[color:var(--mint-line)] bg-[color:color-mix(in_srgb,var(--mint)_5%,var(--surface))] px-[15px] py-[13px]">
        <div className="mb-2.5 text-[11px] font-semibold tracking-wide text-primary uppercase">
          {item.answered ? 'Answered' : 'Needs your input'}
        </div>
        <div className="flex flex-col gap-3.5">
          {item.questions.map((q) => (
            <div key={q.question}>
              <div className="mb-0.5 flex items-center gap-2">
                {q.header && (
                  <span className="rounded-full border border-[var(--mint-line)] bg-[var(--mint-tint)] px-1.5 py-px font-mono text-[10px] text-primary">
                    {q.header}
                  </span>
                )}
                <span className="text-[13px] font-medium text-foreground">{q.question}</span>
              </div>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {q.options.map((opt) => {
                  const on = item.answered
                    ? answerHas(item.answers?.[q.question], opt.label)
                    : (selected[q.question] ?? []).includes(opt.label)
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={!interactive || disconnected}
                      onClick={() => toggle(q, opt.label)}
                      className={cn(
                        'flex items-start gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-colors',
                        on
                          ? 'border-primary bg-[color:color-mix(in_srgb,var(--mint)_10%,var(--surface))]'
                          : 'border-border bg-[var(--surface)]',
                        interactive ? 'cursor-pointer hover:border-[var(--mint-line)]' : 'cursor-default',
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'mt-px flex size-[15px] shrink-0 items-center justify-center border-[1.5px]',
                          q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                          on ? 'border-primary bg-primary text-primary-foreground' : 'border-[var(--border2)]',
                        )}
                      >
                        {on && <span className="text-[9px] leading-none">✓</span>}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-medium text-foreground">{opt.label}</span>
                        {opt.description && (
                          <span className="block text-[11.5px] text-[var(--fg3)]">{opt.description}</span>
                        )}
                      </span>
                    </button>
                  )
                })}
                {q.options.length === 0 && (
                  <span className="text-[11.5px] text-[var(--fg3)]">No options provided.</span>
                )}
              </div>
            </div>
          ))}
        </div>
        {interactive ? (
          <div className="mt-3 flex items-center gap-2.5">
            <Button size="sm" disabled={!allAnswered || disconnected} onClick={submit}>
              Send answer
            </Button>
            {disconnected && <span className="text-xs text-muted-foreground">Disconnected — reconnecting…</span>}
          </div>
        ) : (
          !item.answered && (
            <div className="mt-2.5 text-[11.5px] text-[var(--fg3)]">
              Answerable inline only in a planning session.
            </div>
          )
        )}
      </div>
    </div>
  )
}

/** Does a recorded answer (string or array, tolerating comma-joined multi) include a label? */
function answerHas(answer: string | string[] | undefined, label: string): boolean {
  if (Array.isArray(answer)) return answer.includes(label)
  if (typeof answer === 'string') return answer.split(',').map((s) => s.trim()).includes(label)
  return false
}

/** Inline approval-card particle (#8's canonical surface), restyled to the
 *  design's full-width amber card: pulsing amber dot + "Approval required", the
 *  request text, a mono block of the input, and Approve & run / Deny. */
function ApprovalCard({
  item,
  sessionId,
  disconnected,
}: {
  item: Extract<ChatItem, { kind: 'approval' }>
  sessionId: string
  disconnected: boolean
}) {
  const resolved = !!item.resolved
  return (
    <div
      className={cn(
        'self-stretch rounded-xl border p-[13px_15px]',
        resolved
          ? 'border-border bg-card/50'
          : 'border-[color:color-mix(in_srgb,var(--warning)_42%,transparent)] bg-[color:color-mix(in_srgb,var(--warning)_7%,var(--surface))]',
      )}
    >
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-warning">
        <span
          aria-hidden
          className={cn('size-[7px] shrink-0 rounded-full bg-warning', !resolved && 'tl-pulse')}
        />
        Approval required — {item.tool}
        {resolved && (
          <StatusBadge status={item.resolved === 'allow' ? 'running' : 'done'} className="ml-1">
            {item.resolved === 'allow' ? 'approved' : 'denied'}
          </StatusBadge>
        )}
      </div>
      <pre className="my-2.5 max-h-44 overflow-auto rounded-lg border bg-background px-[11px] py-[9px] font-mono text-xs whitespace-pre-wrap text-foreground">
        {summarizeInput(item.input) ? formatValue(item.input) : summarizeOutput(item.input)}
      </pre>
      {!resolved && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={disconnected}
            onClick={() => store.respondPermission(sessionId, item.id, { behavior: 'allow' })}
          >
            Approve &amp; run
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disconnected}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() =>
              store.respondPermission(sessionId, item.id, { behavior: 'deny', message: 'denied from threadmap UI' })
            }
          >
            Deny
          </Button>
          {disconnected && <span className="text-xs text-muted-foreground">Disconnected — reconnecting…</span>}
        </div>
      )}
    </div>
  )
}

/** Sticky approval bar (#82 follow-up): the inline card is easy to lose in a
 *  long transcript, so the oldest unresolved approval is also pinned right above
 *  the composer where it's always reachable. Acts on the oldest pending request;
 *  a trailing count shows how many more are queued behind it. */
function PendingApprovalBar({
  sessionId,
  events,
  disconnected,
}: {
  sessionId: string
  events: SessionView['events']
  disconnected: boolean
}) {
  const pending = pendingApprovals(events)
  if (pending.length === 0) return null
  const [current, ...rest] = pending
  if (!current) return null
  return (
    <div className="shrink-0 border-t border-[color:color-mix(in_srgb,var(--warning)_42%,transparent)] bg-[color:color-mix(in_srgb,var(--warning)_9%,var(--surface))] px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="tl-pulse size-[7px] shrink-0 rounded-full bg-warning" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-warning">
            Approval required — {current.tool}
            {rest.length > 0 && (
              <span className="rounded-full bg-warning/15 px-1.5 py-px text-[10.5px] font-medium text-warning">
                +{rest.length} more
              </span>
            )}
          </div>
          {summarizeInput(current.input) && (
            <div className="truncate font-mono text-[11px] text-[var(--fg3)]">{summarizeInput(current.input)}</div>
          )}
        </div>
        <Button
          size="sm"
          disabled={disconnected}
          onClick={() => store.respondPermission(sessionId, current.id, { behavior: 'allow' })}
        >
          Approve &amp; run
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disconnected}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() =>
            store.respondPermission(sessionId, current.id, { behavior: 'deny', message: 'denied from threadmap UI' })
          }
        >
          Deny
        </Button>
      </div>
    </div>
  )
}

/** Command chips over the composer — clickable quick-inserts that prefill the
 *  textarea (the mockup's `/spec` `/override` `@ticket` affordances, made real). */
const COMPOSER_CHIPS: { insert: string; cmd: string; label?: string }[] = [
  { insert: '/spec ', cmd: '/spec', label: 'draft spec' },
  { insert: '/override ', cmd: '/override', label: 'gate' },
  { insert: '@', cmd: '@ticket' },
]

function Composer({ view, disconnected }: { view: SessionView; disconnected: boolean }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const { meta } = view
  const ended = meta.status === 'ended'
  const resumable = ended && !!meta.resumeToken
  const disabled = ended && !resumable

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Draft is allowed while the socket is down; the send itself is not — it
    // would be dropped silently, so surface why instead.
    if (disconnected) {
      toast.error('Disconnected — reconnecting. Your draft is kept.')
      return
    }
    if (ended) {
      if (!resumable) return
      store.resumeSession(meta.id, trimmed)
    } else {
      store.sendMessage(meta.id, trimmed)
    }
    setText('')
  }

  const insertChip = (insert: string) => {
    setText((t) => (t.startsWith(insert.trimEnd()) ? t : insert + t))
    ref.current?.focus()
  }

  return (
    <div className="shrink-0 px-4 pt-2.5 pb-3.5">
      {!disabled && (
        <div className="mb-2.5 flex flex-wrap gap-[7px]">
          {COMPOSER_CHIPS.map((chip) => (
            <button
              key={chip.cmd}
              type="button"
              onClick={() => insertChip(chip.insert)}
              className="inline-flex items-center gap-1.5 rounded-lg border bg-[var(--surface)] px-2 py-[3px] text-[11px] text-[var(--fg3)] transition-colors hover:text-foreground"
            >
              <span className="font-mono text-[var(--fg2)]">{chip.cmd}</span>
              {chip.label}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-2xl border bg-[var(--surface)] px-3 pt-[11px] pb-2.5">
        <textarea
          ref={ref}
          rows={2}
          value={text}
          disabled={disabled}
          placeholder={
            ended
              ? resumable
                ? 'Session ended — sending resumes it…'
                : 'Session ended and is not resumable.'
              : `Message the ${meta.stage ?? 'agent'} session…`
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          className="w-full resize-none border-none bg-transparent px-1 py-0.5 text-[13.5px] text-foreground outline-none placeholder:text-[var(--fg3)] disabled:opacity-60"
        />
        <div className="mt-1.5 flex items-center gap-2.5">
          <span className="text-[11px] text-[var(--fg3)]">headless · {meta.adapter}</span>
          <Button
            size="sm"
            className="ml-auto"
            disabled={disabled || disconnected}
            title={disconnected ? 'Disconnected — reconnecting' : undefined}
            onClick={submit}
          >
            {ended && resumable ? 'Resume' : 'Send'}
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">⏎</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}
