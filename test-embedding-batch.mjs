import { spawn } from 'child_process';

const PYTHON_EXE = 'E:\\Git\\Indexing\\Instr\\indexer-control-panel\\apps\\backend\\venv-gpu\\Scripts\\python.exe';
const EMBEDDING_SERVICE = 'E:\\Git\\Indexing\\Instr\\indexer-control-panel\\apps\\backend\\src\\embedding-service.py';

let embeddingService;
let initPromise;

function initEmbeddingService() {
  return new Promise((resolve, reject) => {
    embeddingService = spawn(PYTHON_EXE, [EMBEDDING_SERVICE, '--device', 'cpu']);
    
    let stderrOutput = '';
    let ready = false;

    const stderrListener = (data) => {
      const text = data.toString();
      stderrOutput += text;
      console.log('[service stderr]', text.trim());
      
      try {
        const line = text.trim();
        if (line) {
          const msg = JSON.parse(line);
          if (msg.type === 'loaded') {
            ready = true;
            resolve();
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    };

    const exitHandler = (code, signal) => {
      console.log('[service exit]', code, signal);
      if (!ready) {
        reject(new Error(`Service failed to initialize. stderr: ${stderrOutput}`));
      }
    };

    embeddingService.stderr.on('data', stderrListener);
    embeddingService.on('exit', exitHandler);

    setTimeout(() => {
      if (!ready) {
        reject(new Error('Service init timeout'));
      }
    }, 10000);
  });
}

async function embedChunks(chunks) {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ chunks });
    let response = '';
    let settled = false;

    const onData = (data) => {
      response += data.toString();
      try {
        const result = JSON.parse(response);
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
      } catch (e) {
        // incomplete JSON, wait for more data
      }
    };

    const onEnd = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Embedding service ended before sending response'));
      }
    };

    const cleanup = () => {
      embeddingService.stdout.removeListener('data', onData);
      embeddingService.stdout.removeListener('end', onEnd);
      clearTimeout(timer);
    };

    if (embeddingService?.stdout) {
      embeddingService.stdout.on('data', onData);
      embeddingService.stdout.once('end', onEnd);
    } else {
      reject(new Error('Embedding service stdout not available'));
      return;
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Embedding service timeout'));
      }
    }, 30000);

    console.log('[sending request]', request.substring(0, 100) + '...');
    embeddingService.stdin.write(request + '\n');
  });
}

async function test() {
  try {
    console.log('[init] Starting embedding service...');
    await initEmbeddingService();
    console.log('[init] Service ready!');

    // Test 1: Small batch
    console.log('\n[test1] Embedding 2 chunks...');
    const result1 = await embedChunks([
      { filePath: 'test.txt', chunkIndex: 0, text: 'Hello world' },
      { filePath: 'test.txt', chunkIndex: 1, text: 'This is a test' }
    ]);
    console.log('[test1] Success! Got', result1.count, 'embeddings');

    // Test 2: Another batch
    console.log('\n[test2] Embedding 3 more chunks...');
    const result2 = await embedChunks([
      { filePath: 'test2.txt', chunkIndex: 0, text: 'Another test' },
      { filePath: 'test2.txt', chunkIndex: 1, text: 'More content' },
      { filePath: 'test2.txt', chunkIndex: 2, text: 'Final chunk' }
    ]);
    console.log('[test2] Success! Got', result2.count, 'embeddings');

    console.log('\n[all] All tests passed!');
    process.exit(0);
  } catch (e) {
    console.error('[error]', e.message);
    process.exit(1);
  }
}

test();
