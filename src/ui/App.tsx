import { useEffect, useState } from 'react'

type WsStatus = 'connecting' | 'connected' | 'closed'

export function App() {
  const [status, setStatus] = useState<WsStatus>('connecting')
  const [lastMessage, setLastMessage] = useState<string | null>(null)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.onopen = () => setStatus('connected')
    ws.onclose = () => setStatus('closed')
    ws.onmessage = (event) => setLastMessage(String(event.data))
    return () => ws.close()
  }, [])

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-900 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">threadmap</h1>
      <p className="text-sm text-neutral-400">
        WebSocket:{' '}
        <span className={status === 'connected' ? 'text-emerald-400' : 'text-amber-400'}>
          {status}
        </span>
      </p>
      {lastMessage !== null && (
        <pre className="rounded-md bg-neutral-800 px-4 py-2 text-xs text-neutral-300">
          {lastMessage}
        </pre>
      )}
    </main>
  )
}
