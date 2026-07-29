#!/usr/bin/env node
// CI guard: proves the bundled semantic-search model loads OFFLINE from the
// data/models/Xenova/all-MiniLM-L6-v2 path and produces a 384-dim vector.
// This is the exact failure that shipped silently in 0.6.0–0.8.19 (the model
// files weren't packaged / the runtime path was wrong). Fail the build loudly
// if it ever regresses. Run: node scripts/assert-semantic.js
import { pipeline, env } from "@xenova/transformers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const dir = dirname(fileURLToPath(import.meta.url));
const modelsRoot = join(dir, "..", "data", "models");
const modelDir = join(modelsRoot, "Xenova", "all-MiniLM-L6-v2");

if (!existsSync(modelDir)) {
  console.error("FAIL: bundled model dir missing:", modelDir);
  console.error("  (package.json `files` glob and the crawler model-fetch must both use the Xenova/ path)");
  process.exit(1);
}

env.localModelPath = modelsRoot;
env.allowRemoteModels = false; // force offline — no HuggingFace fallback

try {
  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
  const out = await extractor("lending positions on arbitrum", { pooling: "mean", normalize: true });
  if (!out || out.data.length !== 384) {
    console.error("FAIL: expected 384-dim embedding, got", out && out.data && out.data.length);
    process.exit(1);
  }
  console.log("OK: semantic_search model loads offline, dims =", out.data.length);
} catch (e) {
  console.error("FAIL: model did not load offline:", e.message);
  process.exit(1);
}
