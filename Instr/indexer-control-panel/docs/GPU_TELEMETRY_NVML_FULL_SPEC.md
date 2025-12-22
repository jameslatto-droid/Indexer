# GPU Telemetry Specification  
## NVIDIA NVML (Windows) — RTX 4080  
**Local Indexer Control Panel**

**Version:** 1.1  
**Status:** Approved design reference  
**Audience:** Backend engineers, system integrators, AI assistants (VS Code / Codex)  
**Applies to:** Windows 10/11, NVIDIA RTX 4080, local-only deployments  

---

## 1. Purpose & Context

This document defines the **authoritative specification** for collecting, processing, and streaming **GPU telemetry** using **NVIDIA NVML** for a local document-indexing system.

The telemetry subsystem exists to:

- Verify **actual GPU utilisation** during indexing
- Detect **GPU starvation** (CPU, disk, or batching issues)
- Correlate indexing throughput with GPU load
- Provide trustworthy, real-time metrics in the localhost dashboard
- Match (within tolerance) Windows Task Manager and `nvidia-smi`

This subsystem is **observational only** and must never affect GPU behaviour.

---

## 2. Non-Goals (Explicit)

The following are **out of scope** and must not be implemented:

- GPU overclocking or underclocking
- Power limit changes
- Fan control
- Per-process GPU accounting
- Multi-GPU orchestration
- CUDA profiling or tracing

---

## 3. Design Principles

1. **Read-Only by Design**  
   NVML is used strictly for querying state.

2. **Isolation**  
   Telemetry must not block:
   - Indexing
   - Filesystem scanning
   - API request handling
   - WebSocket streaming

3. **Predictable Overhead**  
   Telemetry must consume **<10 ms per second** total.

4. **Graceful Failure**  
   Indexing must continue even if:
   - NVML fails to initialise
   - GPU driver resets
   - Metrics intermittently error

5. **Truth Over Guessing**  
   If a metric is unavailable, report it as unavailable — do not fabricate.

---

## 4. Technology Choice: NVML

### Why NVML
- Official NVIDIA API
- Stable across driver versions
- Matches `nvidia-smi`
- Low overhead
- Supported on Windows

---

## 5. Metrics Specification

### 5.1 Mandatory Metrics (MVP)

| Metric | NVML Call | Description |
|------|----------|------------|
| GPU Name | `nvmlDeviceGetName` | Human-readable model |
| GPU Utilisation (%) | `nvmlDeviceGetUtilizationRates` | SM activity |
| VRAM Used (MB) | `nvmlDeviceGetMemoryInfo` | Used device memory |
| VRAM Total (MB) | `nvmlDeviceGetMemoryInfo` | Total device memory |
| GPU Temperature (°C) | `nvmlDeviceGetTemperature` | Core temperature |
| Power Draw (W) | `nvmlDeviceGetPowerUsage` | Instantaneous power |

---

## 6. Sampling Strategy

- Default cadence: **1 sample per second**
- Minimum interval: **500 ms**
- Maximum interval: **5 seconds**

---

## 7. Backend Data Model

```json
{
  "ts": "2025-12-22T10:00:01Z",
  "gpu": {
    "available": true,
    "name": "NVIDIA GeForce RTX 4080",
    "utilPct": 82,
    "vramUsedMB": 7420,
    "vramTotalMB": 16384,
    "temperatureC": 64,
    "powerW": 278
  }
}
```

---

## 8. Error Handling

- NVML init failure → disable telemetry, continue indexing
- Runtime errors → retain last valid sample
- GPU reset → retry initialisation every 10s

---

## 9. Definition of Done

- Metrics match `nvidia-smi` within tolerance
- Dashboard runs 8+ hours without degradation
- GPU under-utilisation clearly visible

---

**END OF DOCUMENT**
