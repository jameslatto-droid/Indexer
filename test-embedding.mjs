import { spawn } from 'child_process';
import path from 'path';

const PYTHON_EXE = 'E:\\Git\\Indexing\\Instr\\indexer-control-panel\\apps\\backend\\venv-gpu\\Scripts\\python.exe';
const EMBEDDING_SERVICE = 'E:\\Git\\Indexing\\Instr\\indexer-control-panel\\apps\\backend\\src\\embedding-service.py';

const embeddingService = spawn(PYTHON_EXE, [EMBEDDING_SERVICE]);

let stderrOutput = '';
let stdoutOutput = '';

embeddingService.stdout.on('data', (data) => {
  const text = data.toString();
  stdoutOutput += text;
  console.log('[stdout]', text.trim());
});

embeddingService.stderr.on('data', (data) => {
  const text = data.toString();
  stderrOutput += text;
  console.log('[stderr]', text.trim());
});

embeddingService.on('error', (err) => {
  console.error('[process error]', err.message);
});

embeddingService.on('exit', (code, signal) => {
  console.log('[process exit]', code, signal);
  console.log('[final stdout]', stdoutOutput);
  console.log('[final stderr]', stderrOutput);
});

// Wait 2 seconds then send a test request
setTimeout(() => {
  const testRequest = JSON.stringify({
    chunks: [
      { filePath: 'test.txt', chunkIndex: 0, text: 'Hello world' },
      { filePath: 'test.txt', chunkIndex: 1, text: 'This is a test' }
    ]
  });
  
  console.log('[sending]', testRequest);
  embeddingService.stdin.write(testRequest + '\n');
}, 2000);

// Timeout after 15 seconds
setTimeout(() => {
  console.log('[timeout] killing process');
  embeddingService.kill();
  process.exit(1);
}, 15000);
