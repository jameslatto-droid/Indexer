import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend,
} from "chart.js";
import { clsx } from "clsx";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

type SelectedState = "included" | "excluded" | "partial" | "none";

type FolderNode = {
  path: string;
  name: string;
  type: "folder";
  hasChildren: boolean;
  selected: SelectedState;
  meta?: { fileCount?: number; byteSize?: number; lastScannedAt?: string };
};

type SelectionRules = { include: string[]; exclude: string[] };

type SystemStats = {
  ts: string;
  gpu: { name: string; utilPct: number; vramUsedMB: number; vramTotalMB: number; memBwGBps: number };
  cpu: { utilPct: number; clockGHz: number; threads: number };
  ram: { usedMB: number; totalMB: number; pagefileUsedMB: number };
  disk: { readMBps: number; writeMBps: number };
};

type IndexerStats = {
  ts: string;
  state: string;
  message: string;
  files: { queued: number; processed: number; failed: number };
  bytesProcessed: number;
  chunks: { generated: number; embedded: number };
  index: { vectorCount: number; onDiskBytes: number; type: string; compression: string };
  throughput: { chunksPerSec: number; mbPerSec: number; etaSec: number };
};

type SearchChunk = {
  chunkId: string;
  path: string;
  title: string;
  section: string;
  fileType: string;
  modifiedAt: string;
  score: number;
  text: string;
  highlights?: string[];
};

type ReasoningResult = {
  answer: string;
  citations: { chunkId: string; path: string; section: string; quote?: string }[];
  notes?: string[];
};

function fmtBytes(n: number) {
  const units = ["B","KB","MB","GB","TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length-1) { v /= 1024; i++; }
  return `${v.toFixed(i===0?0:2)} ${units[i]}`;
}

function fmtSec(sec: number) {
  if (!isFinite(sec) || sec < 0) return "—";
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = Math.floor(sec%60);
  return `${h}h ${m}m ${s}s`;
}

const API = "http://127.0.0.1:8787";

function DashboardPage() {
  const [roots, setRoots] = useState<string[]>([]);
  const [selection, setSelection] = useState<SelectionRules>({ include: [], exclude: [] });
  const [indexConfig, setIndexConfig] = useState({ type: "ivf_pq", compression: "pq8", dimension: 384 });
  const [showSettings, setShowSettings] = useState(false);
  const [system, setSystem] = useState<SystemStats | null>(null);
  const [indexer, setIndexer] = useState<IndexerStats | null>(null);

  // chart history (last 15 min @ 1s ~ 900 points)
  const historyMax = 900;
  const [gpuHist, setGpuHist] = useState<number[]>([]);
  const [vramHist, setVramHist] = useState<number[]>([]);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const labels = useMemo(() => gpuHist.map((_, i) => i.toString()), [gpuHist]);

  // folder tree state
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [children, setChildren] = useState<Record<string, FolderNode[]>>({});
  const [treeLoading, setTreeLoading] = useState<Record<string, boolean>>({});
  
  // folder metadata state (fileCount, byteSize, pending state)
  const [folderMeta, setFolderMeta] = useState<Record<string, any>>({});

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // initial load: roots + selection + config
    (async () => {
      const r = await fetch(`${API}/api/fs/roots`).then(r => r.json());
      setRoots(r.roots ?? []);
      const s = await fetch(`${API}/api/selection`).then(r => r.json());
      setSelection(s.selection ?? { include: [], exclude: [] });
      const c = await fetch(`${API}/api/index/config`).then(r => r.json());
      setIndexConfig(c.config ?? { type: "ivf_pq", compression: "pq8", dimension: 384 });
    })();
  }, []);

  useEffect(() => {
    // websocket live updates with simple reconnect
    let stopped = false;
    let retryMs = 1000;

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`ws://127.0.0.1:8787/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        retryMs = 1000; // reset backoff
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === "system_stats") {
          const payload: SystemStats = msg.payload;
          setSystem(payload);
          setGpuHist(prev => [...prev, payload.gpu.utilPct].slice(-historyMax));
          setVramHist(prev => [...prev, payload.gpu.vramUsedMB].slice(-historyMax));
          setCpuHist(prev => [...prev, payload.cpu.utilPct].slice(-historyMax));
        }
        if (msg.type === "indexer_stats") {
          setIndexer(msg.payload as IndexerStats);
        }
        if (msg.type === "folder_meta_update") {
          // Broadcast update from backend: folder metadata computation complete
          const { folderPath, fileCount, byteSize, lastScannedAt } = msg.payload;
          setFolderMeta(prev => ({
            ...prev,
            [folderPath]: { fileCount, byteSize, lastScannedAt, pending: false }
          }));
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onclose = () => {
        if (stopped) return;
        setTimeout(connect, retryMs);
        retryMs = Math.min(10000, retryMs * 2);
      };
    };

    connect();

    return () => {
      stopped = true;
      wsRef.current?.close();
    };
  }, []);

  async function loadChildren(path: string) {
    setTreeLoading(p => ({ ...p, [path]: true }));
    try {
      const res = await fetch(`${API}/api/fs/children?path=${encodeURIComponent(path)}`).then(r => r.json());
      setChildren(prev => ({ ...prev, [path]: res.nodes ?? [] }));
      
      // Load folder metadata
      const metaRes = await fetch(`${API}/api/fs/meta?path=${encodeURIComponent(path)}`).then(r => r.json());
      const { fileCount, byteSize, pending, lastScannedAt } = metaRes;
      setFolderMeta(prev => ({
        ...prev,
        [path]: { fileCount, byteSize, pending, lastScannedAt }
      }));
    } finally {
      setTreeLoading(p => ({ ...p, [path]: false }));
    }
  }

  async function toggleExpand(path: string) {
    const next = !expanded[path];
    setExpanded(prev => ({ ...prev, [path]: next }));
    if (next && !children[path]) await loadChildren(path);
  }

  async function saveSelection(next: SelectionRules) {
    setSelection(next);
    await fetch(`${API}/api/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection: next }),
    });
  }

  async function includePath(path: string) {
    const next = {
      include: Array.from(new Set([...selection.include, path])),
      exclude: selection.exclude.filter(x => x !== path),
    };
    await saveSelection(next);
  }

  async function excludePath(path: string) {
    const next = {
      include: selection.include.filter(x => x !== path),
      exclude: Array.from(new Set([...selection.exclude, path])),
    };
    await saveSelection(next);
  }

  async function start() { await fetch(`${API}/api/index/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: "default" }) }); }
  async function pause() { await fetch(`${API}/api/index/pause`, { method: "POST" }); }
  async function resume() { await fetch(`${API}/api/index/resume`, { method: "POST" }); }
  async function stop() { await fetch(`${API}/api/index/stop`, { method: "POST" }); }
  async function rescan() { await fetch(`${API}/api/index/rescan`, { method: "POST" }); }

  const gpuData = useMemo(() => ({
    labels,
    datasets: [{ label: "GPU Util %", data: gpuHist }]
  }), [labels, gpuHist]);

  const cpuData = useMemo(() => ({
    labels,
    datasets: [{ label: "CPU Util %", data: cpuHist }]
  }), [labels, cpuHist]);

  const vramData = useMemo(() => ({
    labels,
    datasets: [{ label: "VRAM Used (MB)", data: vramHist }]
  }), [labels, vramHist]);

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="text-lg font-semibold">Indexer Control Panel</div>
          <div className="text-xs text-slate-400">localhost</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => setShowSettings(true)}>Settings</button>
          <button className="btn" onClick={rescan}>Rescan</button>
          <button className="btn" onClick={start}>Start</button>
          <button className="btn" onClick={pause}>Pause</button>
          <button className="btn" onClick={resume}>Resume</button>
          <button className="btn btn-danger" onClick={stop}>Stop</button>
        </div>
      </header>

      {showSettings && (
        <SettingsModal
          config={indexConfig}
          onSave={async (cfg) => {
            setIndexConfig(cfg);
            await fetch(`${API}/api/index/config`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ config: cfg }),
            });
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left */}
        <aside className="w-[420px] border-r border-slate-800 min-h-0 flex flex-col">
          <div className="p-3 border-b border-slate-800">
            <div className="text-sm font-semibold">Folders</div>
            <div className="text-xs text-slate-400">Select include/exclude rules (no file list)</div>
          </div>

          <div className="flex-1 overflow-auto p-2">
            {roots.map(root => (
              <TreeNode
                key={root}
                node={{ path: root, name: root, type: "folder", hasChildren: true, selected: "none" }}
                depth={0}
                expanded={!!expanded[root]}
                onToggleExpand={() => toggleExpand(root)}
                loading={!!treeLoading[root]}
                children={children[root] || []}
                expandedMap={expanded}
                childrenMap={children}
                loadingMap={treeLoading}
                folderMeta={folderMeta}
                onExpand={toggleExpand}
                onLoadChildren={loadChildren}
                onInclude={includePath}
                onExclude={excludePath}
                selection={selection}
              />
            ))}
          </div>

          <div className="p-3 border-t border-slate-800">
            <div className="text-sm font-semibold mb-2">Rules</div>
            <RuleList title="Include" items={selection.include} onRemove={async (p) => saveSelection({ include: selection.include.filter(x => x!==p), exclude: selection.exclude })} />
            <div className="h-3" />
            <RuleList title="Exclude" items={selection.exclude} onRemove={async (p) => saveSelection({ include: selection.include, exclude: selection.exclude.filter(x => x!==p) })} />
          </div>
        </aside>

        {/* Right */}
        <main className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
          <section className="grid grid-cols-3 gap-3">
            <StatCard title="GPU" subtitle={system?.gpu.name ?? "—"}>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <KV k="Util" v={system ? `${system.gpu.utilPct}%` : "—"} />
                <KV k="VRAM" v={system ? `${(system.gpu.vramUsedMB/1024).toFixed(1)} / ${(system.gpu.vramTotalMB/1024).toFixed(1)} GB` : "—"} />
                <KV k="Mem BW" v={system ? `${system.gpu.memBwGBps} GB/s` : "—"} />
                <KV k="Disk R/W" v={system ? `${system.disk.readMBps} / ${system.disk.writeMBps} MB/s` : "—"} />
              </div>
            </StatCard>

            <StatCard title="CPU" subtitle="System">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <KV k="Util" v={system ? `${system.cpu.utilPct}%` : "—"} />
                <KV k="Clock" v={system ? `${system.cpu.clockGHz.toFixed(2)} GHz` : "—"} />
                <KV k="Threads" v={system ? `${system.cpu.threads}` : "—"} />
                <KV k="RAM" v={system ? `${(system.ram.usedMB/1024).toFixed(1)} / ${(system.ram.totalMB/1024).toFixed(1)} GB` : "—"} />
              </div>
            </StatCard>

            <StatCard title="Indexer" subtitle={indexer?.state ?? "—"}>
              <div className="text-xs text-slate-400 mb-2">{indexer?.message ?? "—"}</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <KV k="Queued" v={indexer ? `${indexer.files.queued}` : "—"} />
                <KV k="Processed" v={indexer ? `${indexer.files.processed}` : "—"} />
                <KV k="Failed" v={indexer ? `${indexer.files.failed}` : "—"} />
                <KV k="Bytes" v={indexer ? fmtBytes(indexer.bytesProcessed) : "—"} />
                <KV k="Chunks Gen" v={indexer ? `${indexer.chunks.generated}` : "—"} />
                <KV k="Chunks Emb" v={indexer ? `${indexer.chunks.embedded}` : "—"} />
                <KV k="Emb Pending" v={indexer && (indexer as any).embeddingsPending != null ? `${(indexer as any).embeddingsPending}` : "—"} />
                <KV k="Index Size" v={indexer ? fmtBytes(indexer.index.onDiskBytes) : "—"} />
                <KV k="Index Path" v={indexer?.index.indexPath ?? "—"} />
                <KV k="Chunks/s" v={indexer ? `${indexer.throughput.chunksPerSec}` : "—"} />
                <KV k="ETA" v={indexer ? fmtSec(indexer.throughput.etaSec) : "—"} />
              </div>
              {system?.gpu.available === false && (
                <div className="mt-2 text-xs text-amber-400">⚠ GPU offline (CPU fallback)</div>
              )}
            </StatCard>
          </section>

          <section className="grid grid-cols-3 gap-3">
            <ChartCard title="GPU Utilization">
              <Line data={gpuData} options={{ responsive: true, animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { min: 0, max: 100 } } }} />
            </ChartCard>
            <ChartCard title="VRAM Used">
              <Line data={vramData} options={{ responsive: true, animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false } } }} />
            </ChartCard>
            <ChartCard title="CPU Utilization">
              <Line data={cpuData} options={{ responsive: true, animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { min: 0, max: 100 } } }} />
            </ChartCard>
          </section>
        </main>
      </div>
    </div>
  );
}

function StatCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-slate-400">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="text-sm font-semibold mb-2">{title}</div>
      <div className="h-40">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2 bg-slate-900/40 rounded-lg px-2 py-1 border border-slate-800">
      <div className="text-slate-400">{k}</div>
      <div className="font-medium">{v}</div>
    </div>
  );
}

function RuleList({ title, items, onRemove }: { title: string; items: string[]; onRemove: (p: string) => void }) {
  return (
    <div>
      <div className="text-xs text-slate-400 mb-1">{title}</div>
      <div className="space-y-1">
        {items.length === 0 ? (
          <div className="text-xs text-slate-600">—</div>
        ) : items.map(p => (
          <div key={p} className="flex items-center justify-between gap-2 text-xs bg-slate-900/40 border border-slate-800 rounded px-2 py-1">
            <div className="truncate" title={p}>{p}</div>
            <button className="text-slate-300 hover:text-white" onClick={() => onRemove(p)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TreeNode(props: {
  node: FolderNode;
  depth: number;
  expanded: boolean;
  onToggleExpand: () => void;
  loading: boolean;
  children: FolderNode[];
  expandedMap: Record<string, boolean>;
  childrenMap: Record<string, FolderNode[]>;
  loadingMap: Record<string, boolean>;
  folderMeta: Record<string, any>;
  onExpand: (path: string) => Promise<void>;
  onLoadChildren: (path: string) => Promise<void>;
  onInclude: (path: string) => Promise<void>;
  onExclude: (path: string) => Promise<void>;
  selection: SelectionRules;
}) {
  const { node, depth, expanded, onToggleExpand, loading, children, folderMeta } = props;

  const isIncluded = props.selection.include.includes(node.path);
  const isExcluded = props.selection.exclude.includes(node.path);
  
  // Get metadata for this folder
  const meta = folderMeta[node.path];
  const metaStr = meta?.pending ? "Computing…" : 
                  (meta?.fileCount != null ? `${fmtBytes(meta.byteSize)} • ${meta.fileCount} files` : "");

  return (
    <div>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: 8 + depth * 14 }}>
        <button
          className={clsx("w-5 h-5 rounded hover:bg-slate-800 flex items-center justify-center", node.hasChildren ? "" : "opacity-30")}
          onClick={node.hasChildren ? onToggleExpand : undefined}
          title={expanded ? "Collapse" : "Expand"}
        >
          {node.hasChildren ? (expanded ? "▾" : "▸") : "•"}
        </button>

        <button
          className={clsx("w-5 h-5 rounded border border-slate-700 flex items-center justify-center text-xs",
            isIncluded ? "bg-emerald-700/60 border-emerald-500" :
            isExcluded ? "bg-rose-700/60 border-rose-500" :
            "bg-slate-900/40")}
          title={isIncluded ? "Included" : isExcluded ? "Excluded" : "Not set"}
          onClick={async () => {
            if (isIncluded) await props.onExclude(node.path);
            else await props.onInclude(node.path);
          }}
        >
          {isIncluded ? "✓" : isExcluded ? "—" : ""}
        </button>

        <div className="flex-1 min-w-0">
          <div className="truncate text-sm" title={node.path}>{node.name}</div>
          {metaStr && (
            <div className={clsx("text-xs", meta?.pending ? "text-slate-400" : "text-slate-500")}>
              {metaStr}
            </div>
          )}
        </div>

        <div className="flex gap-1">
          <button className="btn-xs" onClick={() => props.onInclude(node.path)}>Include</button>
          <button className="btn-xs" onClick={() => props.onExclude(node.path)}>Exclude</button>
        </div>
      </div>

      {expanded && (
        <div>
          {loading ? (
            <div className="text-xs text-slate-500" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>Loading…</div>
          ) : children.length === 0 ? (
            <div className="text-xs text-slate-600" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>—</div>
          ) : children.map(ch => (
            <TreeNode
              key={ch.path}
              node={ch}
              depth={depth + 1}
              expanded={!!props.expandedMap[ch.path]}
              onToggleExpand={() => props.onExpand(ch.path)}
              loading={!!props.loadingMap[ch.path]}
              children={props.childrenMap[ch.path] || []}
              expandedMap={props.expandedMap}
              childrenMap={props.childrenMap}
              loadingMap={props.loadingMap}
              folderMeta={props.folderMeta}
              onExpand={props.onExpand}
              onLoadChildren={props.onLoadChildren}
              onInclude={props.onInclude}
              onExclude={props.onExclude}
              selection={props.selection}
            />
          ))}
        </div>
      )}
    </div>
  );
}
function SettingsModal({ config, onSave, onClose }: { config: any; onSave: (cfg: any) => void; onClose: () => void }) {
  const [type, setType] = useState(config.type);
  const [compression, setCompression] = useState(config.compression);
  const [dimension, setDimension] = useState(config.dimension);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="card w-[480px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <div className="text-lg font-semibold mb-4">Index Settings</div>
        
        <div className="space-y-4">
          <div>
            <label className="text-sm text-slate-400 block mb-1">Index Type</label>
            <select 
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
              value={type}
              onChange={e => setType(e.target.value)}
            >
              <option value="ivf_pq">IVF-PQ (Fast search, good compression)</option>
              <option value="hnsw">HNSW (Best accuracy, higher memory)</option>
              <option value="flat">Flat (Exact search, no compression)</option>
            </select>
          </div>

          <div>
            <label className="text-sm text-slate-400 block mb-1">Compression</label>
            <select 
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
              value={compression}
              onChange={e => setCompression(e.target.value)}
            >
              <option value="none">None (Full precision)</option>
              <option value="pq8">PQ8 (8-bit quantization)</option>
              <option value="pq16">PQ16 (16-bit quantization)</option>
              <option value="sq8">SQ8 (Scalar quantization 8-bit)</option>
            </select>
          </div>

          <div>
            <label className="text-sm text-slate-400 block mb-1">Vector Dimension</label>
            <input 
              type="number"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
              value={dimension}
              onChange={e => setDimension(parseInt(e.target.value))}
              min="128"
              max="1536"
            />
            <div className="text-xs text-slate-500 mt-1">Default 384 for all-MiniLM-L6-v2</div>
          </div>

          <div className="bg-slate-900/40 border border-slate-800 rounded p-3 text-xs text-slate-400">
            <div className="font-semibold mb-1">Current Index:</div>
            <div>Type: {config.type.toUpperCase()}</div>
            <div>Compression: {config.compression.toUpperCase()}</div>
            <div>Dimension: {config.dimension}d</div>
          </div>
        </div>

        <div className="flex gap-2 mt-4 justify-end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button 
            className="btn bg-emerald-700 hover:bg-emerald-600" 
            onClick={() => onSave({ type, compression, dimension })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Search & Reasoning routes ---
function TopNav() {
  const linkCls = ({ isActive }: { isActive: boolean }) => clsx("px-3 py-2 rounded text-sm", isActive ? "bg-slate-800 text-white" : "text-slate-300 hover:text-white");
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/80 backdrop-blur">
      <div className="text-lg font-semibold">Indexer Control Panel</div>
      <div className="flex items-center gap-2">
        <NavLink to="/dashboard" className={linkCls}>Dashboard</NavLink>
        <NavLink to="/search" className={linkCls}>Search</NavLink>
        <NavLink to="/settings" className={linkCls}>Settings</NavLink>
      </div>
      <div className="text-xs text-slate-400">localhost</div>
    </div>
  );
}

function SearchRoute() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("keyword");
  const [topK, setTopK] = useState(20);
  const [minScore, setMinScore] = useState(0.3);
  const [results, setResults] = useState<SearchChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [reasoning, setReasoning] = useState<ReasoningResult | null>(null);
  const [reasoningLoading, setReasoningLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const togglePin = (id: string) => {
    setPinned(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      // Pinned implies selected
      setSelected(sel => {
        const s = new Set(sel);
        s.add(id);
        return s;
      });
      return next;
    });
  };

  const runSearch = async () => {
    setLoading(true); setError(null); setReasoning(null);
    try {
      const res = await fetch(`${API}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, mode, topK, filters: { minScore } })
      });
      const data = await res.json();
      setResults(data.chunks || []);
      setSelected(new Set());
      setPinned(new Set());
    } catch (e: any) {
      setError(e?.message || "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const runReason = async () => {
    const ids = pinned.size > 0 ? Array.from(pinned) : Array.from(selected);
    console.log('[runReason] Starting with', ids.length, 'chunks');
    setReasoningLoading(true); setError(null);
    try {
      console.log('[runReason] Sending request to', `${API}/api/reason`);
      const res = await fetch(`${API}/api/reason`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query || "What are the key points?", chunkIds: ids, profile: "answer_strict", model: "llama3.1:8b-instruct-q4_K_M", stream: false })
      });
      console.log('[runReason] Response status:', res.status);
      const data = await res.json();
      console.log('[runReason] Response data:', data);
      setReasoning({ answer: data.answer, citations: data.citations || [], notes: data.notes });
      if (!res.ok) setError("Reasoning returned an error");
    } catch (e: any) {
      console.error('[runReason] Error:', e);
      setError(e?.message || "Reasoning failed");
    } finally {
      setReasoningLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/40 flex items-center gap-3">
        <input
          className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
          placeholder="Search your corpus (semantic/keyword/hybrid)"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") runSearch(); }}
        />
        <select className="bg-slate-900 border border-slate-700 rounded px-2 py-2 text-sm" value={mode} onChange={e => setMode(e.target.value)}>
          <option value="semantic">Semantic</option>
          <option value="keyword">Keyword</option>
          <option value="hybrid">Hybrid</option>
        </select>
        <button className="btn" onClick={runSearch} disabled={loading}>{loading ? "Searching…" : "Search"}</button>
        <button 
          className="btn" 
          onClick={() => {
            console.log('[Button Click] selected.size:', selected.size, 'pinned.size:', pinned.size, 'reasoningLoading:', reasoningLoading);
            runReason();
          }} 
          disabled={reasoningLoading || (selected.size === 0 && pinned.size === 0)}
        >
          Generate Answer
        </button>
      </div>

      {error && <div className="px-4 py-2 text-sm text-amber-400">{error}</div>}

      <div className="flex flex-1 min-h-0">
        <aside className="w-[260px] border-r border-slate-800 p-3 space-y-3 bg-slate-950/40">
          <div className="text-sm font-semibold">Filters</div>
          <div className="text-xs text-slate-400">Min score</div>
          <input type="range" min="0.5" max="0.95" step="0.01" value={minScore} onChange={e => setMinScore(parseFloat(e.target.value))} className="w-full" />
          <div className="text-sm">{minScore.toFixed(2)}</div>
          <div className="text-xs text-slate-400">Top K</div>
          <input type="number" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm" value={topK} onChange={e => setTopK(parseInt(e.target.value) || 10)} min={1} max={100} />
          <div className="text-xs text-slate-500">Pinned chunks are always used.</div>
        </aside>

        <main className="flex-1 grid grid-cols-3 min-h-0">
          <div className="col-span-2 border-r border-slate-800 p-4 space-y-3 overflow-auto">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Answer</div>
              <div className="text-xs text-slate-400">Model: llama3.1:8b-instruct-q4_K_M</div>
            </div>
            <div className="min-h-[180px] bg-slate-900/40 border border-slate-800 rounded p-3 text-sm whitespace-pre-wrap">
              {reasoningLoading ? "Generating…" : (reasoning?.answer ?? "Run reasoning to see an answer with citations.")}
            </div>
            {reasoning?.citations?.length ? (
              <div className="space-y-2">
                <div className="text-xs text-slate-400 uppercase">Citations</div>
                <div className="space-y-1 text-sm">
                  {reasoning.citations.map((c, idx) => (
                    <div key={`${c.chunkId}-${idx}`} className="bg-slate-900/40 border border-slate-800 rounded px-2 py-1">
                      <div className="font-semibold">{c.chunkId}</div>
                      <div className="text-xs text-slate-400">{c.path} — {c.section}</div>
                      {c.quote && <div className="text-xs">“{c.quote}”</div>}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="border-l border-slate-800 p-4 space-y-3 overflow-auto">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Results</div>
              <div className="text-xs text-slate-400">{results.length} chunks</div>
            </div>
            <div className="space-y-3">
              {results.map(chunk => {
                const isSelected = selected.has(chunk.chunkId);
                const isPinned = pinned.has(chunk.chunkId);
                return (
                  <div key={chunk.chunkId} className="bg-slate-900/40 border border-slate-800 rounded p-3 text-sm space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold truncate" title={chunk.title}>{chunk.title}</div>
                      <div className="text-xs text-slate-400">{(chunk.score * 100).toFixed(1)}%</div>
                    </div>
                    <div className="text-xs text-slate-500 truncate" title={chunk.path}>{chunk.path}</div>
                    <div className="text-xs text-slate-400">{chunk.section}</div>
                    <div className="text-xs text-slate-300 line-clamp-3">{chunk.text}</div>
                    <div className="flex items-center gap-2 pt-2">
                      <label className="flex items-center gap-1 text-xs cursor-pointer">
                        <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(chunk.chunkId)} /> Select
                      </label>
                      <button className={clsx("text-xs px-2 py-1 rounded border", isPinned ? "border-emerald-500 text-emerald-300" : "border-slate-700 text-slate-300")}
                        onClick={() => togglePin(chunk.chunkId)}>{isPinned ? "Pinned" : "Pin"}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function SettingsRoute() {
  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <div className="text-lg font-semibold">Settings</div>
      <div className="text-sm text-slate-300">Configure model, prompt profiles, and retrieval defaults. (Placeholder UI)</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="card p-3">
          <div className="font-semibold mb-2">Model</div>
          <div className="text-xs text-slate-400">llama3.2:latest (local)</div>
        </div>
        <div className="card p-3">
          <div className="font-semibold mb-2">Prompt Profile</div>
          <div className="text-xs text-slate-400">answer_strict</div>
        </div>
      </div>
    </div>
  );
}

// --- Router Shell ---
export function App() {
  return (
    <BrowserRouter>
      <div className="h-screen flex flex-col bg-slate-950 text-slate-100">
        <TopNav />
        <div className="flex-1 min-h-0">
          <Routes>
            <Route path="/search" element={<SearchRoute />} />
            <Route path="/settings" element={<SettingsRoute />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="*" element={<DashboardPage />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}