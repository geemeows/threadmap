// PROTOTYPE — visual-direction variants for ticket #58. Throwaway code.
//
// Four themed variants of the core screen (three-pane split: efforts tree |
// pipeline rail | session chat), switchable via `?variant=` and a floating
// bottom bar. All data is hardcoded mock state; nothing touches the store or
// the WebSocket. Delete this directory once a direction is locked.

import { useEffect, useState } from 'react'
import './prototype.css'

const VARIANTS = [
  { key: 'mission', name: 'Mission Control' },
  { key: 'depth', name: 'Soft Depth' },
  { key: 'editorial', name: 'Warm Editorial' },
  { key: 'studio', name: 'High-Contrast Studio' },
] as const

type VariantKey = (typeof VARIANTS)[number]['key']

function variantFromUrl(): VariantKey {
  const raw = new URLSearchParams(window.location.search).get('variant')
  return (VARIANTS.find((v) => v.key === raw)?.key ?? 'mission') as VariantKey
}

export const prototypeEnabled =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has('variant')

export function VisualDirectionPrototype() {
  const [variant, setVariant] = useState<VariantKey>(variantFromUrl)
  const [mode, setMode] = useState<'dark' | 'light'>('dark')

  const idx = VARIANTS.findIndex((v) => v.key === variant)

  function go(delta: number) {
    const next = VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length]!
    setVariant(next.key)
    const url = new URL(window.location.href)
    url.searchParams.set('variant', next.key)
    window.history.replaceState(null, '', url)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="pv" data-proto={variant} data-mode={mode}>
      <TopBar />
      <div className="pv-grid">
        <EffortsTree />
        <PipelineRail />
        <SessionPane />
      </div>
      <div className="pv-switcher">
        <button onClick={() => go(-1)} aria-label="previous variant">
          ←
        </button>
        <span className="pv-sw-name">
          {String.fromCharCode(65 + idx)} — {VARIANTS[idx]!.name}
        </span>
        <button onClick={() => go(1)} aria-label="next variant">
          →
        </button>
        <button className="pv-sw-mode" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>
          {mode === 'dark' ? '☀ light' : '● dark'}
        </button>
      </div>
    </div>
  )
}

/* ---------- top bar ---------- */

function TopBar() {
  return (
    <div className="pv-topbar">
      <span className="pv-display" style={{ color: 'var(--p-fg)' }}>
        threadmap
      </span>
      <span className="pv-dimmer" style={{ fontSize: 12 }}>
        ~/dev/threadmap
      </span>
      <div style={{ flex: 1 }} />
      <span className="pv-pill ok">
        <span className="pv-dot ok" /> connected
      </span>
      <span className="pv-pill pv-mono">$4.12 · 182k▸41k</span>
      <span className="pv-pill warn">2 need you</span>
      <button className="pv-btn ghost">⚙</button>
    </div>
  )
}

/* ---------- left pane: efforts tree ---------- */

function EffortsTree() {
  return (
    <div className="pv-pane pv-panel-bg">
      <div className="pv-search">
        <span>Search sessions…</span>
        <span style={{ flex: 1 }} />
        <span className="pv-kbd">⌘K</span>
      </div>

      <div>
        <div className="pv-label" style={{ padding: '6px 8px 4px' }}>
          Efforts
        </div>
        <div className="pv-row" style={{ color: 'var(--p-fg)', fontWeight: 600 }}>
          <span>▾</span> Redesign UI on shadcn
        </div>
        <div className="pv-row" style={{ paddingLeft: 26 }}>
          <span className="pv-dot ok" /> PRD grilling
        </div>
        <div className="pv-row active" style={{ paddingLeft: 26 }}>
          <span className="pv-dot accent pulse" /> Plan: redesign shell
        </div>
        <div className="pv-row" style={{ paddingLeft: 26 }}>
          <span className="pv-dot warn" /> Prototype: variants
        </div>
        <div className="pv-row" style={{ color: 'var(--p-fg)', fontWeight: 600 }}>
          <span>▸</span> Wire pipeline actions
        </div>
      </div>

      <div>
        <div className="pv-label" style={{ padding: '6px 8px 4px' }}>
          Ad-hoc
        </div>
        <div className="pv-row">
          <span className="pv-dot idle" /> Fix flaky WS test
        </div>
      </div>

      <div>
        <div className="pv-label" style={{ padding: '6px 8px 4px' }}>
          Needs you · 2
        </div>
        <div className="pv-row">
          <span className="pv-dot warn pulse" /> Plan: redesign shell
        </div>
        <div className="pv-row">
          <span className="pv-dot warn pulse" /> Fix flaky WS test
        </div>
      </div>

      <div style={{ flex: 1 }} />
      <button className="pv-btn" style={{ justifyContent: 'center' }}>
        + New session
      </button>
    </div>
  )
}

/* ---------- middle pane: pipeline rail ---------- */

const STAGES = [
  { name: 'PRD', state: 'done' },
  { name: 'Research', state: 'done' },
  { name: 'Plan', state: 'current' },
  { name: 'Implement', state: 'locked' },
  { name: 'Review', state: 'locked' },
  { name: 'Land', state: 'locked' },
] as const

function PipelineRail() {
  return (
    <div className="pv-pane">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="pv-display" style={{ color: 'var(--p-fg)' }}>
          Redesign UI on shadcn
        </span>
        <span className="pv-pill pv-mono">#56</span>
        <span className="pv-pill">$2.87</span>
        <span className="pv-pill accent">2/6 complete</span>
      </div>

      <div>
        {STAGES.map((s, i) => (
          <div key={s.name}>
            {i > 0 && <div className="pv-stage-line" />}
            <div className={`pv-stage ${s.state === 'current' ? 'current' : ''}`}>
              <span className={`pv-stage-bubble ${s.state}`}>
                {s.state === 'done' ? '✓' : s.state === 'locked' ? '🔒' : String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ color: s.state === 'locked' ? 'var(--p-fg3)' : 'var(--p-fg)' }}>{s.name}</span>
              {s.state === 'current' && (
                <span className="pv-pill accent" style={{ marginLeft: 'auto' }}>
                  in progress
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="pv-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="pv-display" style={{ color: 'var(--p-fg)' }}>
            Plan
          </span>
          <span className="pv-pill accent">in progress</span>
          <span style={{ flex: 1 }} />
          <span className="pv-pill pv-mono">$0.42 · 12k▸3k</span>
        </div>
        <div className="pv-dim" style={{ fontSize: 12.5 }}>
          Break the PRD into implementation tickets with blocking edges. Gate: every ticket sized to one
          session.
        </div>
        <div className="pv-row" style={{ border: 'var(--p-bw) solid var(--p-border)', padding: '7px 10px' }}>
          <span className="pv-mono">impl/redesign-shell</span>
          <span className="pv-pill ok">PR open</span>
          <span style={{ flex: 1 }} />
          <button className="pv-btn ghost">view</button>
        </div>
        <div className="pv-row" style={{ border: 'var(--p-bw) solid var(--p-border)', padding: '7px 10px' }}>
          <span className="pv-mono">impl/chat-particles</span>
          <span className="pv-pill">queued</span>
          <span style={{ flex: 1 }} />
          <button className="pv-btn ghost">start</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="pv-btn primary">Advance stage</button>
          <button className="pv-btn danger">Override gate</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- right pane: session chat ---------- */

function SessionPane() {
  return (
    <div className="pv-pane" style={{ padding: 0, gap: 0 }}>
      <div className="pv-tabs">
        <span className="pv-tab active">
          <span className="pv-dot accent pulse" /> Plan: redesign shell
        </span>
        <span className="pv-tab">
          <span className="pv-dot ok" /> PRD grilling
        </span>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--p-gap)',
          padding: 'var(--p-pad)',
        }}
      >
        <div className="pv-marker">session started · stage plan</div>

        <div className="pv-bubble user">
          Break #56 into implementation tickets. Keep the shell and the chat particles separate.
        </div>

        <div className="pv-bubble">
          Reading the redesign map and the research doc to size the tickets. The shell (three-pane +
          top bar) and the chat surface look like natural seams.
        </div>

        <div className="pv-toolrow">
          <span className="pv-dot ok" />
          <span className="pv-mono">Read</span>
          <span className="pv-dimmer pv-mono">docs/research/shadcn-base-ui-registry.md</span>
          <span style={{ marginLeft: 'auto' }} className="pv-dimmer">
            ▸
          </span>
        </div>
        <div className="pv-toolrow">
          <span className="pv-dot ok" />
          <span className="pv-mono">Grep</span>
          <span className="pv-dimmer pv-mono">"data-theme" src/ui</span>
          <span style={{ marginLeft: 'auto' }} className="pv-dimmer">
            ▸
          </span>
        </div>

        <div className="pv-approval">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pv-label" style={{ color: 'var(--p-warn)' }}>
              Approval needed
            </span>
            <span className="pv-pill warn">Bash</span>
          </div>
          <div className="pv-code">pnpm dlx shadcn@latest init --preset base-nova</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="pv-btn primary">Allow</button>
            <button className="pv-btn">Deny</button>
            <span className="pv-dimmer" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
              waiting 2m
            </span>
          </div>
        </div>

        <div className="pv-bubble">
          Ticket 1 will own the shell: top bar, efforts sidebar, resizable panes. Ticket 2 owns the chat
          surface on MessageScroller
          <span className="pv-cursor" />
        </div>
      </div>

      <div className="pv-composer">
        <div className="pv-composer-box">
          <textarea rows={2} placeholder="Reply to the session…" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="pv-dimmer" style={{ fontSize: 11.5 }}>
            <span className="pv-kbd">⏎</span> send · <span className="pv-kbd">⇧⏎</span> newline
          </span>
          <span style={{ flex: 1 }} />
          <button className="pv-btn ghost">⏸ pause</button>
          <button className="pv-btn primary">Send</button>
        </div>
      </div>
    </div>
  )
}
