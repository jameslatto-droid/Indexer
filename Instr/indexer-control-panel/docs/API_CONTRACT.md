# Localhost Indexer Control Panel — API Contract (v1)
**Date:** 2025-12-22  
**Transport:** HTTP (JSON) + WebSocket (JSON messages)  
**Base URL:** http://127.0.0.1:8787

---

## 1. Concepts & Data Models

### 1.1 Selection Rules
Used instead of enumerating every file.

```json
{
  "include": ["E:/Projects", "D:/Archive/Reports"],
  "exclude": ["**/node_modules", "**/.git", "E:/Projects/tmp"]
}
```

### 1.2 Folder Node
Returned for the folder tree. `children` may be omitted unless expanded.

```json
{
  "path": "E:/Projects",
  "name": "Projects",
  "type": "folder",
  "hasChildren": true,
  "selected": "included",   // "included" | "excluded" | "partial" | "none"
  "meta": {
    "fileCount": 12034,
    "byteSize": 9876543210,
    "lastScannedAt": "2025-12-22T10:00:00Z"
  }
}
```

### 1.3 System Stats Snapshot
```json
{
  "ts": "2025-12-22T10:00:01Z",
  "gpu": {
    "name": "NVIDIA GeForce RTX 4080",
    "utilPct": 78,
    "vramUsedMB": 6820,
    "vramTotalMB": 16384,
    "memBwGBps": 560
  },
  "cpu": {
    "utilPct": 34,
    "clockGHz": 4.7,
    "threads": 24
  },
  "ram": {
    "usedMB": 24100,
    "totalMB": 64000,
    "pagefileUsedMB": 1200
  },
  "disk": {
    "readMBps": 220,
    "writeMBps": 40
  }
}
```

### 1.4 Indexer Stats Snapshot
```json
{
  "ts": "2025-12-22T10:00:01Z",
  "state": "embedding", // idle|scanning|chunking|embedding|indexing|paused|error
  "message": "Embedding batch 12/948 (1024 chunks)",
  "files": {
    "queued": 50231,
    "processed": 3012,
    "failed": 2
  },
  "bytesProcessed": 9876543210,
  "chunks": {
    "generated": 154320,
    "embedded": 143200
  },
  "index": {
    "vectorCount": 143200,
    "onDiskBytes": 2147483648,
    "type": "ivf_pq",
    "compression": "pq8"
  },
  "throughput": {
    "chunksPerSec": 420,
    "mbPerSec": 180,
    "etaSec": 7200
  }
}
```

---

## 2. HTTP Endpoints

### 2.1 Filesystem Tree

#### GET `/api/fs/roots`
Returns available drive roots.

**Response 200**
```json
{ "roots": ["C:/", "D:/", "E:/"] }
```

#### GET `/api/fs/children?path=E:/Projects`
Returns immediate children folders of a path.

**Response 200**
```json
{ "nodes": [ /* Folder Node[] */ ] }
```

#### GET `/api/fs/meta?path=E:/Projects`
Returns cached/computed meta for a folder (size, file count). May return `pending:true` if computing.

**Response 200**
```json
{ "path":"E:/Projects", "pending": false, "fileCount": 12034, "byteSize": 9876543210 }
```

---

### 2.2 Selection Rules

#### GET `/api/selection`
**Response 200**
```json
{ "selection": { "include": [], "exclude": [] } }
```

#### POST `/api/selection`
Saves selection rules.

**Body**
```json
{ "selection": { "include": ["E:/Projects"], "exclude": ["**/.git"] } }
```

**Response 200**
```json
{ "ok": true }
```

---

### 2.3 Indexer Control

#### POST `/api/index/start`
Starts a run using current selection + settings.

**Body**
```json
{ "profile": "default" }
```

**Response 200**
```json
{ "ok": true }
```

#### POST `/api/index/pause`
Pauses the current run (must be resumable).

#### POST `/api/index/resume`

#### POST `/api/index/stop`
Stops safely and flushes state.

#### POST `/api/index/rescan`
Triggers filesystem re-scan and refreshes folder meta cache.

---

### 2.4 Settings / Profiles

#### GET `/api/settings`
#### POST `/api/settings`
Suggested settings fields:
- embeddingBatchSize (512–2048)
- chunkProfile (small|balanced|large)
- compression (pq8|pq4)
- nlist, m, nbits (advanced)

---

## 3. WebSocket

### WS `/ws`
Backend pushes live updates once per second (or on change).

**Message types**
- `system_stats`
- `indexer_stats`
- `log`
- `error`

**Example**
```json
{ "type": "system_stats", "payload": { /* System Stats Snapshot */ } }
```

Client should:
- Keep last N points for charts (e.g., 900 points = 15 min @ 1s)

---

## 4. Error Handling
- HTTP errors: JSON body `{ "error": "message", "code": "..." }`
- WS errors: `type: "error"` with payload

---

## 5. Versioning
- Header: `X-API-Version: 1`
- Future changes: additive fields preferred

