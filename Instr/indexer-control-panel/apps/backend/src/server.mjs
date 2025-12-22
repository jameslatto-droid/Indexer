import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(websocket);

const STATE = {
  selection: { include: ["E:/Git/Indexing/Instr/indexer-control-panel"], exclude: ["**/node_modules", "**/.git"] },
  indexConfig: {
    type: "ivf_pq",
    compression: "pq8",
    dimension: 384
  },
  indexer: {
    state: "idle",
    message: "Idle",
    files: { queued: 0, processed: 0, failed: 0 },
    bytesProcessed: 0,
    chunks: { generated: 0, embedded: 0 },
    index: { vectorCount: 0, onDiskBytes: 0, type: "ivf_pq", compression: "pq8" },
    throughput: { chunksPerSec: 0, mbPerSec: 0, etaSec: 0 }
  }
};

// --- Indexer Worker Process Management ---
let indexerWorker = null;
let workerReady = false;
let workerPid = null;

function spawnIndexerWorker() {
  if (indexerWorker) return;
  
  const workerPath = path.join(__dirname, "indexer-worker.mjs");
  const venvPython = path.join(__dirname, "..", "venv-gpu", "Scripts", "python.exe");
  
  indexerWorker = spawn("node", [workerPath], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      PYTHON_EXE: venvPython
    }
  });
  // Pipe worker logs to server stdout/stderr for visibility
  indexerWorker.stdout?.on("data", (data) => {
    process.stdout.write(`[worker stdout] ${data}`);
  });
  indexerWorker.stderr?.on("data", (data) => {
    process.stderr.write(`[worker stderr] ${data}`);
  });
  workerPid = indexerWorker.pid;
  workerReady = false;
  
  indexerWorker.on("message", (msg) => {
    if (msg.type === "ready") {
      console.log("Indexer worker ready");
      workerReady = true;
    } else if (msg.type === "stats") {
      if (!msg.payload) return;
      // Update STATE from worker progress
      STATE.indexer = {
        state: msg.payload.state,
        message: msg.payload.message,
        files: msg.payload.files,
        bytesProcessed: msg.payload.bytesProcessed,
        chunks: msg.payload.chunks,
        index: msg.payload.index,
        throughput: msg.payload.throughput
      };
      
      // Broadcast to all WS clients
      broadcastIndexerStats();
    } else if (msg.type === "complete") {
      const payload = msg.payload || {};
      STATE.indexer.state = "idle";
      STATE.indexer.message = `Complete: ${payload.filesProcessed ?? 0} files, ${payload.chunksEmbedded ?? 0} chunks`;
      broadcastIndexerStats();
    } else if (msg.type === "error") {
      const errMsg = msg.payload?.message ?? "Unknown worker error";
      STATE.indexer.state = "idle";
      STATE.indexer.message = `Error: ${errMsg}`;
      broadcastIndexerStats();
    } else if (msg.type === "stopped") {
      STATE.indexer.state = "idle";
      STATE.indexer.message = "Stopped";
      broadcastIndexerStats();
    }
  });
  
  indexerWorker.on("error", (err) => {
    console.error("Indexer worker error:", err);
    indexerWorker = null;
  });
  
  indexerWorker.on("exit", (code) => {
    console.log(`Indexer worker exited with code ${code}`);
    indexerWorker = null;
    workerReady = false;
    workerPid = null;
  });
}

function broadcastIndexerStats() {
  const conns = fastify.websocketServer?.clients;
  if (!conns) return;
  const msg = { type: "indexer_stats", payload: { ts: new Date().toISOString(), ...STATE.indexer } };
  for (const client of conns) {
    if (client.readyState === 1) {
      client.send(JSON.stringify(msg));
    }
  }
}

// --- Folder Metadata Cache ---
const folderMetaCache = new Map(); // { path -> { fileCount, byteSize, lastScannedAt, pending } }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedMeta(folderPath) {
  const cached = folderMetaCache.get(folderPath);
  if (!cached) return null;
  if (Date.now() - cached.computedAt > CACHE_TTL_MS) {
    folderMetaCache.delete(folderPath);
    return null;
  }
  return cached;
}

function setCachedMeta(folderPath, data) {
  folderMetaCache.set(folderPath, { ...data, computedAt: Date.now() });
}

// --- Background Folder Computation ---
async function computeFolderMetaAsync(folderPath, maxDepth = 3, maxFiles = 50000) {
  // Async recursive computation with safety limits
  if (!isDirectory(folderPath)) return null;

  let fileCount = 0;
  let byteSize = 0;

  async function walk(dir, depth) {
    if (depth > maxDepth || fileCount > maxFiles) return;
    
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (fileCount > maxFiles) break;
        
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isFile()) {
            fileCount++;
            const stat = await fs.promises.stat(fullPath);
            byteSize += stat.size;
          } else if (entry.isDirectory() && depth < maxDepth) {
            // Recurse but with depth check
            await walk(fullPath, depth + 1);
          }
        } catch {
          // Skip errors on individual files
        }
      }
    } catch {
      // Skip errors on directory traversal
    }
  }

  await walk(folderPath, 0);
  return { fileCount, byteSize, lastScannedAt: new Date().toISOString() };
}

// --- Broadcast folder meta update via WebSocket ---
function broadcastFolderMeta(folderPath, data) {
  const conns = fastify.websocketServer?.clients;
  if (!conns) return;
  for (const client of conns) {
    if (client.readyState === 1) {
      // Send flattened payload fields to match frontend expectation
      client.send(JSON.stringify({
        type: "folder_meta_update",
        payload: {
          folderPath,
          fileCount: data?.fileCount,
          byteSize: data?.byteSize,
          lastScannedAt: data?.lastScannedAt
        }
      }));
    }
  }
}

// --- GPU Telemetry via NVML (nvidia-smi) ---
let gpuAvailable = true;
let lastGpuError = null;
let nvsmiPath = null;

// Find nvidia-smi on startup
function initGpuTelemetry() {
  const possiblePaths = [
    "C:\\Windows\\System32\\nvidia-smi.exe",
    "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
    "C:\\Program Files (x86)\\NVIDIA Corporation\\PhysX\\Common\\nvidia-smi.exe",
    "nvidia-smi"
  ];
  
  for (const p of possiblePaths) {
    try {
      const output = execSync(`"${p}" --version`, { 
        encoding: 'utf-8',
        timeout: 3000,
        stdio: 'pipe'
      });
      if (output.includes("NVIDIA")) {
        nvsmiPath = p;
        console.log(`GPU telemetry: Found nvidia-smi at ${p}`);
        return true;
      }
    } catch {
      // This path doesn't work, try next
    }
  }
  
  gpuAvailable = false;
  lastGpuError = "nvidia-smi not found in any standard location";
  console.warn(`GPU telemetry: ${lastGpuError}`);
  return false;
}

function getGpuTelemetry() {
  // Returns { available, name, utilPct, vramUsedMB, vramTotalMB, temperatureC, powerW }
  // Returns gracefully if GPU unavailable
  
  if (!gpuAvailable || !nvsmiPath) {
    return {
      available: false,
      name: "N/A",
      utilPct: 0,
      vramUsedMB: 0,
      vramTotalMB: 0,
      temperatureC: 0,
      powerW: 0,
      error: lastGpuError
    };
  }

  try {
    const cmd = `"${nvsmiPath}" --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    
    if (!output) {
      gpuAvailable = false;
      lastGpuError = "nvidia-smi returned empty";
      return getGpuTelemetry();
    }

    const parts = output.split(',').map(p => p.trim());
    if (parts.length < 6) {
      throw new Error(`Expected 6 fields, got ${parts.length}`);
    }

    const name = parts[0];
    const utilPct = Math.min(100, Math.max(0, parseInt(parts[1]) || 0));
    const vramUsedMB = parseInt(parts[2]) || 0;
    const vramTotalMB = parseInt(parts[3]) || 0;
    const temperatureC = parseInt(parts[4]) || 0;
    const powerW = parseFloat(parts[5]) || 0;

    return {
      available: true,
      name,
      utilPct,
      vramUsedMB,
      vramTotalMB,
      temperatureC,
      powerW
    };
  } catch (e) {
    // Temporarily disable GPU on error, will retry next call
    lastGpuError = e.message;
    console.warn(`GPU telemetry failed: ${e.message}`);
    return {
      available: false,
      name: "N/A",
      utilPct: 0,
      vramUsedMB: 0,
      vramTotalMB: 0,
      temperatureC: 0,
      powerW: 0,
      error: e.message
    };
  }
}

// --- Helpers (Windows path safety) ---
function normalizePath(p) {
  // Accept C:/ style; convert backslashes; prevent weirdness
  const cleaned = (p || "").replaceAll("\\", "/");
  // Preserve drive root like "C:/"
  return cleaned;
}

function listRoots() {
  // Heuristic: probe common drive letters
  const roots = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const candidate = `${letter}:/`;
    try {
      if (fs.existsSync(candidate)) roots.push(candidate);
    } catch {}
  }
  // fallback to current drive
  if (roots.length === 0) roots.push(path.parse(process.cwd()).root.replaceAll("\\", "/"));
  return roots;
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function folderMetaQuick(p) {
  // Try cache first
  const cached = getCachedMeta(p);
  if (cached) {
    return { fileCount: cached.fileCount, byteSize: cached.byteSize, lastScannedAt: cached.lastScannedAt };
  }
  // Start async computation in background
  computeFolderMetaAsync(p).then(meta => {
    if (meta) {
      setCachedMeta(p, meta);
      broadcastFolderMeta(p, meta);
    }
  }).catch(e => console.error(`Background meta compute error for ${p}:`, e));
  
  return { fileCount: undefined, byteSize: undefined, lastScannedAt: undefined };
}

function getChildren(folderPath) {
  const p = normalizePath(folderPath);
  const entries = fs.readdirSync(p, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).slice(0, 200); // safety cap
  return dirs.map(d => {
    const childPath = path.join(p, d.name).replaceAll("\\", "/");
    // Determine if child has children (cheap check)
    let hasChildren = false;
    try {
      const sub = fs.readdirSync(childPath, { withFileTypes: true });
      hasChildren = sub.some(s => s.isDirectory());
    } catch {}
    return {
      path: childPath,
      name: d.name,
      type: "folder",
      hasChildren,
      selected: "none",
      meta: folderMetaQuick(childPath)
    };
  });
}

// --- Preview candidate files (helps validate selection) ---
const ALLOWED_EXTS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.js', '.ts', '.tsx', '.jsx', '.css', '.mjs', '.py', '.html']);

async function previewFiles(rootPath, maxDepth = 3, maxFiles = 1000) {
  const results = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name).replaceAll("\\", "/");
      if (entry.isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        if (ALLOWED_EXTS.has(ext)) {
          results.push(fullPath);
          if (results.length >= maxFiles) break;
        }
      } else if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      }
    }
  }
  await walk(rootPath, 0);
  return results;
}

fastify.get("/api/index/preview", async (req, reply) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.searchParams.get("path");
  const depth = parseInt(url.searchParams.get("depth") || "3");
  const max = parseInt(url.searchParams.get("max") || "100");
  if (!p) return reply.code(400).send({ error: "Missing path" });
  const folderPath = normalizePath(p);
  if (!isDirectory(folderPath)) return reply.code(400).send({ error: "Not a directory" });
  const files = await previewFiles(folderPath, depth, max);
  return { count: files.length, files };
});
// --- API: filesystem ---
fastify.get("/api/fs/roots", async () => ({ roots: listRoots() }));

fastify.get("/api/fs/children", async (req, reply) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.searchParams.get("path");
  if (!p) return reply.code(400).send({ error: "Missing path" });
  const folderPath = normalizePath(p);
  if (!isDirectory(folderPath)) return reply.code(400).send({ error: "Not a directory" });
  try {
    const nodes = getChildren(folderPath);
    return { nodes };
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send({ error: "Failed to read directory" });
  }
});

fastify.get("/api/fs/meta", async (req, reply) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.searchParams.get("path");
  if (!p) return reply.code(400).send({ error: "Missing path" });
  const folderPath = normalizePath(p);
  if (!isDirectory(folderPath)) return reply.code(400).send({ error: "Not a directory" });
  
  // Check cache
  const cached = getCachedMeta(folderPath);
  if (cached) {
    return { path: folderPath, pending: false, ...cached };
  }
  
  // Return pending and start async computation
  (async () => {
    try {
      const meta = await computeFolderMetaAsync(folderPath);
      if (meta) {
        setCachedMeta(folderPath, meta);
        broadcastFolderMeta(folderPath, meta);
      }
    } catch (e) {
      req.log.error(`Error computing meta for ${folderPath}:`, e);
    }
  })();
  
  return { path: folderPath, pending: true, fileCount: null, byteSize: null };
});

// --- API: selection ---
fastify.get("/api/selection", async () => ({ selection: STATE.selection }));

fastify.post("/api/selection", async (req, reply) => {
  const body = req.body;
  if (!body || typeof body !== "object" || !body.selection) return reply.code(400).send({ error: "Missing selection" });
  const sel = body.selection;
  STATE.selection = {
    include: Array.isArray(sel.include) ? sel.include : [],
    exclude: Array.isArray(sel.exclude) ? sel.exclude : []
  };
  return { ok: true };
});

// --- API: index config ---
fastify.get("/api/index/config", async () => ({ config: STATE.indexConfig }));

fastify.post("/api/index/config", async (req, reply) => {
  const body = req.body;
  if (!body || typeof body !== "object" || !body.config) return reply.code(400).send({ error: "Missing config" });
  const cfg = body.config;
  STATE.indexConfig = {
    type: cfg.type || STATE.indexConfig.type,
    compression: cfg.compression || STATE.indexConfig.compression,
    dimension: cfg.dimension || STATE.indexConfig.dimension
  };
  return { ok: true };
});

// --- API: index controls (real worker process) ---
fastify.post("/api/index/start", async () => {
  if (STATE.indexer.state !== "idle") {
    return { ok: false, error: "Indexer already running" };
  }
  
  // Spawn worker if not already running
  if (!indexerWorker) {
    spawnIndexerWorker();
  }
  if (!indexerWorker) {
    return { ok: false, error: "Failed to spawn indexer worker" };
  }
  
  // Reset state
  STATE.indexer = {
    state: "scanning",
    message: "Scanning files…",
    files: { queued: 0, processed: 0, failed: 0 },
    bytesProcessed: 0,
    chunks: { generated: 0, embedded: 0 },
    index: { vectorCount: 0, onDiskBytes: 0, type: STATE.indexConfig.type, compression: STATE.indexConfig.compression },
    throughput: { chunksPerSec: 0, mbPerSec: 0, etaSec: 0 }
  };
  
  // Send start command to worker with current selection rules and config
  if (indexerWorker && indexerWorker.send) {
    indexerWorker.send({ cmd: "start", selection: STATE.selection, config: STATE.indexConfig });
  }
  
  broadcastIndexerStats();
  return { ok: true };
});

fastify.post("/api/index/pause", async () => {
  if (STATE.indexer.state !== "embedding") {
    return { ok: false, error: "Indexer not running" };
  }
  
  if (indexerWorker && indexerWorker.send) {
    indexerWorker.send({ cmd: "pause" });
  }
  
  STATE.indexer.state = "paused";
  STATE.indexer.message = "Paused";
  broadcastIndexerStats();
  return { ok: true };
});

fastify.post("/api/index/resume", async () => {
  if (STATE.indexer.state !== "paused") {
    return { ok: false, error: "Indexer not paused" };
  }
  
  if (indexerWorker && indexerWorker.send) {
    indexerWorker.send({ cmd: "resume" });
  }
  
  STATE.indexer.state = "embedding";
  STATE.indexer.message = "Resuming…";
  broadcastIndexerStats();
  return { ok: true };
});

fastify.post("/api/index/stop", async () => {
  if (STATE.indexer.state === "idle") {
    return { ok: false, error: "Indexer not running" };
  }
  
  if (indexerWorker && indexerWorker.send) {
    indexerWorker.send({ cmd: "stop" });
  }
  
  STATE.indexer.state = "idle";
  STATE.indexer.message = "Stopped";
  broadcastIndexerStats();
  return { ok: true };
});

fastify.post("/api/index/rescan", async () => {
  // Stop current indexer if running
  if (STATE.indexer.state !== "idle") {
    if (indexerWorker && indexerWorker.send) {
      indexerWorker.send({ cmd: "stop" });
    }
  }
  
  // Reset and restart
  STATE.indexer = {
    state: "scanning",
    message: "Rescanning files…",
    files: { queued: 0, processed: 0, failed: 0 },
    bytesProcessed: 0,
    chunks: { generated: 0, embedded: 0 },
    index: { vectorCount: 0, onDiskBytes: 0, type: STATE.indexConfig.type, compression: STATE.indexConfig.compression },
    throughput: { chunksPerSec: 0, mbPerSec: 0, etaSec: 0 }
  };
  
  // Spawn new worker
  if (!indexerWorker) {
    spawnIndexerWorker();
  }
  if (!indexerWorker) {
    return { ok: false, error: "Failed to spawn indexer worker" };
  }
  
  if (indexerWorker && indexerWorker.send) {
    indexerWorker.send({ cmd: "start", selection: STATE.selection, config: STATE.indexConfig });
  }
  
  broadcastIndexerStats();
  return { ok: true };
});

// --- API: index stats (quick polling aid) ---
fastify.get("/api/index/stats", async () => ({ ts: new Date().toISOString(), ...STATE.indexer }));
fastify.get("/api/worker/status", async () => ({ ready: workerReady, pid: workerPid, hasWorker: !!indexerWorker }));

// --- WebSocket stream ---
fastify.get("/ws", { websocket: true }, (connection, req) => {
  const send = (msg) => connection.socket.send(JSON.stringify(msg));
  send({ type: "hello", payload: { ok: true, ts: new Date().toISOString() } });
});

function systemStatsMock() {
  // OS-derived stats + Real GPU telemetry via NVML
  const now = new Date().toISOString();
  const cpus = os.cpus();
  const load = os.loadavg()[0]; // not great on Windows but fine as placeholder
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Real GPU telemetry
  const gpuTelem = getGpuTelemetry();

  // Disk I/O mock (would be replaced with real WMI/ETW data in Phase 3)
  const t = Date.now() / 1000;

  return {
    ts: now,
    gpu: {
      name: gpuTelem.available ? gpuTelem.name : "NVIDIA GeForce RTX 4080 (offline)",
      available: gpuTelem.available,
      utilPct: gpuTelem.utilPct,
      vramUsedMB: gpuTelem.vramUsedMB,
      vramTotalMB: gpuTelem.vramTotalMB,
      temperatureC: gpuTelem.temperatureC,
      powerW: gpuTelem.powerW
    },
    cpu: { utilPct: Math.min(100, Math.round(load * 20)), clockGHz: 4.7, threads: cpus.length },
    ram: { usedMB: Math.round(usedMem / 1024 / 1024), totalMB: Math.round(totalMem / 1024 / 1024), pagefileUsedMB: 0 },
    disk: { readMBps: 200 + Math.round(40 * Math.sin(t / 3)), writeMBps: 30 + Math.round(10 * Math.cos(t / 3)) }
  };
}

// Streaming telemetry loop (system stats and indexer updates from worker)
setInterval(() => {
  const sys = systemStatsMock();

  // Broadcast system stats to all WS clients
  const conns = fastify.websocketServer?.clients;
  if (conns) {
    for (const client of conns) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "system_stats", payload: sys }));
      }
    }
  }
}, 1000);

// Initialize GPU telemetry
initGpuTelemetry();

const port = 8787;
await fastify.listen({ port, host: "127.0.0.1" });
fastify.log.info(`Backend listening on http://127.0.0.1:${port}`);
