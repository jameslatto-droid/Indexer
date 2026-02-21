import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'

const API = 'http://127.0.0.1:8787'

function App() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState('keyword')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [reasoningLoading, setReasoningLoading] = useState(false)
  const [answer, setAnswer] = useState('')

  const runSearch = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode, topK: 20 })
      })
      const data = await res.json()
      setResults(data.chunks || [])
      setSelected(new Set())
      setAnswer('')
    } catch (e) {
      console.error('Search error:', e)
    } finally {
      setLoading(false)
    }
  }

  const toggleSelect = (chunkId) => {
    const next = new Set(selected)
    next.has(chunkId) ? next.delete(chunkId) : next.add(chunkId)
    setSelected(next)
  }

  const runReason = async () => {
    if (selected.size === 0) {
      alert('Please select at least one result')
      return
    }
    setReasoningLoading(true)
    try {
      const res = await fetch(`${API}/api/reason`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: query,
          chunkIds: Array.from(selected),
          model: 'llama3.1:8b-instruct-q4_K_M'
        })
      })
      const data = await res.json()
      setAnswer(data.answer || 'No answer generated')
    } catch (e) {
      console.error('Reasoning error:', e)
      setAnswer(`Error: ${e.message}`)
    } finally {
      setReasoningLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      <div className="p-4 border-b border-slate-700 space-y-3">
        <div className="flex gap-2">
          <input
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
            placeholder="Search your corpus (semantic/keyword/hybrid)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
          />
          <select className="bg-slate-900 border border-slate-700 rounded px-2 py-2 text-sm" value={mode} onChange={e => setMode(e.target.value)}>
            <option value="semantic">Semantic</option>
            <option value="keyword">Keyword</option>
            <option value="hybrid">Hybrid</option>
          </select>
          <button className="bg-blue-600 hover:bg-blue-700 rounded px-4 py-2 text-sm font-medium" onClick={runSearch} disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
          <button className="bg-green-600 hover:bg-green-700 rounded px-4 py-2 text-sm font-medium" onClick={runReason} disabled={reasoningLoading || selected.size === 0}>{reasoningLoading ? 'Generating…' : 'Generate Answer'}</button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 overflow-auto border-r border-slate-700 p-4">
          <div className="space-y-2">
            {results.map(chunk => (
              <div key={chunk.chunkId} className="border border-slate-700 rounded p-3 bg-slate-900 cursor-pointer hover:bg-slate-800" onClick={() => toggleSelect(chunk.chunkId)}>
                <div className="flex items-start gap-2">
                  <input type="checkbox" checked={selected.has(chunk.chunkId)} readOnly className="mt-1" />
                  <div className="flex-1">
                    <div className="text-sm font-semibold">{chunk.title}</div>
                    <div className="text-xs text-slate-400">{chunk.section} • Score: {(chunk.score * 100).toFixed(0)}%</div>
                    <div className="text-sm mt-2 text-slate-300 line-clamp-3">{chunk.text}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="w-96 overflow-auto border-l border-slate-700 p-4 bg-slate-900/50">
          <div className="text-sm font-semibold mb-3">Generated Answer</div>
          {answer ? (
            <div className="text-sm text-slate-300 whitespace-pre-wrap">{answer}</div>
          ) : (
            <div className="text-xs text-slate-500">Run a search, select results, and click "Generate Answer"</div>
          )}
        </div>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
