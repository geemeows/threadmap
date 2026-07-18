// Start a session: pick the repo (cwd), optional stage tag, and the prompt.
// Rebuilt to the mint Threadline Workspace design (#83) on the shared
// OverlayShell particle (#78 vocabulary): a top-anchored panel modal with a
// mono effort-ref beside the title, a stacked field group, and a mint
// Start-session action. Still a Base UI Dialog underneath, so focus-trap, Esc,
// and the Select/Textarea a11y come free. Behavior is unchanged from the #67
// dialog — the reskin only restyles the chrome and the fields.

import { Play } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { store, useStore } from '../lib/store.js'
import { PIPELINE_STAGES } from '../lib/types.js'
import { OverlayShell } from './particles.js'

const STAGE_ITEMS = [
  { value: '', label: '— none —' },
  ...PIPELINE_STAGES.map((s) => ({ value: s.key, label: s.label })),
]

export function NewSessionDialog() {
  const state = useStore()
  const [repoPath, setRepoPath] = useState('')
  const [stage, setStage] = useState('')
  const [prompt, setPrompt] = useState('')

  const repos = state.workspace?.repos ?? []
  const repoItems = repos.map((repo) => ({ value: repo.path, label: repo.name }))
  const cwd = repoPath || repos[0]?.path || ''
  const effort = state.efforts.find((e) => e.ref.id === state.selectedEffort)

  const disconnected = state.conn !== 'open'

  const start = () => {
    if (!cwd || !prompt.trim()) return
    if (disconnected) {
      toast.error('Disconnected — reconnecting. Try again in a moment.')
      return
    }
    store.startSession({
      cwd,
      prompt: prompt.trim(),
      permissionPolicy: { mode: 'default', intercept: true },
      effort: effort?.ref.id,
      stage: stage || undefined,
    })
    store.setNewSessionOpen(false)
    setPrompt('')
    toast.success('Session starting…')
  }

  return (
    <OverlayShell
      open={state.newSessionOpen}
      onOpenChange={(open) => store.setNewSessionOpen(open)}
      title="New session"
      description="Runs a Claude Code session in the chosen repo — it docks in the chat pane on the right."
      width={520}
      afterTitle={
        effort && (
          <span className="rounded-full border border-[var(--border2)] px-[9px] py-0.5 font-mono text-[11px] text-muted-foreground">
            {effort.ref.display}
          </span>
        )
      }
    >
      <FieldGroup className="gap-3.5 px-[18px] py-4">
        <Field>
          <FieldLabel className="text-xs font-semibold text-muted-foreground">Repo · session cwd</FieldLabel>
          <Select items={repoItems} value={cwd} onValueChange={(v) => setRepoPath(String(v ?? ''))}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Pick a repo…" />
            </SelectTrigger>
            <SelectContent>
              {repoItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel className="text-xs font-semibold text-muted-foreground">Stage</FieldLabel>
          <Select items={STAGE_ITEMS} value={stage} onValueChange={(v) => setStage(String(v ?? ''))}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="— none —" />
            </SelectTrigger>
            <SelectContent>
              {STAGE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="new-session-prompt" className="text-xs font-semibold text-muted-foreground">
            Prompt
          </FieldLabel>
          <Textarea
            id="new-session-prompt"
            rows={4}
            value={prompt}
            placeholder="/implement next unblocked ticket on the map…"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <div className="flex justify-end gap-2.5">
          <Button variant="outline" size="sm" onClick={() => store.setNewSessionOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={start}
            disabled={!cwd || !prompt.trim() || disconnected}
            title={disconnected ? 'Disconnected — reconnecting' : undefined}
          >
            <Play />
            Start session
          </Button>
        </div>
      </FieldGroup>
    </OverlayShell>
  )
}
