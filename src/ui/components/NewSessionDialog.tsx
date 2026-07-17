// Start a session: pick the repo (cwd), optional stage tag, and the prompt.
// Stage-composed prompts arrive with implement-session orchestration (#30) —
// until then the prompt is free-form with the pipeline's slash skills at hand.

import { useState } from 'react'
import { store, useStore } from '../lib/store.js'
import { RAIL_STAGES } from '../lib/types.js'

export function NewSessionDialog() {
  const state = useStore()
  const [repoPath, setRepoPath] = useState('')
  const [stage, setStage] = useState('')
  const [prompt, setPrompt] = useState('')
  if (!state.newSessionOpen) return null

  const repos = state.workspace?.repos ?? []
  const cwd = repoPath || repos[0]?.path || ''
  const effort = state.efforts.find((e) => e.ref.id === state.selectedEffort)

  const start = () => {
    if (!cwd || !prompt.trim()) return
    store.startSession({
      cwd,
      prompt: prompt.trim(),
      permissionPolicy: { mode: 'default', intercept: true },
      effort: effort?.ref.id,
      stage: stage || undefined,
    })
    store.setNewSessionOpen(false)
    setPrompt('')
  }

  return (
    <div
      className="overlay-bg"
      onClick={(e) => {
        if (e.target === e.currentTarget) store.setNewSessionOpen(false)
      }}
    >
      <div className="overlay-panel">
        <div className="flex items-center gap-2.5 p-[14px_18px]" style={{ borderBottom: '1px solid var(--border)' }}>
          <b>New session</b>
          {effort && <span className="pill mono">{effort.ref.display}</span>}
          <span className="flex-1" />
          <button className="btn sm" onClick={() => store.setNewSessionOpen(false)}>
            ✕
          </button>
        </div>
        <div className="p-[16px_18px]">
          <div className="field">
            <label>Repo (session cwd)</label>
            <select value={cwd} onChange={(e) => setRepoPath(e.target.value)}>
              {repos.map((repo) => (
                <option key={repo.path} value={repo.path}>
                  {repo.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Stage (optional)</label>
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">—</option>
              {RAIL_STAGES.filter((s) => s.key !== 'setup').map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Prompt</label>
            <textarea
              rows={4}
              value={prompt}
              placeholder="/grilling next decision on the map…"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn sm" onClick={() => store.setNewSessionOpen(false)}>
              Cancel
            </button>
            <button className="btn primary sm" onClick={start} disabled={!cwd || !prompt.trim()}>
              ▶ Start session
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
