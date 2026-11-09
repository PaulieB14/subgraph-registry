import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const client = new Client({ name: "usability-regression", version: "1" }, { capabilities: {} });
let transport;
before(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    stderr: "pipe",
    // Never inherit a real Studio key: every request here must stay local.
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      THE_GRAPH_STUDIO_API_KEY: "", GRAPH_STUDIO_API_KEY: "", GATEWAY_API_KEY: "" },
  });
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
});
after(async () => { await client.close(); });
async function call(name, args) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  return JSON.parse(reply.content[0].text);
}

test("standalone known chains route search, aliases normalize, explicit network wins", async () => {
  for (const [query, network] of [["arc", "arc"], ["Arc Mainnet", "arc"], ["Arc Testnet", "arc-testnet"], ["Ethereum", "mainnet"], ["polygon", "matic"]]) {
    const r = await call("search_subgraphs", { query, limit: 3 });
    assert.equal(r.inferred_network, network);
    assert.ok(r.subgraphs.length);
    assert.ok(r.subgraphs.every(x => x.network === network));
  }
  const r = await call("search_subgraphs", { query: "arc", network: "ethereum", limit: 3 });
  assert.equal(r.inferred_network, null);
  assert.equal(r.network_filter, "mainnet");
  assert.ok(r.subgraphs.some(x => x.display_name === "Aave ARC Ethereum"));
});

test("empty search explains snapshot exclusions without declaring availability", async () => {
  const r = await call("search_subgraphs", { query: "tolly-arc-mainnet", network: "arc" });
  assert.equal(r.total, 0);
  assert.equal(r.diagnostics.matching_records_before_visibility_filters, 1);
  assert.equal(r.diagnostics.excluded_by.no_active_allocation, 1);
  assert.equal(r.diagnostics.network_known_in_snapshot, true);
  assert.equal(r.diagnostics.suggested_retry.arguments.include_unserved, true);
  assert.equal(r.diagnostics.suggested_retry.arguments.network, "arc");
  assert.match(r.discovery_filters.caveat, /Zero allocations or no indexing rewards does not prove/);
  assert.equal(r.next_action.action, "broaden_discovery_before_execution");
  const visible = await call("search_subgraphs", { query: "tolly-arc-mainnet", network: "arc", include_unserved: true });
  assert.equal(visible.subgraphs[0].active_allocation_count, 0);
  assert.equal(visible.subgraphs[0].freshness.live, null);
});

test("unknown network has bounded vocabulary diagnostics; empty corpus is not chain nonexistence", async () => {
  const r = await call("search_subgraphs", { network: "arcc" });
  assert.equal(r.diagnostics.network_known_in_snapshot, false);
  assert.equal(r.diagnostics.matching_records_before_visibility_filters, 0);
  assert.ok(r.diagnostics.available_networks.includes("arc"));
  assert.match(r.diagnostics.next_step, /absence is not proof/);
});

test("exact distinctive protocol terms beat longer similarly named deployments", async () => {
  const search = await call("search_subgraphs", { query: "ens", limit: 3 });
  assert.equal(search.subgraphs[0].display_name, "ENS");
  const recommendation = await call("recommend_subgraph", { goal: "ens name lookups on ethereum", chain: "ethereum" });
  assert.equal(recommendation.recommendations[0].display_name, "ENS");
});

test("discovery limits, text, booleans and unsupported pagination fail before SQL or inference", async () => {
  for (const args of [
    { limit: -1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "3" },
    { include_unserved: "false" }, { include_denied: 1 }, { include_testnets: null },
    { query: 42 }, { query: "x".repeat(1001) }, { network: [] },
    { offset: 1 }, { cursor: "next" }, { min_reliability: -1 },
  ]) {
    const r = await call("search_subgraphs", { network: "arc", ...args });
    assert.ok(r.error, JSON.stringify(args));
    assert.doesNotMatch(r.error, /datatype mismatch|toLowerCase is not a function/);
  }
  const recommended = await call("recommend_subgraph", { goal: 42 });
  assert.match(recommended.error, /goal must be/);
});

test("semantic validation runs before loading a model and rejects false boolean strings", async () => {
  for (const args of [{ query: 42 }, { query: "" }, { limit: -1 }, { limit: 51 },
    { include_unserved: "false" }, { min_score: "0.5" }, { min_score: -1 }, { offset: 1 }]) {
    assert.ok((await call("semantic_search_subgraphs", { query: "staking", ...args })).error);
  }
});

test("onboarding is actionable, secret-safe, free-tier qualified, and never auto-pays", async () => {
  const r = await call("search_subgraphs", { network: "arc", limit: 1 });
  assert.equal(r.total, 1);
  assert.equal(r.total_is_returned_count, true);
  const next = r.next_action;
  assert.equal(next.credentials, "not_configured");
  assert.equal(next.api_key.create_url, "https://thegraph.com/studio/apikeys/");
  assert.equal(next.api_key.header, "Authorization: Bearer <STUDIO_API_KEY>");
  assert.match(next.api_key.free_plan, /100,000/);
  assert.match(next.api_key.free_plan, /not a per-key guarantee/);
  assert.match(next.api_key.setup, /never paste it in chat/);
  assert.match(next.execution, /HTTP 200.*GraphQL errors/);
  assert.match(next.paid_alternative, /never signs or auto-pays/);
});

test("another Studio-supported mainnet is discoverable without inventing reward status or live health", async () => {
  const r = await call("search_subgraphs", { network: "sei-mainnet", limit: 3 });
  assert.ok(r.subgraphs.length);
  assert.ok(r.subgraphs.every(x => x.network === "sei-mainnet" && x.freshness.live === null));
  assert.match(r.discovery_filters.caveat, /NOT a live queryability test/);
});
