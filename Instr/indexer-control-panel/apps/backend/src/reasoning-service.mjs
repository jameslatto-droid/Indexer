#!/usr/bin/env node
/**
 * Reasoning Service - Ollama-based RAG server
 * Provides reasoning and answer generation endpoints
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { Ollama } from "ollama";

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

const ollama = new Ollama({ host: "http://127.0.0.1:11434" });
const DEFAULT_MODEL = "llama3.1:8b-instruct-q4_K_M";

const PROMPT_PROFILES = {
  answer_strict: {
    system: "You are a precise assistant. Answer the user's question based ONLY on the provided context chunks. Cite chunk IDs for every claim. If the context doesn't contain the answer, say 'Insufficient evidence.'",
    template: (question, chunks) => `Question: ${question}\n\nContext:\n${chunks.map((c, i) => `[${c.chunkId}] ${c.text}`).join("\n\n")}\n\nAnswer (cite chunk IDs):`
  },
  summarize: {
    system: "You are a summarization assistant. Provide a concise summary of the given context.",
    template: (question, chunks) => `Summarize the following content:\n\n${chunks.map(c => c.text).join("\n\n")}`
  },
  expand_query: {
    system: "You are a query expansion assistant. Generate 3-5 related search queries based on the original query.",
    template: (query) => `Original query: "${query}"\n\nGenerate 3-5 related search queries that would help find relevant information:`
  }
};

// Health check
fastify.get("/health", async () => ({ ok: true, service: "reasoning", timestamp: new Date().toISOString() }));

// List available models
fastify.get("/models", async () => {
  try {
    const models = await ollama.list();
    return { models: models.models || [] };
  } catch (err) {
    return { error: "Failed to list models", details: err.message };
  }
});

// Query expansion endpoint
fastify.post("/expand-query", async (req, reply) => {
  const body = req.body || {};
  const query = body.query || "";
  const model = body.model || DEFAULT_MODEL;
  
  if (!query) {
    return reply.code(400).send({ error: "Query is required" });
  }

  try {
    const promptConfig = PROMPT_PROFILES.expand_query;
    const prompt = promptConfig.template(query);
    
    const response = await ollama.generate({
      model,
      prompt,
      system: promptConfig.system,
      stream: false
    });

    const expanded = response.response || "";
    const queries = expanded.split('\n').filter(line => line.trim().length > 0).slice(0, 5);
    
    return { 
      original: query, 
      expanded: queries,
      raw: expanded
    };
  } catch (err) {
    req.log.error("Query expansion error:", err);
    return reply.code(500).send({ error: "Query expansion failed", details: err.message });
  }
});

// Reasoning endpoint (non-streaming)
fastify.post("/reason", async (req, reply) => {
  const body = req.body || {};
  const question = body.question || "What are the key points?";
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  const profile = body.profile || "answer_strict";
  const model = body.model || DEFAULT_MODEL;

  if (chunks.length === 0) {
    return {
      answer: "No chunks provided. Please provide context chunks.",
      citations: [],
      notes: ["No chunks provided"]
    };
  }

  // Build prompt
  const promptConfig = PROMPT_PROFILES[profile] || PROMPT_PROFILES.answer_strict;
  const prompt = promptConfig.template(question, chunks);

  try {
    const response = await ollama.generate({
      model,
      prompt,
      system: promptConfig.system,
      stream: false
    });

    const answer = response.response || "(No response from model)";
    const citations = chunks.slice(0, 5).map(c => ({
      chunkId: c.chunkId,
      path: c.path || c.filePath,
      section: c.section || `Chunk ${c.chunkIndex || 0}`,
      quote: (c.text || "").slice(0, 100)
    }));

    return {
      answer,
      citations,
      notes: [`Used ${chunks.length} chunks`, `Model: ${model}`, `Profile: ${profile}`]
    };
  } catch (err) {
    req.log.error("Ollama error:", err);
    return reply.code(500).send({ error: "Ollama request failed", details: err.message });
  }
});

// Streaming reasoning endpoint
fastify.post("/reason/stream", async (req, reply) => {
  const body = req.body || {};
  const question = body.question || "What are the key points?";
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  const profile = body.profile || "answer_strict";
  const model = body.model || DEFAULT_MODEL;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  if (chunks.length === 0) {
    reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "No chunks provided" })}\n\n`);
    reply.raw.end();
    return;
  }

  const promptConfig = PROMPT_PROFILES[profile] || PROMPT_PROFILES.answer_strict;
  const prompt = promptConfig.template(question, chunks);

  try {
    const stream = await ollama.generate({
      model,
      prompt,
      system: promptConfig.system,
      stream: true
    });

    let fullAnswer = "";
    for await (const part of stream) {
      if (part.response) {
        fullAnswer += part.response;
        reply.raw.write(`data: ${JSON.stringify({ type: "token", text: part.response })}\n\n`);
      }
    }

    const citations = chunks.slice(0, 5).map(c => ({
      chunkId: c.chunkId,
      path: c.path || c.filePath,
      section: c.section || `Chunk ${c.chunkIndex || 0}`,
      quote: (c.text || "").slice(0, 100)
    }));

    reply.raw.write(`data: ${JSON.stringify({ type: "done", answer: fullAnswer, citations })}\n\n`);
    reply.raw.end();
  } catch (err) {
    console.error("Ollama streaming error:", err);
    reply.raw.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
    reply.raw.end();
  }
});

const port = 8788;
await fastify.listen({ port, host: "127.0.0.1" });
fastify.log.info(`Reasoning Service listening on http://127.0.0.1:${port}`);
