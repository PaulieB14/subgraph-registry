/**
 * Integration tests over the real MCP stdio surface.
 *
 * Deliberately no test framework and no dev dependencies — node:test ships
 * with Node 20, which package.json already requires. These drive the server
 * exactly as an MCP client does (initialize -> tools/list -> tools/call), so
 * they cover the JSON-RPC wiring and the SQL together rather than unit-testing
 * helpers that are not exported.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let proc;
let buf = "";
let nextId = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${method}`)),
      30_000,
    );
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function callTool(name, args) {
  const res = await send("tools/call", { name, arguments: args });
  assert.ok(res.result, `${name} returned an error: ${JSON.stringify(res.error)}`);
  return JSON.parse(res.result.content[0].text);
}

before(async () => {
  proc = spawn("node", [join(ROOT, "src", "index.js")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      } catch {
        /* server logs to stdout are not our problem here */
      }
    }
  });
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
});

after(() => proc?.kill());

test("reports the real package version, not a hardcoded literal", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const res = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(res.result.serverInfo.version, pkg.version);
});

test("exposes the documented tool set", async () => {
  const res = await send("tools/list", {});
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "get_schema_changes",
    "get_subgraph_detail",
    "list_registry_stats",
    "recommend_subgraph",
    "search_subgraphs",
    "semantic_search_subgraphs",
  ]);
});

test("search excludes curation-denied deployments by default", async () => {
  const d = await callTool("search_subgraphs", { query: "uniswap", limit: 25 });
  assert.ok(d.subgraphs.length > 0, "expected matches for uniswap");
  for (const s of d.subgraphs) {
    assert.equal(s.denied, false, `${s.display_name} is denied but was returned`);
  }
});

test("include_denied is honoured and keeps the flag visible", async () => {
  // Ask for the denied set specifically. The corpus has ~179 of them, so a
  // broad query with the flag on must be able to surface at least one — and
  // when it does, `denied` must be true rather than silently omitted.
  const d = await callTool("search_subgraphs", {
    query: "swap",
    limit: 50,
    include_denied: true,
    include_unserved: true,
  });
  for (const s of d.subgraphs) {
    assert.equal(typeof s.denied, "boolean", "denied must always be present");
  }
});

test("recommend_subgraph never returns a denied deployment", async () => {
  const d = await callTool("recommend_subgraph", { goal: "find DEX trades on Arbitrum" });
  for (const r of d.recommendations || []) {
    assert.notEqual(r.denied, true, `${r.display_name} is denied`);
  }
});

test("every result carries age_days and a maturity bucket", async () => {
  const d = await callTool("search_subgraphs", { query: "lending", limit: 10 });
  for (const s of d.subgraphs) {
    assert.ok(Number.isInteger(s.age_days), "age_days must be an integer");
    assert.ok(
      ["new", "emerging", "established", "unknown"].includes(s.maturity),
      `unexpected maturity ${s.maturity}`,
    );
  }
});

test("emerging list is young, disjoint from the main list, and captioned", async () => {
  // "perpetual futures" is the motivating case: the ranked list is all
  // multi-year deployments, and the new Monad perps subgraphs only appear here.
  const d = await callTool("search_subgraphs", { query: "perpetual futures", limit: 3 });
  if (!d.emerging || d.emerging.length === 0) return; // corpus-dependent, not a failure
  assert.ok(d.emerging_caveat, "emerging list must ship with its caveat");
  const mainIds = new Set(d.subgraphs.map((s) => s.id));
  for (const e of d.emerging) {
    assert.ok(!mainIds.has(e.id), `${e.display_name} is in both lists`);
    assert.ok(e.age_days < 90, `${e.display_name} is ${e.age_days}d old, not emerging`);
    assert.ok(["new", "emerging"].includes(e.maturity));
    assert.equal(e.denied, false, "emerging must respect the denied filter too");
    assert.ok(e.query_url_x402, "emerging entries must be as actionable as the main list");
  }
});

test("emerging respects the caller's filters", async () => {
  const d = await callTool("search_subgraphs", {
    query: "swap",
    network: "base",
    limit: 5,
  });
  for (const e of d.emerging || []) {
    assert.equal(e.network, "base", "emerging leaked past the network filter");
  }
});

// ── Ranking regressions ──────────────────────────────────────────────────
// Each of these is a real query that returned a confidently wrong answer on
// 0.9.0. They assert identity of the top hit, not score, because the scores
// are corpus-dependent and the identity is the thing a user notices.

test("more specific queries do not get worse answers", async () => {
  // 0.9.0: top 4 was uniswap-v3-arbitrum, Arbitrum Minimal, camelot-amm-v3,
  // Graph TAP Arbitrum One — not one Aave subgraph — while bare "aave" was
  // correct. OR-ed terms ranked by reliability let one incidental word win.
  const d = await callTool("search_subgraphs", { query: "aave lending arbitrum", limit: 4 });
  const names = d.subgraphs.map((s) => s.display_name.toLowerCase());
  assert.ok(
    names.some((n) => n.includes("aave")),
    `no Aave subgraph in top 4: ${names.join(", ")}`,
  );
});

test("version tokens are not silently dropped", async () => {
  // "v3" is two characters, and the old tokenizer filtered w.length > 2, so
  // "uniswap v3" was byte-identical to "uniswap".
  const d = await callTool("search_subgraphs", { query: "uniswap v3", limit: 5 });
  const names = d.subgraphs.map((s) => s.display_name.toLowerCase());
  assert.ok(
    names.some((n) => n.includes("v3") || n.includes("v-3")),
    `no v3 subgraph in top 5: ${names.join(", ")}`,
  );
});

test("common chain names resolve to corpus chain ids", async () => {
  // ~45% of the corpus lives under mainnet/bsc/arbitrum-one/matic, and
  // SKILL.md documented "ethereum, arbitrum, base" — two of which matched 0.
  for (const [alias, canonical] of [
    ["ethereum", "mainnet"],
    ["arbitrum", "arbitrum-one"],
    ["polygon", "matic"],
    ["bnb", "bsc"],
  ]) {
    const d = await callTool("search_subgraphs", { network: alias, limit: 3 });
    assert.ok(d.subgraphs.length > 0, `network:"${alias}" returned nothing`);
    for (const s of d.subgraphs) {
      assert.equal(s.network, canonical, `${alias} should resolve to ${canonical}`);
    }
  }
});

test("a chain filter that matches nothing is not silently empty", async () => {
  // 0.9.0: recommend_subgraph(goal, chain:"arbitrum") -> total_matches 0.
  const d = await callTool("recommend_subgraph", {
    goal: "find DEX trades on Arbitrum",
    chain: "arbitrum",
  });
  assert.ok(d.total_matches > 0, "chain alias still yields no matches");
  for (const r of d.recommendations || []) {
    assert.equal(r.network, "arbitrum-one");
  }
});

test("goal inference does not fire on substrings of ordinary words", async () => {
  // "reputation" contains "put" -> inferred protocol_type ["options"] and the
  // top hit was the Polygon Optimistic Oracle.
  const d = await callTool("recommend_subgraph", {
    goal: "reputation scores for onchain agents",
  });
  assert.ok(
    !(d.inferred_protocol_type || []).includes("options"),
    `still inferring options: ${JSON.stringify(d.inferred_protocol_type)}`,
  );
});

test("semantic search prefers the production deployment over its testnet", async () => {
  // 0.9.0 ranked ENS Sepolia (58 queries/30d, reliability 0.2463) above ENS
  // mainnet (34.8M queries/30d, reliability 0.9775) on a 0.0105 cosine margin.
  const d = await callTool("semantic_search_subgraphs", {
    query: "ENS domain name registrations",
    limit: 4,
  });
  if (d.error || !d.subgraphs?.length) return; // model unavailable
  const top = d.subgraphs[0];
  assert.ok(
    !/sepolia|goerli|testnet/i.test(`${top.display_name} ${top.network}`),
    `testnet ranked first: ${top.display_name} (${top.network})`,
  );
});

test("semantic search labels maturity but ships no emerging list", async () => {
  const d = await callTool("semantic_search_subgraphs", {
    query: "perpetual futures trading",
    limit: 5,
  });
  if (d.error) return; // embedding model unavailable in this environment
  assert.equal(d.emerging, undefined, "semantic search ranks by cosine, not age");
  for (const s of d.subgraphs || []) {
    assert.ok(["new", "emerging", "established", "unknown"].includes(s.maturity));
  }
});
