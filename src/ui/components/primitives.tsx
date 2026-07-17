import type { ReactNode } from 'react'
import { fmtTokens } from '../lib/derive.js'
import type { SessionStatus, Usage } from '../lib/types.js'
import { STATUS_META } from '../lib/types.js'

export function Pill({ tone = '', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {children}
    </span>
  )
}

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`dot ${STATUS_META[status].dot}`} />
}

export function StatusPill({ status }: { status: SessionStatus }) {
  const m = STATUS_META[status]
  return (
    <Pill tone={m.pill}>
      <StatusDot status={status} />
      {m.label}
    </Pill>
  )
}

export function CostBadge({ usage }: { usage?: Usage }) {
  if (!usage) return null
  const cost = usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(2)}` : ''
  const tokens = `${fmtTokens(usage.inputTokens)}▸${fmtTokens(usage.outputTokens)}`
  return (
    <Pill title="cost · tokens in▸out">
      <span className="mono">{[cost, tokens].filter(Boolean).join(' · ')}</span>
    </Pill>
  )
}

export function Ticks({ done, total, width = 28 }: { done: number; total: number; width?: number }) {
  const on = total ? Math.round((done / total) * width) : 0
  return (
    <div className="ticks">
      {Array.from({ length: width }, (_, i) => (
        <i key={i} className={i < on ? 'on' : ''} />
      ))}
    </div>
  )
}
