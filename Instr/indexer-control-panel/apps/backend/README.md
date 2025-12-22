# Backend (Mock)
This backend provides:
- Folder tree browsing (`/api/fs/*`)
- Selection rules persistence (`/api/selection`)
- Indexer controls (`/api/index/*`)
- WebSocket streaming at `/ws` (system + indexer stats)

It currently uses mocked GPU metrics and mocked indexing progress.
Replace `systemStatsMock()` and `tickIndexerMock()` with real NVML + indexer integration.
