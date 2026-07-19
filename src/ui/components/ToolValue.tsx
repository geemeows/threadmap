// Legible tool-call rendering (#93). Tool input/output used to dump as
// pretty-printed raw JSON in a <pre> (the old `formatValue`). This replaces that
// with a HYBRID model: the common tools that clearly benefit get a tailored view
// — a diff for Edit/Write, a terminal for Bash, a checklist for TodoWrite, code
// for Read/Grep/Glob — and everything else falls through to a generic key/value
// tree (scalars inline, nested objects/arrays collapsible, multi-line strings
// wrapped instead of truncated).
//
// The SAME input renderer (`ToolInput`) is used by both the collapsible tool row
// (SessionPane `ToolBlock`) and the pending `ApprovalCard` arg preview, so the
// two surfaces stay consistent (ticket requirement).
//
// Scroll-safety (#89): every value renders inside a fixed-height `Frame` that
// bounds and scrolls its own content, and the DOM shape is a pure function of the
// value — nothing remounts as output streams in — so the transcript's per-item
// stick-to-bottom tracking is unaffected.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Bounded, scrollable container shared by every rendered value. */
function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('max-h-64 overflow-auto rounded-md border bg-background font-mono text-xs', className)}>
      {children}
    </div>
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Tool-result content arrives as a plain string, an array of `{type:'text',text}`
 *  blocks (Claude Code `tool_result` content), or an arbitrary object. Flatten to
 *  text when we can; otherwise return undefined so the caller falls back to the
 *  generic tree. */
function outputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map((b) => {
      if (typeof b === 'string') return b
      const rec = asRecord(b)
      if (rec && typeof rec.text === 'string') return rec.text
      return null
    })
    if (parts.length > 0 && parts.every((p): p is string => p !== null)) return parts.join('')
  }
  return undefined
}

const FILE_HEADER_KEYS = ['file_path', 'path', 'notebook_path'] as const

function filePath(input: Record<string, unknown>): string | undefined {
  for (const k of FILE_HEADER_KEYS) if (typeof input[k] === 'string') return input[k] as string
  return undefined
}

/** File-path line with optional chips (offset/limit, "new file", …). */
function FileHeader({ path, chips }: { path: string; chips?: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-2.5 pt-2">
      <span className="text-foreground">{path}</span>
      {chips?.map((c) => (
        <span key={c} className="rounded-full border px-1.5 py-px text-[10.5px] text-[var(--fg2)]">
          {c}
        </span>
      ))}
    </div>
  )
}

/** A run of removed/added/context lines, marker + text (no line numbers — Edit
 *  input carries none). */
function DiffLines({ text, kind }: { text: string; kind: 'add' | 'del' }) {
  const marker = kind === 'add' ? '+' : '-'
  const rowTint =
    kind === 'add'
      ? 'bg-[color:color-mix(in_srgb,var(--mint)_9%,transparent)] text-[var(--mint)]'
      : 'bg-[color:color-mix(in_srgb,var(--destructive)_9%,transparent)] text-destructive'
  return (
    <>
      {text.split('\n').map((line, i) => (
        <div key={i} className={cn('grid grid-cols-[14px_1fr]', rowTint)}>
          <span className="select-none text-center">{marker}</span>
          <span className="whitespace-pre-wrap break-words">{line}</span>
        </div>
      ))}
    </>
  )
}

/** Terminal-styled block: an optional `$ command` prompt line then output. */
function Terminal({ command, output, error }: { command?: string; output?: string; error?: boolean }) {
  return (
    <div className="px-2.5 py-2 whitespace-pre-wrap break-words">
      {command !== undefined && (
        <div className="text-foreground">
          <span className="select-none text-[var(--mint)]">$ </span>
          {command}
        </div>
      )}
      {output !== undefined && <div className={cn('text-[var(--fg2)]', error && 'text-destructive')}>{output}</div>}
    </div>
  )
}

/** Preformatted code, columns preserved via horizontal scroll (Read/Grep/Glob). */
function Code({ text }: { text: string }) {
  return <pre className="px-2.5 py-2 whitespace-pre text-foreground">{text}</pre>
}

/** Plain wrapped mono text — the default for a string output that isn't a known
 *  code/terminal surface. */
function PlainText({ text, error }: { text: string; error?: boolean }) {
  return (
    <pre className={cn('px-2.5 py-2 whitespace-pre-wrap break-words text-foreground', error && 'text-destructive')}>
      {text}
    </pre>
  )
}

type Todo = { content?: string; status?: string; activeForm?: string }

function Checklist({ todos }: { todos: Todo[] }) {
  const icon = (s: string | undefined) => (s === 'completed' ? '✓' : s === 'in_progress' ? '◐' : '○')
  const tone = (s: string | undefined) =>
    s === 'completed' ? 'text-[var(--fg3)]' : s === 'in_progress' ? 'text-foreground' : 'text-[var(--fg2)]'
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2">
      {todos.map((t, i) => (
        <div key={i} className={cn('flex items-baseline gap-2', tone(t.status))}>
          <span className={cn('w-3.5 shrink-0 text-center', t.status === 'in_progress' && 'text-[var(--warning)]')}>
            {icon(t.status)}
          </span>
          <span className={cn('min-w-0', t.status === 'completed' && 'line-through')}>
            {t.activeForm && t.status === 'in_progress' ? t.activeForm : t.content}
          </span>
        </div>
      ))}
    </div>
  )
}

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

/** One scalar value, numbers/booleans tinted mint, strings wrapped. */
function Scalar({ value }: { value: string | number | boolean | null }) {
  if (typeof value === 'string') return <span className="whitespace-pre-wrap break-words text-foreground">{value}</span>
  return <span className="text-[var(--mint)]">{String(value)}</span>
}

/** Generic key/value tree — the fallback for any tool without a bespoke view, and
 *  for nested objects/arrays inside one. Scalars render inline; nested containers
 *  collapse behind a disclosure showing their child count. */
function Tree({ data }: { data: unknown }) {
  if (isScalar(data)) return <Scalar value={data} />
  const entries: [string, unknown][] = Array.isArray(data)
    ? data.map((v, i) => [String(i), v])
    : Object.entries(data as Record<string, unknown>)
  if (entries.length === 0) return <span className="text-[var(--fg3)]">{Array.isArray(data) ? '[]' : '{}'}</span>
  return (
    <div className="flex flex-col gap-0.5">
      {entries.map(([k, v]) =>
        isScalar(v) ? (
          <div key={k} className="grid grid-cols-[max-content_1fr] gap-x-3.5">
            <span className="text-[var(--fg3)]">{k}</span>
            <Scalar value={v} />
          </div>
        ) : (
          <details key={k} className="group">
            <summary className="flex cursor-pointer list-none items-baseline gap-1 text-[var(--fg3)] marker:content-none">
              <span className="inline-block transition-transform group-open:rotate-90">▸</span>
              <span>{k}</span>
              <span> [{Array.isArray(v) ? v.length : Object.keys(v as object).length}]</span>
            </summary>
            <div className="my-1 ml-1 border-l border-[var(--border2)] pl-3">
              <Tree data={v} />
            </div>
          </details>
        ),
      )}
    </div>
  )
}

function GenericValue({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : outputText(value)
  if (text !== undefined) return <PlainText text={text} />
  if (isScalar(value)) return <PlainText text={String(value)} />
  return (
    <div className="px-2.5 py-2">
      <Tree data={value} />
    </div>
  )
}

/** Renders a tool call's INPUT legibly, per tool. Shared by the tool row and the
 *  ApprovalCard preview. */
export function ToolInput({ name, value }: { name: string; value: unknown }) {
  const input = asRecord(value)

  if (input) {
    // Bash → terminal command line.
    if (name === 'Bash' && typeof input.command === 'string') {
      return (
        <Frame>
          <Terminal command={input.command} />
        </Frame>
      )
    }

    // Edit / MultiEdit → file header + diff of old→new.
    if ((name === 'Edit' || name === 'MultiEdit') && (input.old_string !== undefined || input.edits !== undefined)) {
      const edits = Array.isArray(input.edits)
        ? (input.edits as Record<string, unknown>[])
        : [{ old_string: input.old_string, new_string: input.new_string }]
      return (
        <Frame>
          {typeof input.file_path === 'string' && <FileHeader path={input.file_path} />}
          <div className="py-1.5">
            {edits.map((e, i) => (
              <div key={i}>
                {typeof e.old_string === 'string' && e.old_string.length > 0 && (
                  <DiffLines text={e.old_string} kind="del" />
                )}
                {typeof e.new_string === 'string' && <DiffLines text={e.new_string} kind="add" />}
              </div>
            ))}
          </div>
        </Frame>
      )
    }

    // Write → file header (new-file chip) + content as code.
    if (name === 'Write' && typeof input.content === 'string') {
      const lines = input.content.split('\n').length
      return (
        <Frame>
          {typeof input.file_path === 'string' && (
            <FileHeader path={input.file_path} chips={[`new file · ${lines} line${lines === 1 ? '' : 's'}`]} />
          )}
          <Code text={input.content} />
        </Frame>
      )
    }

    // Read → file header with offset/limit chips; body arrives as output.
    if (name === 'Read' && typeof input.file_path === 'string') {
      const chips: string[] = []
      if (typeof input.offset === 'number') chips.push(`offset ${input.offset}`)
      if (typeof input.limit === 'number') chips.push(`limit ${input.limit}`)
      return (
        <Frame className="pb-2">
          <FileHeader path={input.file_path} chips={chips} />
        </Frame>
      )
    }

    // TodoWrite → checklist.
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      return (
        <Frame>
          <Checklist todos={input.todos as Todo[]} />
        </Frame>
      )
    }
  }

  return (
    <Frame>
      <GenericValue value={value} />
    </Frame>
  )
}

/** Renders a tool call's OUTPUT legibly, per tool. `error` tints the block. */
export function ToolOutput({ name, value, error }: { name: string; value: unknown; error?: boolean }) {
  const text = outputText(value)

  if (text !== undefined) {
    if (name === 'Bash') {
      return (
        <Frame>
          <Terminal output={text} error={error} />
        </Frame>
      )
    }
    // Read/Grep/Glob output is columnar — preserve alignment with a scrolling
    // code block rather than wrapping.
    if (name === 'Read' || name === 'Grep' || name === 'Glob') {
      return (
        <Frame className={error ? 'text-destructive' : undefined}>
          <Code text={text} />
        </Frame>
      )
    }
    return (
      <Frame>
        <PlainText text={text} error={error} />
      </Frame>
    )
  }

  return (
    <Frame className={error ? 'text-destructive' : undefined}>
      <GenericValue value={value} />
    </Frame>
  )
}
