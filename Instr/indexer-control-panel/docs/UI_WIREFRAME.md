# Localhost Indexer Control Panel — UI Wireframe & UX Spec
**Target:** Windows, local-only, localhost control panel  
**Date:** 2025-12-22  
**Scope:** Folder selection (file-explorer style) + live system/indexing dashboard + controls

---

## 1. Primary Screens

### 1.1 Main App Layout (single-page, split view)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Top Bar:  [App Name]   [Active Profile ▼]   [Settings ⚙]   [Help ?]         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Left Pane (Folder Tree)                    │ Right Pane (Dashboard)          │
│                                            │                                 │
│  Search: [______________]                  │  Status: ● Idle / ● Running     │
│                                            │  Controls: [Start] [Pause] ...  │
│  Drive/Folders Tree                        │                                 │
│  ☐ D:\                                    │  GPU / CPU / RAM Summary        │
│    ☐ D:\Archive                            │  - GPU util, VRAM, mem bw       │
│      ☐ D:\Archive\Reports                 │  - CPU util, clocks             │
│  ☑ E:\                                    │  - RAM used, commit, swap        │
│    ☑ E:\Projects                           │                                 │
│      ☑ E:\Projects\Cancun                 │  Indexing Progress              │
│      ☐ E:\Projects\tmp (excluded)         │  - Files queued/processed        │
│                                            │  - Bytes processed               │
│ Include/Exclude Rules                       │  - Chunks, embeddings            │
│  Include:  E:\Projects                     │  - Index size (on disk)          │
│  Exclude:  **\node_modules                  │                                 │
│            **\.git                          │  Live Charts (scroll)            │
│            E:\Projects\tmp                 │  - Utilization over time         │
└────────────────────────────────────────────┴─────────────────────────────────┘
```

**Design goals**
- Feels like **VS Code Explorer** + **Docker Desktop stats**
- Responsive at 60fps (UI never blocks)
- Live updates via WebSocket (1s tick)

---

## 2. Components

### 2.1 Left Pane — Folder Explorer
**Purpose:** Select/deselect folders with include/exclude semantics without materializing file lists.

**Components**
- **DriveList / Root nodes** (C:\, D:\, E:\, etc.)
- **TreeNode** (checkbox + expand arrow)
- **FolderMeta badges**: `files`, `size`, `last scanned`
- **Search box** (filters tree labels client-side; fetches path lookups server-side if needed)
- **Rules Editor**
  - Include list (absolute paths)
  - Exclude list (glob patterns + absolute paths)
  - Buttons: `Add include`, `Add exclude`, `Remove`, `Clear`

**User interactions**
- Checkbox toggles include/exclude for subtree
- Right-click context menu:
  - Include subtree
  - Exclude subtree
  - Expand all children (one level / all)
  - Open in Explorer (optional)
- Shift-click: range select siblings (optional)

**Selection model (persisted)**
```json
{
  "include": ["E:/Projects", "D:/Archive/Reports"],
  "exclude": ["**/node_modules", "**/.git", "E:/Projects/tmp"]
}
```

---

### 2.2 Right Pane — Dashboard
**Purpose:** Show truth: hardware stats + indexing pipeline stats.

**Top status strip**
- State: Idle | Scanning | Chunking | Embedding | Indexing | Paused | Error
- Current action: e.g. “Embedding batch 12/948 (1024 chunks)”
- Controls: Start / Pause / Resume / Stop / Rescan / Reindex selected

**System tiles**
- GPU Util (%), VRAM (used/total), GPU Mem BW (GB/s)
- CPU Util (%), CPU clock (GHz), Threads active
- RAM used/total, Pagefile usage
- Disk read MB/s, write MB/s (optional)

**Indexer tiles**
- Files queued / processed / failed
- Bytes processed
- Chunks generated
- Embeddings completed
- Vector index size on disk
- Effective throughput: chunks/s, tokens/s (if available)
- ETA

**Charts**
- GPU util over time (last 5–15 min)
- VRAM usage over time
- Files processed per minute
- Throughput (MB/s)

---

## 3. Non-Functional Requirements

### 3.1 Performance
- Tree browsing must be **lazy-loaded**
- Folder size/file count computed asynchronously and cached
- Stats polling/streaming at 1s cadence (configurable)

### 3.2 Reliability
- Backend state persisted:
  - selection rules
  - last scan hashes
  - last index run summary
- Graceful stop: flushes manifest and closes index safely

### 3.3 Security / Privacy
- Localhost only (bind 127.0.0.1)
- No telemetry, no external calls

---

## 4. UX Acceptance Criteria
- You can select 10+ top-level folders in < 30 seconds
- Live dashboard updates without visible lag
- Pause/resume works without losing progress
- Index size and counts are consistent with manifest DB

