// The pipeline UI shell — locked IA from #8, rebuilt to the Mint Workspace
// design (#78): a floating rounded-card frame (12px page gutter, top bar inside)
// over a three-pane row — a FIXED 266px efforts pane, then a resizable rail↔chat
// split (the #64 drag feature kept; the mockup's 1fr / 43% as defaults). The
// SidebarProvider stays for context only; the left pane is collapsible="none".

import { type CSSProperties, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useDefaultLayout } from 'react-resizable-panels'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { CommandPalette } from './components/CommandPalette.js'
import { EffortsTree } from './components/EffortsTree.js'
import { Inbox } from './components/Inbox.js'
import { NewSessionDialog } from './components/NewSessionDialog.js'
import { PipelineRail } from './components/PipelineRail.js'
import { SessionPane } from './components/SessionPane.js'
import { SetupPanel } from './components/SetupPanel.js'
import { TopBar } from './components/TopBar.js'
import { store, useStore } from './lib/store.js'

export function App() {
  const state = useStore()
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'threadmap-split', panelIds: ['rail', 'chat'] })

  useEffect(() => {
    void store.init()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
  }, [state.theme])

  // Announce connection drops/recoveries as toasts — the topbar badge is easy
  // to miss, and a closed socket silently drops sends until it reconnects.
  const prevConn = useRef(state.conn)
  useEffect(() => {
    const was = prevConn.current
    prevConn.current = state.conn
    if (was === state.conn) return
    if (state.conn === 'closed') toast.warning('Connection lost — reconnecting…', { id: 'ws-conn' })
    else if (state.conn === 'open' && was === 'closed') toast.success('Reconnected', { id: 'ws-conn' })
  }, [state.conn])

  return (
    <SidebarProvider
      className="h-svh overflow-hidden bg-background p-3"
      style={{ '--sidebar-width': '266px' } as CSSProperties}
    >
      {/* floating rounded-card frame — the whole app sits inside one panel */}
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border bg-card shadow-depth">
        <TopBar />
        {state.error && (
          <div className="flex shrink-0 animate-enter-soft items-center gap-2 border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
            {state.error}
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => store.dismissError()}>
              dismiss
            </Button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <EffortsTree />
          <ResizablePanelGroup
            className="min-h-0 min-w-0 flex-1"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
          >
            <ResizablePanel id="rail" minSize={340} className="grid min-w-0">
              <PipelineRail />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="chat" minSize={380} defaultSize="43" className="grid min-w-0">
              <SessionPane />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
      <CommandPalette />
      <Inbox />
      <NewSessionDialog />
      <SetupPanel />
      <Toaster theme={state.theme} position="bottom-right" />
    </SidebarProvider>
  )
}
