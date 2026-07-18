// Start a session: pick the repo (cwd), optional stage tag, and the prompt.
// Rebuilt on shadcn (Base UI) in the Soft Depth direction (#67): a Dialog with
// a FieldGroup of a repo Select, a stage Select (both on the Base `items` API),
// and a prompt Textarea. Stage-composed prompts arrive with implement-session
// orchestration (#30) — until then the prompt is free-form with the pipeline's
// slash skills at hand. Behavior is unchanged from the #8 dialog.

import { Play } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { store, useStore } from '../lib/store.js'
import { RAIL_STAGES } from '../lib/types.js'

const STAGE_ITEMS = [
  { value: '', label: '— none —' },
  ...RAIL_STAGES.filter((s) => s.key !== 'setup').map((s) => ({ value: s.key, label: s.label })),
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
    <Dialog open={state.newSessionOpen} onOpenChange={store.setNewSessionOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            New session
            {effort && (
              <Badge variant="outline" className="font-mono text-muted-foreground">
                {effort.ref.display}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Runs a Claude Code session in the chosen repo — it docks in the chat pane on the right.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel>Repo (session cwd)</FieldLabel>
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
            <FieldLabel>Stage (optional)</FieldLabel>
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
            <FieldLabel htmlFor="new-session-prompt">Prompt</FieldLabel>
            <Textarea
              id="new-session-prompt"
              rows={4}
              value={prompt}
              placeholder="/grilling next decision on the map…"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button onClick={start} disabled={!cwd || !prompt.trim()}>
            <Play />
            Start session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
