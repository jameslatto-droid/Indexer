#!/usr/bin/env node
import Fastify from "fastify";
import cors from "@fastify/cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

const INDEX_DIR = process.env.INDEX_DIR || "E:/AIIndex";
const EMBEDDING_DEVICE = process.env.EMBEDDING_DEVICE || "cpu";

let indexData = null;

function loadLatestIndex() {
  try {
    if (!fs.existsSync(INDEX_DIR)) return null;
    const files = fs.readdirSync(INDEX_DIR).filter(f => f.startsWith("index_") && f.endsWith(".json")).sort().reverse();
    if (!files.length) return null;
    const indexPath = path.join(INDEX_DIR, files[0]);
    const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    console.log(`Loaded index: ${data.embeddings?.length || 0} embeddings`);
    return data;
  } catch (err) {
    console.error("Failed to load index:", err.message);
    return null;
  }
}

indexData = loadLatestIndex();

// --- Search Endpoints ---
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

function keywordScore(text, query) {
  if (!text || !query) return 0;
  const lowerText = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return 0;
  let matches = 0;
  for (const term of terms) {
    if (lowerText.includes(term)) matches++;
  }
  return matches / terms.length;
}

async function getQueryEmbedding(text) {
  if (!text) return null;
  const venvPython = path.join(__dirname, "..", "..", "indexer-backend", "venv-gpu", "Scripts", "python.exe");
  const embeddingScript = path.join(__dirname, "..", "..", "indexer-backend", "src", "embedding-service.py");
  try {
    return new Promise((resolve, reject) => {
      const service = spawn(venvPython, [embeddingScript, '--device', EMBEDDING_DEVICE]);
      let output = '';
      let error = '';
      
      service.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      service.stderr.on('data', (data) => {
        error += data.toString();
      });
      
      service.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Embedding service exited with code ${code}: ${error}`));
          return;
        }
        try {
          const result = JSON.parse(output.trim());
          if (result.embeddings && Array.isArray(result.embeddings) && result.embeddings.length > 0) {
            resolve(result.embeddings[0]);
          } else {
            reject(new Error('Invalid embedding response'));
          }
        } catch (e) {
          reject(new Error(`Failed to parse embedding: ${e.message}`));
        }
      });
      
      service.on('error', reject);
      const request = JSON.stringify({ chunks: [{ filePath: 'query', chunkIndex: 0, text }] });
      service.stdin.write(request + '\n');
      service.stdin.end();
      
      setTimeout(() => {
        service.kill();
        reject(new Error('Embedding service timeout'));
      }, 60000);
    });
  } catch (err) {
    console.error("Failed to get query embedding:", err.message);
    return null;
  }
}

function semanticSearch(queryEmbed, topK, minScore) {
  if (!indexData || !indexData.embeddings || !queryEmbed) return [];
  const scored = indexData.embeddings.map((item) => ({
    ...item,
    chunkId: `chunk_${item.filePath}_${item.chunkIndex}`,
    score: cosineSimilarity(queryEmbed, item.embedding)
  })).filter(x => x.score >= minScore);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function keywordSearch(query, topK, minScore) {
  if (!indexData || !indexData.embeddings) return [];
  const scored = indexData.embeddings.map((item) => ({
    ...item,
    chunkId: `chunk_${item.filePath}_${item.chunkIndex}`,
    score: keywordScore(item.text || "", query)
  })).filter(x => x.score >= minScore);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function hybridSearch(queryEmbed, query, topK, minScore) {
  if (!indexData || !indexData.embeddings) return [];
  const scored = indexData.embeddings.map((item) => {
    const semScore = cosineSimilarity(queryEmbed, item.embedding);
    const kwScore = keywordScore(item.text || "", query);
    return {
      ...item,
      chunkId: `chunk_${item.filePath}_${item.chunkIndex}`,
      score: 0.7 * semScore + 0.3 * kwScore
    };
  }).filter(x => x.score >= minScore);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

fastify.post("/api/search", async (req, reply) => {
  try {
    const body = req.body || {};
    const query = body.query || "";
    const mode = body.mode || "keyword";
    const topK = Math.min(100, Math.max(1, body.topK || 20));
    const minScore = body.filters?.minScore ?? 0.3;

    if (!indexData || !indexData.embeddings || indexData.embeddings.length === 0) {
      return { queryId: `q_${Date.now()}`, chunks: [], error: "No index loaded" };
    }

    let results = [];
    
    if (mode === "semantic") {
      const queryEmbed = await getQueryEmbedding(query);
      results = queryEmbed ? semanticSearch(queryEmbed, topK, minScore) : keywordSearch(query, topK, minScore);
    } else if (mode === "hybrid") {
      const keyResults = keywordSearch(query, topK, minScore);
      const queryEmbed = await getQueryEmbedding(query);
      const semResults = queryEmbed ? semanticSearch(queryEmbed, topK, minScore) : [];
      
      const merged = new Map();
      for (const r of keyResults) {
        merged.set(r.chunkId, { ...r, score: r.score });
      }
      for (const r of semResults) {
        if (merged.has(r.chunkId)) {
          const existing = merged.get(r.chunkId);
          merged.set(r.chunkId, { ...r, score: (existing.score + r.score) / 2 });
        } else {
          merged.set(r.chunkId, r);
        }
      }
      results = Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, topK);
    } else {
      results = keywordSearch(query, topK, minScore);
    }

    const chunks = results.map(r => ({
      chunkId: r.chunkId,
      path: r.filePath,
      title: path.basename(r.filePath),
      section: `Chunk ${r.chunkIndex}`,
      fileType: path.extname(r.filePath).slice(1),
      modifiedAt: new Date().toISOString(),
      score: r.score,
      text: (r.text || "").slice(0, 500),
      highlights: []
    }));

    return { queryId: `q_${Date.now()}`, chunks };
  } catch (err) {
    req.log.error("Search error:", err);
    return reply.code(500).send({ error: "Search failed", details: err.message });
  }
});

// --- Reasoning Endpoints (delegates to reasoning service or local Ollama) ---
fastify.post("/api/reason", async (req, reply) => {
  const body = req.body || {};
  const question = body.question || "What are the key points?";
  const chunkIds = Array.isArray(body.chunkIds) ? body.chunkIds : [];

  if (!indexData || !indexData.embeddings) {
    return reply.code(500).send({ error: "No index loaded" });
  }

  if (chunkIds.length === 0) {
    return {
      answer: "No chunks selected. Please run a search and select relevant chunks first.",
      citations: [],
      notes: ["No chunks provided"]
    };
  }

  const chunks = chunkIds.map(id => {
    const item = indexData.embeddings.find(e => `chunk_${e.filePath}_${e.chunkIndex}` === id);
    if (!item) return null;
    return {
      chunkId: id,
      path: item.filePath,
      section: `Chunk ${item.chunkIndex}`,
      text: item.text || ""
    };
  }).filter(Boolean);

  if (chunks.length === 0) {
    return {
      answer: "Selected chunks not found in index.",
      citations: [],
      notes: ["Chunks not found"]
    };
  }

  try {
    const { Ollama } = await import("ollama");
    const ollama = new Ollama({ host: "http://127.0.0.1:11434" });
    const model = body.model || "llama3.1:8b-instruct-q4_K_M";
    
    const promptText = `Question: ${question}\n\nContext:\n${chunks.map((c, i) => `[${c.chunkId}] ${c.text}`).join("\n\n")}\n\nAnswer (cite chunk IDs):`;
    
    const response = await ollama.generate({
      model,
      prompt: promptText,
      system: "You are a precise assistant. Answer the user's question based ONLY on the provided context chunks. Cite chunk IDs for every claim.",
      stream: false
    });

    const answer = response.response || "(No response from model)";
    const citations = chunks.slice(0, 5).map(c => ({
      chunkId: c.chunkId,
      path: c.path,
      section: c.section,
      quote: c.text.slice(0, 100)
    }));

    return {
      answer,
      citations,
      notes: [`Used ${chunks.length} chunks`, `Model: ${model}`]
    };
  } catch (err) {
    req.log.error("Reasoning error:", err);
    return reply.code(500).send({ error: "Reasoning failed", details: err.message });
  }
});

const port = 8787;
await fastify.listen({ port, host: "127.0.0.1" });
fastify.log.info(`RAG Backend listening on http://127.0.0.1:${port}`);
