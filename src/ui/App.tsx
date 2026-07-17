// The pipeline UI shell — locked IA from #8, variant C: IDE-style three-pane
// split (efforts tree | pipeline rail with gates | docked tabbed session
// chat), Needs-you queue in the top bar, approvals inline + global inbox.

import { useEffect } from 'react'
import { EffortsTree } from './components/EffortsTree.js'
import { Inbox } from './components/Inbox.js'
import { NewSessionDialog } from './components/NewSessionDialog.js'
import { PipelineRail } from './components/PipelineRail.js'
import { SessionPane } from './components/SessionPane.js'
import { TopBar } from './components/TopBar.js'
import { store, useStore } from './lib/store.js'

export function App() {
  const state = useStore()

  useEffect(() => {
    void store.init()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
  }, [state.theme])

  return (
    <div className="frame">
      <div className="inner">
        <TopBar />
        {state.error && (
          <div className="flex items-center gap-2 px-4 py-1.5 text-[12.5px]" style={{ color: 'var(--red)', borderBottom: '1px solid var(--border)' }}>
            {state.error}
            <button className="btn sm ml-auto" onClick={() => store.dismissError()}>
              dismiss
            </button>
          </div>
        )}
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: '256px minmax(340px,1fr) minmax(380px,44%)' }}>
          <EffortsTree />
          <PipelineRail />
          <SessionPane />
        </div>
      </div>
      <Inbox />
      <NewSessionDialog />
    </div>
  )
}
