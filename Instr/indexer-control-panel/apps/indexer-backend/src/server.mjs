#!/usr/bin/env node
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

const INDEX_DIR = process.env.INDEX_DIR || "E:/AIIndex";
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
      PYTHON_EXE: venvPython,
      INDEX_DIR
    }
  });
  
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
      STATE.indexer = {
        state: msg.payload.state,
        message: msg.payload.message,
        files: msg.payload.files,
        bytesProcessed: msg.payload.bytesProcessed,
        chunks: msg.payload.chunks,
        index: msg.payload.index,
        throughput: msg.payload.throughput
      };
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

// File system helpers
function listRoots() {
  const roots = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const candidate = `${letter}:/`;
    try {
      if (fs.existsSync(candidate)) roots.push(candidate);
    } catch {}
  }
  if (roots.length === 0) roots.push(path.parse(process.cwd()).root.replaceAll("\\", "/"));
  return roots;
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function normalizePath(p) {
  return (p || "").replaceAll("\\", "/");
}

function getChildren(folderPath) {
  const p = normalizePath(folderPath);
  const entries = fs.readdirSync(p, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).slice(0, 200);
  return dirs.map(d => {
    const childPath = path.join(p, d.name).replaceAll("\\", "/");
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
      meta: { fileCount: undefined, byteSize: undefined }
    };
  });
}

// API Routes
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

fastify.post("/api/index/start", async () => {
  if (STATE.indexer.state !== "idle") {
    return { ok: false, error: "Indexer already running" };
  }
  
  if (!indexerWorker) {
    spawnIndexerWorker();
  }
  if (!indexerWorker) {
    return { ok: false, error: "Failed to spawn indexer worker" };
  }
  
  STATE.indexer = {
    state: "scanning",
    message: "Scanning files…",
    files: { queued: 0, processed: 0, failed: 0 },
    bytesProcessed: 0,
    chunks: { generated: 0, embedded: 0 },
    index: { vectorCount: 0, onDiskBytes: 0, type: STATE.indexConfig.type, compression: STATE.indexConfig.compression },
    throughput: { chunksPerSec: 0, mbPerSec: 0, etaSec: 0 }
  };
  
  if (indexerWorker && indexerWorker.send) {
    indexerWorker.send({ cmd: "start", selection: STATE.selection, config: STATE.indexConfig });
  }
  
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

fastify.get("/api/index/stats", async () => ({ ts: new Date().toISOString(), ...STATE.indexer }));
fastify.get("/api/worker/status", async () => ({ ready: workerReady, pid: workerPid, hasWorker: !!indexerWorker }));

fastify.get("/ws", { websocket: true }, (connection, req) => {
  const send = (msg) => connection.socket.send(JSON.stringify(msg));
  send({ type: "hello", payload: { ok: true, ts: new Date().toISOString() } });
});

const port = 8787;
await fastify.listen({ port, host: "127.0.0.1" });
fastify.log.info(`Indexer Backend listening on http://127.0.0.1:${port}`);
