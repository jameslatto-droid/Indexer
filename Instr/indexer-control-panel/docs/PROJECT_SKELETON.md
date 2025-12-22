# Localhost Indexer Control Panel — Project Skeleton (React + Node)
**Date:** 2025-12-22  
**Goal:** Modern localhost GUI for folder selection + live dashboard (GPU/CPU/RAM + indexing stats)

---

## 1. Repository Layout

```
indexer-control-panel/
├── apps/
│   ├── frontend/                 # React/Vite UI
│   └── backend/                  # Node API + WebSocket
├── docs/
│   ├── UI_WIREFRAME.md
│   ├── API_CONTRACT.md
│   └── PROJECT_SKELETON.md
├── package.json                  # workspace scripts (optional)
└── README.md
```

This repo ships with a working **mock backend** (stats generator + folder tree browsing) so you can validate the UI immediately, then swap in your real indexer.

---

## 2. Tech Stack

### Frontend
- React + Vite + TypeScript
- TailwindCSS
- Lightweight charting (Chart.js via react-chartjs-2)

### Backend
- Node 20+
- Fastify (HTTP) + @fastify/websocket (WS)
- Windows filesystem access (path-safe)
- Optional NVML hook later (replace mock GPU stats)

---

## 3. Running Locally (Windows)

### Prereqs
- Node.js 20 LTS
- npm (or pnpm)

### Start backend
```
cd apps/backend
npm install
npm run dev
```

Backend: http://127.0.0.1:8787

### Start frontend
```
cd apps/frontend
npm install
npm run dev
```

Frontend: http://127.0.0.1:5173

---

## 4. Integration Points (where your real indexer plugs in)
Backend will evolve from mock → real:

- `/api/index/start` should spawn or signal your real indexing pipeline
- `/ws` should stream real system + indexer stats snapshots
- `/api/fs/meta` should compute true sizes/counts (cached)

**Key rule:** UI never does heavy work; backend owns truth.

---

## 5. Next Hardening Steps (after mock UI is validated)
- Persist selection rules (SQLite or JSON in app data)
- Implement folder meta caching with background worker
- Add structured logging + download logs
- Add “profiles” (different include/exclude sets for different projects)
- Add “Reindex selected” and “Force re-embed changed files”
