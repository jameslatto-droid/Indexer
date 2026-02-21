import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'

const API = 'http://127.0.0.1:8787'

function App() {
  const [status, setStatus] = useState<any>({})
  const [indexing, setIndexing] = useState(false)

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API}/api/index/stats`)
        const data = await res.json()
        setStatus(data)
      } catch (e) {
        console.error(e)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const startIndexing = async () => {
    setIndexing(true)
    try {
      await fetch(`${API}/api/index/start`, { method: 'POST' })
    } catch (e) {
      console.error(e)
    }
  }

  const stopIndexing = async () => {
    try {
      await fetch(`${API}/api/index/stop`, { method: 'POST' })
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 p-6">
      <h1 className="text-2xl font-bold mb-6">Indexer Control Panel</h1>
      
      <div className="space-y-4 mb-6">
        <div className="p-4 bg-slate-900 rounded border border-slate-700">
          <div className="text-sm font-semibold mb-2">Indexer Status</div>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>State: <span className="font-mono">{status.state || 'idle'}</span></div>
            <div>Files: <span className="font-mono">{status.files?.processed || 0} / {status.files?.queued || 0}</span></div>
            <div>Chunks: <span className="font-mono">{status.chunks?.embedded || 0}</span></div>
            <div>Throughput: <span className="font-mono">{status.throughput?.chunksPerSec || 0} chunks/s</span></div>
          </div>
        </div>

        <div className="flex gap-2">
          <button 
            className="bg-green-600 hover:bg-green-700 rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
            onClick={startIndexing}
            disabled={status.state !== 'idle'}
          >
            Start Indexing
          </button>
          <button 
            className="bg-red-600 hover:bg-red-700 rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
            onClick={stopIndexing}
            disabled={status.state === 'idle'}
          >
            Stop
          </button>
        </div>
      </div>

      <div className="text-xs text-slate-400">
        <p>Indexer Backend: http://127.0.0.1:8787</p>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
