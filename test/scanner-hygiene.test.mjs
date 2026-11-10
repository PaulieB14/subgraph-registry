// Release hygiene that the ClawHub scanners check (0.13.2): exact dependency
// pins, literal pinned npx references, bundled-model-only semantic search
// (never a download), and every env var the server reads declared in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDLERS, PINNED_NPX_PACKAGE, missingBundledModelFiles, setEmbeddingModelRootForTests,
} from "../src/index.js";

const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const pkg = JSON.parse(read("package.json"));

function trapNetwork() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("network disabled in test"); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("dependencies are pinned to exact versions", () => {
  for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
    for (const [name, v] of Object.entries(pkg[field] || {})) {
      assert.match(v, /^\d+\.\d+\.\d+$/, `${field}.${name}=${v} must be an exact version`);
    }
  }
});

test("npx references are literal and pinned to this release", () => {
  assert.equal(PINNED_NPX_PACKAGE, `subgraph-registry-mcp@${pkg.version}`);
  const src = read("src/index.js");
  assert.doesNotMatch(src, /subgraph-registry-mcp@\$\{/, "no variable-built npx spec");
  for (const f of ["README.md", "SKILL.md"]) {
    const text = read(f);
    for (const m of text.matchAll(/subgraph-registry-mcp@([0-9A-Za-z.\-]+)/g)) {
      assert.equal(m[1], pkg.version, `${f} pins ${m[0]}`);
    }
    assert.doesNotMatch(text, /npx(?:\s+-y)?\s+subgraph-registry-mcp(?![@\w-])/, `${f} has an unpinned npx reference`);
  }
});

test("every env var the server reads is declared in SKILL.md metadata", () => {
  const src = read("src/index.js") + read("src/agent-discovery.js") + read("src/goal-query.js") + read("src/token-quality.js");
  const used = new Set([...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  used.add("SUBGRAPH_REGISTRY_HTTP_TOKEN");
  used.add("MCP_HTTP_HOST");
  const front = read("SKILL.md").split("---")[1];
  const meta = JSON.parse(front.slice(front.indexOf("{")));
  const declared = new Set(meta.openclaw.envVars.map((e) => e.name));
  for (const name of used) assert.ok(declared.has(name), `${name} is read but not declared`);
  for (const e of meta.openclaw.envVars) assert.equal(e.required, false, `${e.name} must stay optional`);
});

test("semantic search runs offline from the bundled model", async () => {
  assert.deepEqual(missingBundledModelFiles(), []);
  setEmbeddingModelRootForTests(null);
  const net = trapNetwork();
  try {
    const r = await HANDLERS.semantic_search_subgraphs({ query: "uniswap v3 pools and swaps", limit: 3 });
    assert.ok(!r.error, r.error);
    assert.ok(r.search_mode !== "keyword_fallback");
    assert.ok((r.subgraphs || r.results || []).length > 0);
    assert.deepEqual(net.calls, [], "no network request");
  } finally { net.restore(); }
});

test("missing bundled model fails closed to keyword search, never downloads", async () => {
  const empty = mkdtempSync(join(tmpdir(), "sr-model-"));
  assert.equal(missingBundledModelFiles(join(empty, "Xenova", "all-MiniLM-L6-v2")).length, 4);
  setEmbeddingModelRootForTests(empty);
  const net = trapNetwork();
  try {
    const r = await HANDLERS.semantic_search_subgraphs({ query: "uniswap", limit: 3 });
    assert.equal(r.search_mode, "keyword_fallback");
    assert.equal(r.semantic_unavailable.reason, "bundled_model_missing");
    assert.match(r.semantic_unavailable.fix, new RegExp(PINNED_NPX_PACKAGE.replace(/[.@]/g, "\\$&")));
    assert.ok((r.subgraphs || []).length > 0);
    assert.deepEqual(net.calls, [], "no network request");
  } finally {
    net.restore();
    setEmbeddingModelRootForTests(null);
  }
});
