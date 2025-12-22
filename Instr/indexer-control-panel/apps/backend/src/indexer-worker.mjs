#!/usr/bin/env node
/**
 * Indexer Worker Process with GPU Embedding Pipeline
 * 
 * Spawned by server.mjs as a child process.
 * Receives control messages via IPC: {cmd: 'start|pause|resume|stop', selection: {...}}
 * Sends progress updates via IPC: {type: 'stats|error|complete', payload: {...}}
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const PYTHON_EXE = process.env.PYTHON_EXE || 'python';
const EMBEDDING_DEVICE = process.env.EMBEDDING_DEVICE || 'cuda';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Allow overriding the index storage location via env var (e.g. INDEX_DIR=E:\\AIIndex)
// Default to E:\AIIndex to match root dev scripts when env var is missing
const INDEX_DIR = process.env.INDEX_DIR || 'E:/AIIndex';

const STATE = {
  running: false,
  paused: false,
  filesQueued: 0,
  filesProcessed: 0,
  filesFailed: 0,
  bytesProcessed: 0,
  chunksGenerated: 0,
  chunksEmbedded: 0,
  embeddingsPending: 0,
  startTime: null,
  pauseTime: null,
  indexConfig: { type: 'ivf_pq', compression: 'pq8', dimension: 384 },
  indexPath: null,
  onDiskBytes: 0
};

let embeddingsStore = []; // Store all embeddings [{filePath, chunkIndex, embedding: [...]}, ...]

let embeddingService = null;
let embeddingEnabled = false;
let embeddingBuffer = []; // Buffer chunks for batch processing [{filePath, chunkIndex, text}, ...]
const BATCH_SIZE = 10; // Process 10 chunks at a time through GPU

/**
 * Save index to disk using Python FAISS
 */
async function saveIndexToDisk() {
  if (embeddingsStore.length === 0) {
    process.send?.({ type: 'log', message: 'No embeddings to save' });
    return;
  }

  try {
    // Ensure index directory exists
    await fs.promises.mkdir(INDEX_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const indexName = `index_${timestamp}`;
    STATE.indexPath = path.join(INDEX_DIR, indexName);

    // Write embeddings to JSON file for Python to load
    const dataPath = path.join(INDEX_DIR, `${indexName}.json`);
    await fs.promises.writeFile(
      dataPath,
      JSON.stringify({ embeddings: embeddingsStore, config: STATE.indexConfig }, null, 2)
    );

    process.send?.({ type: 'log', message: `Index saved to ${STATE.indexPath}` });
    
    // Calculate on-disk size
    const stat = await fs.promises.stat(dataPath);
    STATE.onDiskBytes = stat.size;
    
  } catch (error) {
    process.send?.({ type: 'error', message: `Failed to save index: ${error.message}` });
  }
}

function deriveRoots(includeRules) {
  const rules = Array.isArray(includeRules) ? includeRules : [];
  if (rules.length === 0) return ['C:/'];
  const roots = new Set();
  for (let r of rules) {
    let norm = (r || '').replaceAll('\\', '/');
    const starIdx = norm.indexOf('*');
    if (starIdx >= 0) {
      norm = norm.substring(0, starIdx);
    }
    norm = norm.replace(/\/+$/, '');
    if (!norm.endsWith('/')) norm += '/';
    roots.add(norm);
  }
  return Array.from(roots);
}

/**
 * Initialize GPU embedding service (Python process)
 */
function initEmbeddingService() {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'embedding-service.py');
    
    // Try CUDA first, will fallback to CPU in Python
    embeddingService = spawn(PYTHON_EXE, [pythonScript, '--model', 'all-MiniLM-L6-v2', '--device', EMBEDDING_DEVICE], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Avoid MaxListeners warnings when we attach per-request listeners
    if (embeddingService.stdout) embeddingService.stdout.setMaxListeners(0);
    if (embeddingService.stderr) embeddingService.stderr.setMaxListeners(0);
    
    let loadedReceived = false;
    let stderrOutput = '';
    let timeout = setTimeout(() => {
      if (!loadedReceived) {
        console.error('[embedding service] timeout waiting for "loaded" after 120 seconds');
        embeddingService?.kill();
        reject(new Error('Embedding service startup timeout'));
      }
    }, 120000); // 2 minutes for model loading
    
    embeddingService.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      stderrOutput += msg + '\n';
      if (msg) console.log('[embedding service stderr]', msg);
      if (msg.includes('loaded')) {
        clearTimeout(timeout);
        loadedReceived = true;
        embeddingEnabled = true;
        resolve();
      }
    });
    
    embeddingService.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    embeddingService.on('exit', (code) => {
      clearTimeout(timeout);
      if (!loadedReceived) {
        console.error('[embedding service] exited with code', code, 'stderr:', stderrOutput);
        reject(new Error(`Embedding service failed to start (exit code ${code}). stderr: ${stderrOutput}`));
      }
    });
  });
}

/**
 * Send chunk batch for GPU embedding
 */
function embedChunks(chunks) {
  return new Promise((resolve, reject) => {
    if (!embeddingService) {
      reject(new Error('Embedding service not initialized'));
      return;
    }

    // Send only text to the Python service; keep metadata locally for mapping back
    const request = JSON.stringify({ chunks: chunks.map(c => c.text) });
    let buf = '';
    let settled = false;

    const cleanup = () => {
      if (embeddingService?.stdout) {
        embeddingService.stdout.off('data', onData);
        embeddingService.stdout.off('error', onError);
        embeddingService.stdout.off('end', onEnd);
      }
    };

    const tryParse = () => {
      const idx = buf.indexOf('\n');
      if (idx === -1) return false;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1); // keep any remainder for future messages
      if (!line) return false;
      try {
        const response = JSON.parse(line);
        settled = true;
        cleanup();
        if (response.error) {
          console.error('[embedChunks] Python service error:', response.error, response.traceback ? '\n' + response.traceback : '');
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      } catch (err) {
        // If parsing fails, assume the line might be incomplete; re-queue and wait for more data
        if (err instanceof SyntaxError && !settled) {
          buf = `${line}\n${buf}`;
          return false;
        }
        settled = true;
        cleanup();
        reject(err);
      }
      return true;
    };

    const onData = (data) => {
      buf += data.toString();
      tryParse();
    };

    const onEnd = () => {
      if (!settled) {
        // Last chance parse on stream end
        tryParse();
        if (!settled) {
          cleanup();
          reject(new Error('Embedding service ended before sending response'));
        }
      }
    };

    const onError = (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    if (embeddingService?.stdout) {
      embeddingService.stdout.on('data', onData);
      embeddingService.stdout.once('end', onEnd);
      embeddingService.stdout.once('error', onError);
    } else {
      reject(new Error('Embedding service stdout not available'));
      return;
    }
    // Failsafe: if no response in 30s, reject to avoid hanging
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Embedding service timeout'));
      }
    }, 30000);

    const clearTimer = () => clearTimeout(timer);
    embeddingService.stdout.once('end', clearTimer);
    embeddingService.stdout.once('error', clearTimer);
    embeddingService.stdin.write(request + '\n');
  });
}

/**
 * Process pending embeddings asynchronously
 */
async function processPendingEmbeddings() {
  if (embeddingBuffer.length === 0) return;
  if (!embeddingEnabled) {
    // If embeddings disabled, drain buffer without processing
    embeddingBuffer.splice(0, embeddingBuffer.length);
    STATE.embeddingsPending = 0;
    return;
  }
  
  try {
    const batch = embeddingBuffer.splice(0, BATCH_SIZE);
    const result = await embedChunks(batch);
    // Persist embeddings alongside their source metadata for later saveIndexToDisk
    if (Array.isArray(result.embeddings)) {
      for (let i = 0; i < result.embeddings.length; i++) {
        const chunk = batch[i];
        const embedding = result.embeddings[i];
        if (!chunk || !embedding) continue;
        embeddingsStore.push({
          filePath: chunk.filePath,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          embedding
        });
      }
    }
    STATE.chunksEmbedded += result.count;
    STATE.embeddingsPending = Math.max(0, STATE.embeddingsPending - result.count);
    sendUpdate();
  } catch (e) {
    console.error('Embedding error:', e.message, e.stack);
    // Don't fail entire indexing on embedding errors
  }
}


/**
 * Recursively collect files matching selection rules
 */
async function* collectFiles(folderPath, maxDepth = 10, depth = 0, selection = { include: [], exclude: [] }) {
  if (depth > maxDepth) return;
  
  // Check if folder matches exclude rules
  for (const rule of selection.exclude) {
    if (matchesGlob(folderPath, rule)) {
      return;
    }
  }
  
  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);
      
      // Check if file/folder matches selection rules
      const matches = selection.include.length === 0 || selection.include.some(rule => matchesGlob(fullPath, rule));
      const excluded = selection.exclude.some(rule => matchesGlob(fullPath, rule));
      
      if (!matches || excluded) continue;
      
      if (entry.isFile()) {
        // Only index certain file types
        const ext = path.extname(fullPath).toLowerCase();
        if (['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.js', '.ts', '.tsx', '.jsx', '.css', '.mjs', '.py', '.html'].includes(ext)) {
          yield fullPath;
        }
      } else if (entry.isDirectory()) {
        // Recurse into subdirectories
        yield* collectFiles(fullPath, maxDepth, depth + 1, selection);
      }
    }
  } catch (e) {
    // Silently skip inaccessible directories
  }
}

/**
 * Simple glob pattern matching (basic implementation)
 */
function matchesGlob(filePath, pattern) {
  const normalized = filePath.replaceAll('\\', '/');
  const normPattern = pattern.replaceAll('\\', '/');
  const hasWildcard = /\*/.test(normPattern);
  
  // If no wildcard, treat as prefix directory match
  if (!hasWildcard) {
    let base = normPattern;
    if (!base.endsWith('/')) base += '/';
    return normalized.toLowerCase().startsWith(base.toLowerCase());
  }
  
  // Support ** for recursive wildcards
  if (normPattern.includes('**')) {
    const parts = normPattern.split('**/');
    let current = normalized;
    for (const part of parts) {
      if (!part) continue;
      const idx = current.indexOf(part.replace(/\*/g, ''));
      if (idx === -1) return false;
      current = current.substring(idx);
    }
    return true;
  }
  
  // Support * for single-level wildcards
  const regex = new RegExp('^' + normPattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
  return regex.test(normalized);
}

/**
 * Process file: extract text chunks and queue for GPU embedding
 */
async function processFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    let text = '';
    
    // Extract text based on file type
    if (['.txt', '.md', '.mjs', '.js', '.py', '.json', '.yaml', '.yml', '.csv', '.html', '.css', '.tsx', '.ts', '.jsx'].includes(ext)) {
      try {
        text = await fs.promises.readFile(filePath, 'utf-8');
      } catch (e) {
        console.warn(`Could not read file as text: ${filePath}`, e.message);
        text = '';
      }
    }
    
    if (!text || text.trim().length === 0) {
      STATE.filesProcessed++;
      STATE.bytesProcessed += stat.size;
      return { success: true, chunks: 0 };
    }
    
    // Split into chunks (roughly 500 chars per chunk with overlap)
    const CHUNK_SIZE = 500;
    const CHUNK_OVERLAP = 100;
    const chunks = [];
    
    for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      const end = Math.min(i + CHUNK_SIZE, text.length);
      const chunk = text.substring(i, end).trim();
      if (chunk.length > 50) { // Only keep meaningful chunks
        chunks.push(chunk);
      }
      if (end >= text.length) break;
    }
    
    STATE.filesProcessed++;
    STATE.bytesProcessed += stat.size;
    STATE.chunksGenerated += chunks.length;
    
    // Queue chunks for GPU embedding with metadata
    for (let i = 0; i < chunks.length; i++) {
      embeddingBuffer.push({
        filePath: filePath,
        chunkIndex: i,
        text: chunks[i]
      });
    }
    
    STATE.embeddingsPending += chunks.length;
    
    // Process pending embeddings if buffer is full
    if (embeddingBuffer.length >= BATCH_SIZE) {
      await processPendingEmbeddings();
    }
    
    return { success: true, chunks: chunks.length };
  } catch (e) {
    STATE.filesFailed++;
    return { success: false, error: e.message };
  }
}

/**
 * Send progress update to parent process
 */
function sendUpdate() {
  if (!process.send) return;
  
  const elapsed = STATE.startTime ? Date.now() - STATE.startTime : 0;
  const throughput = elapsed > 0 ? STATE.filesProcessed / (elapsed / 1000) : 0;
  const remaining = Math.max(0, STATE.filesQueued - STATE.filesProcessed);
  const etaSec = throughput > 0 ? Math.round(remaining / throughput) : 0;
  
  process.send({
    type: 'stats',
    payload: {
      state: STATE.paused ? 'paused' : (STATE.running ? 'embedding' : 'idle'),
      message: STATE.running ? `Processing ${STATE.filesProcessed}/${STATE.filesQueued} files` : 'Idle',
      files: {
        queued: STATE.filesQueued,
        processed: STATE.filesProcessed,
        failed: STATE.filesFailed
      },
      bytesProcessed: STATE.bytesProcessed,
      chunks: {
        generated: STATE.chunksGenerated,
        embedded: STATE.chunksEmbedded
      },
      embeddingsPending: STATE.embeddingsPending,
      index: {
        vectorCount: STATE.chunksEmbedded,
        onDiskBytes: STATE.onDiskBytes,
        indexPath: STATE.indexPath,
        type: STATE.indexConfig.type,
        compression: STATE.indexConfig.compression
      },
      throughput: {
        chunksPerSec: Math.round((STATE.chunksGenerated / (elapsed / 1000)) || 0),
        mbPerSec: Math.round((STATE.bytesProcessed / 1024 / 1024) / (elapsed / 1000) || 0),
        etaSec
      }
    }
  });
}

/**
 * Main indexing loop with GPU embedding pipeline
 */
async function runIndexing(selection, config) {
  STATE.running = true;
  STATE.startTime = Date.now();
  if (config) {
    STATE.indexConfig = config;
  }
  
  try {
    // Initialize GPU embedding service
    try {
      await initEmbeddingService();
      process.send?.({ type: 'log', message: 'GPU embedding service initialized' });
    } catch (e) {
      process.send?.({ type: 'warning', message: `Embedding service failed: ${e.message}. Continuing without GPU embeddings.` });
    }
    
    // First, collect all files from selection roots (Windows-safe)
    const roots = deriveRoots(selection?.include);
    const filePaths = [];
    for (const root of roots) {
      for await (const filePath of collectFiles(root, 10, 0, selection)) {
        filePaths.push(filePath);
        if (filePaths.length % 100 === 0) {
          // Yield occasionally to allow pause/stop checks
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    }
    
    STATE.filesQueued = filePaths.length;
    sendUpdate();
    
    // Then process files
    for (const filePath of filePaths) {
      // Check for pause/stop signals
      while (STATE.paused && STATE.running) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (!STATE.running) break;
      
      const before = STATE.filesProcessed + STATE.filesFailed;
      const res = await processFile(filePath);
      const after = STATE.filesProcessed + STATE.filesFailed;
      
      // Send update on first file and every 10 files thereafter
      if (after === 1 || after % 50 === 0 || (res && !res.success)) {
        sendUpdate();
      }
    }
    
    // Process any remaining embeddings in buffer
    while (embeddingBuffer.length > 0) {
      await processPendingEmbeddings();
    }
    
    // Save index to disk
    if (embeddingsStore.length > 0) {
      await saveIndexToDisk();
    }
    
    // Clean up embedding service
    if (embeddingService) {
      embeddingService.stdin.end();
      embeddingService.kill();
      embeddingService = null;
    }
    
    if (STATE.running) {
      STATE.running = false;
      process.send?.({
        type: 'complete',
        payload: {
          filesProcessed: STATE.filesProcessed,
          filesFailed: STATE.filesFailed,
          chunksEmbedded: STATE.chunksEmbedded,
          bytesProcessed: STATE.bytesProcessed,
          durationSec: Math.round((Date.now() - STATE.startTime) / 1000)
        }
      });
    }
  } catch (e) {
    // Clean up on error
    if (embeddingService) {
      embeddingService.kill();
      embeddingService = null;
    }
    process.send?.({ type: 'error', payload: { message: e.message } });
    STATE.running = false;
  }
  
  sendUpdate();
}

/**
 * Handle IPC messages from parent
 */
process.on('message', async (msg) => {
  const { cmd, selection, config } = msg;
  
  if (cmd === 'start') {
    if (!STATE.running) {
      STATE.filesProcessed = 0;
      STATE.filesFailed = 0;
      STATE.bytesProcessed = 0;
      STATE.chunksGenerated = 0;
      STATE.chunksEmbedded = 0;
      STATE.paused = false;
      await runIndexing(selection, config);
    }
  } else if (cmd === 'pause') {
    STATE.paused = true;
    STATE.pauseTime = Date.now();
    sendUpdate();
  } else if (cmd === 'resume') {
    STATE.paused = false;
    sendUpdate();
  } else if (cmd === 'stop') {
    STATE.running = false;
    STATE.paused = false;
    process.send?.({ type: 'stopped' });
  }
});

// Signal readiness
process.send?.({ type: 'ready' });
