/**
 * execute_query / get_schema success path with a mocked gateway.
 * Does not hit The Graph and does not spend a Studio key.
 *
 * SUBGRAPH_REGISTRY_MOCK_GATEWAY=1 + THE_GRAPH_STUDIO_API_KEY=test-key
 * makes postGateway return a canned 200 body.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
      () => reject(new Error("timeout waiting for " + method)),
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
  assert.ok(res.result, name + " returned an error: " + JSON.stringify(res.error));
  return JSON.parse(res.result.content[0].text);
}

before(async () => {
  proc = spawn("node", [join(ROOT, "src", "index.js")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      THE_GRAPH_STUDIO_API_KEY: "test-key",
      SUBGRAPH_REGISTRY_MOCK_GATEWAY: "1",
    },
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
        /* ignore non-json */
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

test("execute_query_by_subgraph_id with a key POSTs and returns gateway data", async () => {
  const d = await callTool("execute_query_by_subgraph_id", {
    subgraph_id: "Sxx812XgeKyzQPaBpR5YZWmGV5fZuBaPdh7DFhzSwiQ",
    query: "{ _meta { block { number } } }",
    variables: { n: 1 },
  });
  assert.equal(d.http_status, 200);
  assert.equal(d.data._mock, true);
  assert.equal(d.kind, "subgraph_id");
  assert.match(d.data.url, /\/subgraphs\/id\/Sxx812/);
  assert.equal(d.data.query, "{ _meta { block { number } } }");
  assert.deepEqual(d.data.variables, { n: 1 });
  assert.equal(d.error, undefined);
});

test("execute_query_by_ipfs_hash routes to deployments/id", async () => {
  const d = await callTool("execute_query_by_ipfs_hash", {
    ipfs_hash: "QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7",
    query: "{ pools(first: 1) { id } }",
  });
  assert.equal(d.http_status, 200);
  assert.equal(d.kind, "ipfs_hash");
  assert.match(d.data.url, /\/deployments\/id\/QmTZ8/);
});

test("get_schema_by_subgraph_id with a key returns local cache plus live introspection", async () => {
  const d = await callTool("get_schema_by_subgraph_id", {
    subgraph_id: "Sxx812XgeKyzQPaBpR5YZWmGV5fZuBaPdh7DFhzSwiQ",
  });
  assert.ok(d.registry_schema);
  assert.equal(d.registry_schema.id, "Sxx812XgeKyzQPaBpR5YZWmGV5fZuBaPdh7DFhzSwiQ");
  assert.equal(d.http_status, 200);
  assert.ok(d.live_introspection);
});

// ── Identifier validation ────────────────────────────────────────────────
// The gateway base is a literal, so a caller could never redirect a request to
// another HOST. But the id was interpolated into the path with only a trim, so
// it could walk that path while carrying the caller's Studio bearer token:
//   "../../evil"       -> https://gateway.thegraph.com/api/evil
//   "x/../../../admin" -> https://gateway.thegraph.com/api/admin
// And naming deployment_id or ipfs_hash explicitly skipped classification
// entirely, so the check that did exist for `id` could be sidestepped.

test("a crafted identifier cannot walk the gateway path", async () => {
  for (const args of [
    { id: "../../evil" },
    { id: "x/../../../admin" },
    { id: "a?b=c#d" },
    { id: "https://evil.com/x" },
    { deployment_id: "../../admin" },
    { ipfs_hash: "../../admin" },
  ]) {
    const r = await callTool("execute_query", { ...args, query: "{ _meta { block { number } } }" });
    assert.ok(r.error, `${JSON.stringify(args)} was accepted`);
    assert.ok(!r.data, `${JSON.stringify(args)} reached the gateway`);
  }
});

test("real identifiers in all three forms still resolve", async () => {
  // The validation must not be so strict that it rejects the things the tool
  // exists to accept.
  for (const args of [
    { id: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV" },
    { deployment_id: "0x" + "a".repeat(64) },
    { ipfs_hash: "QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7" },
  ]) {
    const r = await callTool("execute_query", { ...args, query: "{ _meta { block { number } } }" });
    assert.ok(!r.error || r.error === "credentials_required",
      `${JSON.stringify(args)} was rejected: ${r.error}`);
  }
});
