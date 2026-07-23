// Start a brand-new effort (#106 / decisions #96, #99, #100): the Efforts-group
// header `+` opens this instead of the session modal. An Effort *is* its
// `wayfinder:map` issue, so submitting mints one via POST /api/efforts. The
// modal presents exactly a Home-repo field + one idea textarea + a read-only
// provisional-name preview — no title field, no stage field. The home repo
// doubles as the effort's identity (effectively irreversible), so the picker
// offers ready repos only, with no default; a single ready repo is hidden and
// auto-bound. Built on the shared OverlayShell particle, matching NewSessionDialog.
//
// On submit (#110) the map is minted and a planning session auto-starts, bound
// to the new effort with an auto-injected `/wayfinder` charting prompt seeded
// with the idea — so the action is "Start planning", not merely "create".

import { Compass } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { provisionalName } from '../../server/effort-name.js'
import { store, useStore } from '../lib/store.js'
import { OverlayShell } from './particles.js'

export function NewEffortDialog() {
  const state = useStore()
  const [repoName, setRepoName] = useState('')
  const [idea, setIdea] = useState('')
  const [minting, setMinting] = useState(false)

  // Home repo is the effort's identity — offer ready repos only, no default.
  const readyRepos = (state.setup?.repos ?? []).filter((r) => r.ready)
  const singleRepo = readyRepos.length === 1 ? readyRepos[0]! : null
  const homeRepo = singleRepo?.name ?? repoName
  const repoItems = readyRepos.map((r) => ({ value: r.name, label: r.name }))

  const provisional = useMemo(() => provisionalName(idea), [idea])
  const disconnected = state.conn !== 'open'
  const ready = idea.trim().length > 0 && homeRepo.length > 0 && !disconnected

  const reset = () => {
    setIdea('')
    setRepoName('')
  }

  const submit = async () => {
    if (!ready || minting) return
    setMinting(true)
    const error = await store.mintEffort(homeRepo, idea.trim())
    setMinting(false)
    if (error) {
      toast.error(error)
      return
    }
    reset()
    toast.success('Planning session starting…')
  }

  return (
    <OverlayShell
      open={state.newEffortOpen}
      onOpenChange={(open) => {
        store.setNewEffortOpen(open)
        if (!open) reset()
      }}
      title="New effort"
      description="Describe the idea — we'll mint the map and open a planning session to chart it."
      width={520}
    >
      <FieldGroup className="gap-3.5 px-[18px] py-4">
        {!singleRepo && (
          <Field>
            <FieldLabel className="text-xs font-semibold text-muted-foreground">Home repo</FieldLabel>
            <Select items={repoItems} value={repoName} onValueChange={(v) => setRepoName(String(v ?? ''))}>
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
            {repoItems.length === 0 && (
              <p className="text-[11px] text-muted-foreground">No ready repos — finish setup first.</p>
            )}
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor="new-effort-idea" className="text-xs font-semibold text-muted-foreground">
            Idea
          </FieldLabel>
          <Textarea
            id="new-effort-idea"
            rows={4}
            value={idea}
            placeholder="Describe the work — a name is derived from the first line…"
            onChange={(e) => setIdea(e.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel className="text-xs font-semibold text-muted-foreground">Name (derived)</FieldLabel>
          <div className="truncate rounded-md border border-[var(--border2)] bg-popover px-2.5 py-1.5 text-[12.5px] text-muted-foreground">
            {provisional || <span className="text-[var(--fg3)]">…from the first line of your idea</span>}
          </div>
        </Field>

        <div className="flex justify-end gap-2.5">
          <Button variant="outline" size="sm" onClick={() => store.setNewEffortOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={!ready || minting}
            title={disconnected ? 'Disconnected — reconnecting' : undefined}
          >
            <Compass />
            {minting ? 'Starting…' : 'Start planning'}
          </Button>
        </div>
      </FieldGroup>
    </OverlayShell>
  )
}
