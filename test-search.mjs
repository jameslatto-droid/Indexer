import fs from "fs";
import path from "path";

const INDEX_DIR = "E:/AIIndex";

// Load index
const files = fs.readdirSync(INDEX_DIR).filter(f => f.startsWith("index_") && f.endsWith(".json")).sort().reverse();
const indexPath = path.join(INDEX_DIR, files[0]);
const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));

console.log(`Loaded ${data.embeddings.length} embeddings`);
console.log("First embedding:", JSON.stringify(data.embeddings[0], null, 2).slice(0, 500));

// Test keywordScore
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

// Test search
const query = "json";
const topK = 3;
const minScore = 0;

console.log(`\nSearching for "${query}"...`);
const scored = data.embeddings.map((item, idx) => {
  try {
    const text = item.text || "";
    const score = keywordScore(text, query);
    return { idx, filePath: item.filePath, chunkIndex: item.chunkIndex, text: text.slice(0, 80), score };
  } catch (e) {
    console.error(`Error at idx ${idx}:`, e.message);
    return { idx, score: 0 };
  }
}).filter(x => x.score >= minScore).sort((a, b) => b.score - a.score).slice(0, topK);

console.log("\nResults:");
scored.forEach(r => {
  console.log(`  Score: ${r.score.toFixed(3)} | ${r.text}`);
});
