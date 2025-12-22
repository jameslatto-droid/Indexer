# Search & Reasoning Frontend — Full Specification Pack (Local RAG with Ollama)
**Target:** Windows • Local-only • localhost control panel • RTX 4080  
**Date:** 2025-12-22  
**Repo:** `indexer-control-panel` (React/Vite frontend + Fastify backend already present)

This document includes:
1. Product spec (UX + workflow)
2. API contract (search + reason + streaming)
3. React component map + recommended folder structure
4. VS Code chatbot master prompt (implementation order)
5. Ollama model & prompt profiles (reasoning + summarise + extract)
6. Advanced reasoning modes (compare, timeline, contradictions, checklist, citations)

---

## 1) Product Spec: Search + Reasoning (RAG) UI

### 1.1 Goals
- **Search-first, reasoning-second** workflow.
- Answers are **grounded** in retrieved chunks only (citations required).
- **Fast** and **local-only**: no external calls.
- Works well for **~1 TB** of standard docs (PDF/DOCX/XLSX/MD/TXT).

### 1.2 Non-goals
- No cloud model routing.
- No training/fine-tuning.
- No per-process GPU accounting (telemetry is system-level).
- No code-centric UX (this corpus is mostly documents).

### 1.3 Key User Journeys

#### Journey A — “Find & answer”
1. User searches: “What are CAPEX assumptions for Cancun Stage 1?”
2. Results show top chunks with similarity + metadata.
3. User selects/deselects chunks (pins best evidence).
4. User clicks **Generate Answer**.
5. LLM produces structured answer with citations.
6. User opens cited chunks for verification.

#### Journey B — “Refine scope”
1. User sets filters: folder = `E:/Projects/Cancun`, filetype = `pdf,xlsx`.
2. Search again → fewer, higher-quality chunks.
3. Answer improves; fewer hallucinations.

#### Journey C — “Investigate contradictions”
1. User runs “Contradictions” mode.
2. System returns a list of conflicting statements with sources.

---

## 2) UI/UX Layout (Localhost Single-Page App)

### 2.1 Navigation
Add a new top-level route in the frontend:
- `/search` — Search + evidence + reasoning
- `/dashboard` (existing) — system/indexer dashboard
- `/settings` — model/prompt presets, retrieval defaults

### 2.2 Screen Layout (3-pane)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Top bar:  [Search] [Dashboard] [Settings]   Status: ● Ready  Model: llama3.2 │
├──────────────────────────────────────────────────────────────────────────────┤
│ Left (Filters)              │ Middle (Answer + Chat)        │ Right (Sources) │
│ - Folder scope              │ - Question input              │ - Cited docs     │
│ - File types                │ - Answer (streaming)          │ - Selected chunks│
│ - Date range                │ - Follow-ups                  │ - Chunk viewer   │
│ - Tags                      │ - Actions (save/export)       │ - Similarity     │
└─────────────────────────────┴───────────────────────────────┴────────────────┘
```

### 2.3 Core Controls
- Search query box (Enter runs search)
- Mode toggle: `Semantic | Keyword | Hybrid`
- `TopK` selector (e.g., 10/20/50)
- `Min score` slider (e.g., 0.65–0.90)
- Chunk selection controls:
  - Select all / none
  - Pin/Unpin (pins are always used in reasoning)
- Reasoning controls:
  - Generate Answer
  - Summarise sources
  - Extract facts/table
  - Compare alternatives
  - Find contradictions

### 2.4 Trust UX
Every answer must display:
- **Citations** (file path + section + chunk id)
- **Evidence viewer** panel that highlights quoted spans
- “Insufficient evidence” outcome when retrieval is weak

---

## 3) Retrieval + RAG Behavior (Backend Responsibilities)

### 3.1 Retrieval pipeline (hybrid)
Default behavior:
- Semantic retrieval: vector search (FAISS/Qdrant/etc.)
- Optional keyword retrieval: lightweight BM25/regex index (phase 2)
- Merge & rerank:
  - Deduplicate by file/section
  - Prefer diversity across docs
  - Prefer pinned chunks
- Return chunk list with metadata

### 3.2 Chunk schema (canonical)
```json
{
  "chunkId": "sha256(path)::offset::len",
  "path": "E:/Projects/Cancun/PPP/Stage1.pdf",
  "title": "Stage 1 Technical Report",
  "section": "3.2 CAPEX Assumptions",
  "fileType": "pdf",
  "modifiedAt": "2025-11-30T12:00:00Z",
  "score": 0.87,
  "text": "…",
  "highlights": ["CAPEX", "USD 145M"]
}
```

### 3.3 Prompt construction (strict RAG)
- LLM can use **ONLY** provided chunks.
- If evidence insufficient → say so + suggest better filters/query.
- Return citations in machine-readable form.

---

## 4) API Contract (Search + Reason + Streaming)

**Base:** `http://127.0.0.1:8787`

### 4.1 POST `/api/search`
Search returns candidate chunks.

**Request**
```json
{
  "query": "CAPEX assumptions Cancun",
  "mode": "hybrid",
  "filters": {
    "folders": ["E:/Projects/Cancun"],
    "fileTypes": ["pdf", "xlsx"],
    "dateFrom": "2025-01-01",
    "dateTo": "2025-12-31",
    "tags": ["PPP", "CAPEX"],
    "minScore": 0.75
  },
  "topK": 20
}
```

**Response**
```json
{
  "queryId": "q_20251222_001",
  "chunks": [ /* Chunk[] */ ]
}
```

### 4.2 POST `/api/reason`
Runs grounded reasoning over selected chunks.

**Request**
```json
{
  "question": "What are the CAPEX assumptions?",
  "chunkIds": ["..."],
  "profile": "answer_strict",
  "model": "llama3.2:latest",
  "stream": true
}
```

**Response (non-stream)**
```json
{
  "answer": "…",
  "citations": [
    { "chunkId": "...", "path": "...", "section": "...", "quote": "…" }
  ],
  "notes": ["…"]
}
```

### 4.3 WebSocket `/ws_reason`
Streaming tokens + citations

**Client → server**
```json
{
  "type": "reason_start",
  "payload": { "question": "...", "chunkIds": ["..."], "profile": "answer_strict", "model": "llama3.2:latest" }
}
```

**Server → client message types**
- `reason_token` — incremental text
- `reason_citation` — as soon as identified
- `reason_done` — final + structured output
- `reason_error`

---

## 5) Ollama Integration (Backend)

### 5.1 Requirements
- Ollama runs locally (GPU-enabled).
- Backend is the only component calling Ollama.
- Support both:
  - Non-stream HTTP response
  - Streaming response (preferred)

### 5.2 Model recommendations (local, RTX 4080)
**Reasoning / Q&A**
- `llama3.2:latest` (general)
- `qwen2.5:latest` (strong reasoning; optional)
- `mistral:latest` (fast; optional)

**Optional summarisation**
- same model as reasoning (keep simple)

**Embeddings**
- Use the embedding model already used for indexing to avoid mismatch.

### 5.3 Model selection rules (v1)
- Default to a single reasoning model to reduce variance.
- Expose model dropdown in Settings.
- Record model name/version in every answer.

---

## 6) Prompt Profiles (Strict, Repo-Storable)

Store prompt profiles in backend as JSON or YAML. Example:

### 6.1 `answer_strict`
**Goal:** grounded answer, short, cited.

**System**
- You may ONLY use provided sources.
- If insufficient, say “Insufficient evidence” and list missing info.
- Provide citations as `[C1] [C2]` where C# maps to chunkIds.

**Output**
- Answer
- Key assumptions
- Risks/uncertainties
- Citations

### 6.2 `summary_strict`
- Produce structured summary + citations.
- No new facts.

### 6.3 `extract_table`
- Extract entities into a JSON table schema (backend converts to UI table):
  - `field`, `value`, `unit`, `sourceChunkId`

### 6.4 `compare_options`
- Compare Option A vs B from sources.
- Output: decision matrix + pros/cons + cited evidence.

### 6.5 `contradictions`
- Identify conflicting statements and show both sides with citations.
- If none found, say so.

---

## 7) React Component Map + Folder Structure

### 7.1 Recommended frontend folder structure
```
apps/frontend/src/
├── ui/
│   ├── App.tsx
│   ├── routes/
│   │   ├── DashboardRoute.tsx
│   │   ├── SearchRoute.tsx
│   │   └── SettingsRoute.tsx
│   ├── search/
│   │   ├── SearchBar.tsx
│   │   ├── SearchFilters.tsx
│   │   ├── ResultsList.tsx
│   │   ├── ChunkCard.tsx
│   │   ├── ChunkViewer.tsx
│   │   ├── EvidencePane.tsx
│   │   ├── ReasoningPane.tsx
│   │   ├── Followups.tsx
│   │   └── ExportPanel.tsx
│   ├── common/
│   │   ├── SplitPane.tsx
│   │   ├── Badge.tsx
│   │   ├── Button.tsx
│   │   └── Toast.tsx
│   └── state/
│       ├── api.ts
│       ├── ws.ts
│       ├── searchStore.ts
│       └── settingsStore.ts
```

### 7.2 Component responsibilities (brief)
- `SearchRoute`: orchestrates query → results → selected chunks → reasoning
- `SearchFilters`: folder scope, file types, date range, min score, topK
- `ResultsList`: list of chunks with select/pin, score, snippet
- `ChunkViewer`: show full chunk text + highlights
- `ReasoningPane`: question, profiles, Generate, streaming output
- `EvidencePane`: cited docs/chunks + click to view + copy citation

---

## 8) Backend Implementation Plan (Search + Reason)

### 8.1 New backend modules (recommended)
```
apps/backend/src/
├── server.mjs
├── rag/
│   ├── search.mjs          # /api/search
│   ├── reason.mjs          # /api/reason + ws_reason
│   ├── promptProfiles.mjs  # prompt templates + output schemas
│   ├── citations.mjs       # normalize citations
│   └── ollamaClient.mjs    # local ollama calls (stream + non-stream)
└── index/
    └── vectorStore.mjs     # adapter for FAISS/Qdrant/whatever you use
```

### 8.2 Minimum viable backend behavior (v1)
- `/api/search` returns chunks from a stubbed vector store adapter (until integrated)
- `/api/reason` calls Ollama with strict prompt and returns structured output
- WS streaming for reasoning tokens

---

## 9) VS Code Chatbot Master Prompt (Implement in Order)

Copy/paste this into VS Code chatbot:

### 9.1 Master Prompt
You are implementing the “Search & Reasoning” feature for a localhost indexer control panel.

**Repo facts**
- Frontend: React/Vite in `apps/frontend`
- Backend: Fastify in `apps/backend`
- Existing dashboard + folder selection already exist
- We need a new `/search` route and backend endpoints `/api/search` and `/api/reason`
- Must be local-only, Windows-first, and use Ollama locally

**Rules**
- Implement backend endpoints first with mocks where necessary
- Then wire frontend route and components
- Do not refactor unrelated code
- Keep UI responsive (no blocking)
- All answers must be grounded: citations required

**Implement in this exact order**
1. Frontend routing: add `/search` route shell, nav links, placeholder panes
2. Backend: add `/api/search` returning mocked chunks (hardcoded array)
3. Frontend: implement search bar + results list + select/pin behavior using mocked `/api/search`
4. Backend: add `/api/reason` that returns mocked answer + citations
5. Frontend: implement reasoning pane showing answer + clickable citations
6. Backend: integrate Ollama client (non-stream first) and swap `/api/reason` to real Ollama calls
7. Add streaming reasoning via `ws_reason` and update UI to stream tokens
8. Replace mocked `/api/search` with real vector store adapter integration (FAISS/Qdrant)
9. Add filters (folder, file types, minScore, topK) end-to-end
10. Add prompt profiles and Settings page to select profile/model

**Acceptance checks after each step**
- Frontend loads with no console errors
- Buttons do what they say
- `/api/search` returns deterministic JSON
- `/api/reason` returns citations that match selected chunks
- Ollama calls succeed locally; failures show friendly errors

---

## 10) Advanced Reasoning Modes (v2 Feature Set)

### 10.1 Compare Options
Input: “Compare incineration vs anaerobic digestion for Part B”  
Output:
- Decision matrix (CAPEX/OPEX/complexity/permitting/risk)
- Pros/cons
- Recommendation (if evidence supports)
- Citations for each claim

### 10.2 Timeline Builder
Input: “Create a timeline of PPP milestones from Stage 1 docs”  
Output:
- Ordered list with dates
- “Unknown date” entries allowed
- Citations

### 10.3 Contradictions Finder
Input: “Find contradictions in sludge disposal strategy”  
Output:
- Statement A + source
- Statement B + source
- Possible explanation (optional, labeled as inference)

### 10.4 Extraction to Structured Table
Input: “Extract all CAPEX line items and amounts”  
Output JSON schema:
```json
{
  "rows": [
    { "item": "Screens", "amount": 1230000, "currency": "USD", "sourceChunkId": "..." }
  ]
}
```

### 10.5 Evidence Pack Export
- Export answer + citations + selected chunks to Markdown
- Optionally include an appendix with chunk texts

---

## 11) Definition of Done (Search + Reasoning)
- User can search and see chunk results with scores + metadata
- User can select/pin chunks and generate a grounded answer
- Answer includes citations and source viewer works
- Ollama runs locally and responses stream smoothly
- Filters reduce scope and improve quality
- System never calls external services

---

**END**
