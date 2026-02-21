#!/usr/bin/env node
/**
 * Test indexing with minimal files
 * Spawns indexer worker and monitors messages
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'node:url';

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const workerPath = path.join(__dirname, 'Instr/indexer-control-panel/apps/backend/src/indexer-worker.mjs');
const venvPython = path.join(__dirname, 'Instr/indexer-control-panel/apps/backend/venv-gpu/Scripts/python.exe');

const worker = spawn('node', [workerPath], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  env: {
    ...process.env,
    PYTHON_EXE: venvPython,
    INDEX_DIR: 'E:/AIIndex'
  }
});

worker.stdout?.on('data', (data) => {
  process.stdout.write(`[worker stdout] ${data}`);
});

worker.stderr?.on('data', (data) => {
  process.stderr.write(`[worker stderr] ${data}`);
});

const timeout = setTimeout(() => {
  console.log('[test] timeout waiting for response');
  worker.kill();
  process.exit(1);
}, 300000); // 5 minutes

worker.on('message', (msg) => {
  console.log(`[${new Date().toISOString()}] [worker message]`, JSON.stringify(msg).substring(0, 200));
  
  if (msg.type === 'ready') {
    console.log('[test] worker ready, sending start command');
    // Send start command with VERY small selection (just the root repo .md/.txt files)
    worker.send({
      cmd: 'start',
      selection: {
        include: ['E:/Git/Indexing/Instr/indexer-control-panel/'],
        exclude: ['**/node_modules/**', '**/venv/**', '**/.git/**', '**/venv-gpu/**', '**/__pycache__/**', '**/dist/**']
      },
      config: {
        type: 'ivf_pq',
        compression: 'pq8',
        dimension: 384
      }
    });
  }
  
  if (msg.type === 'complete' || msg.type === 'error') {
    clearTimeout(timeout);
    console.log('[test] indexing done or failed');
    worker.kill();
    process.exit(msg.type === 'complete' ? 0 : 1);
  }
});

worker.on('exit', (code) => {
  console.log('[worker exit]', code);
  clearTimeout(timeout);
  process.exit(code || 1);
});

console.log('[test] spawned indexer worker, waiting for ready...');
