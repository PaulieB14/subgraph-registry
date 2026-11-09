import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { boundedStarter, healthObservation, freshness, findContractDeployments, HEALTH_QUERY } from "../src/agent-discovery.js";
import { HANDLERS } from "../src/index.js";

const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let requests;
beforeEach(() => {
  for (const key of ["THE_GRAPH_STUDIO_API_KEY", "GRAPH_STUDIO_API_KEY", "GATEWAY_API_KEY", "SUBGRAPH_REGISTRY_MOCK_GATEWAY"]) delete process.env[key];
  requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return new Response(JSON.stringify({ data: {
      pools: [{ id: "example" }],
      _meta: { deployment: "example", hasIndexingErrors: false, block: { number: 12345, timestamp: 1700000000 } },
    } }), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ["THE_GRAPH_STUDIO_API_KEY", "GRAPH_STUDIO_API_KEY", "GATEWAY_API_KEY", "SUBGRAPH_REGISTRY_MOCK_GATEWAY"]) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});

const starter = "{ _meta { block { number timestamp } } pools(first: 1000, orderBy: volumeUSD, orderDirection: desc) { id volumeUSD } }";
test("starter parser bounds a single collection and rejects unsafe shapes", () => {
  assert.match(boundedStarter(starter, 2), /first: 2/);
  for (const query of [
    "mutation { remove(id: 1) { id } }", "subscription { pools { id } }",
    "{ pools { id } swaps { id } }", "{ pools { swaps(first: 1000) { id } } }",
    "{ pools { ...fields } } fragment fields on Pool { id }",
    "query($n: Int!) { pools(first: $n) { id } }",
    "{ x: pools { id } }", "{ pools @skip(if: true) { id } }",
    "{ pools(where: {id: 1}) { id } }", "{ _meta { pools { id } } pools { id } }",
    "{ pools(first: 2, first: 3) { id } }", "{ pools { id(alias: 1) } }",
    "{ pools { id } } { pools { id } }", "invalid", "", null,
  ]) assert.throws(() => boundedStarter(query), String(query));
  for (const first of [0, 11, 2.5, "5", NaN]) assert.throws(() => boundedStarter(starter, first));
});

test("health evidence is measured, stale explicitly, and never implies chain-head sync", () => {
  const result = { http_status: 200, data: { _meta: {
    block: { number: 100, timestamp: 123 }, hasIndexingErrors: false,
  } } };
  const observation = healthObservation(result, 1000);
  assert.equal(observation.status, "serving");
  assert.equal(observation.indexed_block_number, 100);
  assert.equal(observation.synced_to_chain_head, null);
  assert.equal(freshness({ updated_at: 99 }, observation, 1301).live.stale, true);
  assert.equal(freshness({}, observation, 1001).live.stale, false);
  assert.equal(freshness({ updated_at: 99 }, null).registry_updated_at, 99);
  assert.equal(freshness({}, null).live, null);
  assert.equal(healthObservation({ http_status: 200, data: {} }).status, "metadata_unavailable");
  assert.equal(healthObservation({ http_status: 200, errors: [{ message: "auth" }] }).status, "query_failed");
  assert.equal(healthObservation({ http_status: 503, data: result.data }).indexed_block_number, null);
  assert.equal(healthObservation({ ...result, data: { _meta: { ...result.data._meta, hasIndexingErrors: true } } }).status, "indexing_errors");
});

test("contract lookup is exact, case-insensitive, manifest-chain aware and de-duplicated before limit", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE subgraphs (id TEXT, ipfs_hash TEXT, network TEXT, contract_addresses TEXT, active_allocation_count INT, denied_at INT, reliability_score REAL, query_volume_30d INT)");
    const address = "0x" + "ab".repeat(20);
    const add = (id, network, contracts, ipfs = id, allocated = 1, denied = 0) => db.prepare("INSERT INTO subgraphs VALUES (?, ?, ?, ?, ?, ?, 1, 100)")
      .run(id, ipfs, network, typeof contracts === "string" ? contracts : JSON.stringify(contracts), allocated, denied);
    add("a", "mainnet", [{ address, network: "base" }]);
    add("b", "mainnet", [{ address: address + "00" }]);
    add("c", "mainnet", [{ address: address.toUpperCase().replace("0X", "0x"), network: "mainnet" }], "shared");
    add("d", "mainnet", [{ address }], "shared");
    add("e", "base", [{ address }], "shared");
    add("f", "mainnet", "malformed");
    add("g", "mainnet", ["not-an-object", null]);
    add("h", "mainnet", [{ address }], "h", 0);
    add("i", "mainnet", [{ address }], "i", 1, 1);
    const normalize = (s) => s === "ethereum" ? "mainnet" : s;
    const found = findContractDeployments(db, { address, chain: "ethereum", limit: 1 }, normalize);
    assert.deepEqual(found.deployments.map((d) => d.row.id), ["c"]);
    const all = findContractDeployments(db, { address, limit: 20 }, normalize);
    assert.deepEqual(all.deployments.map((d) => d.row.id), ["a", "c", "e"]);
    assert.ok(findContractDeployments(db, { address: address + "0" }, normalize).error);
    assert.ok(findContractDeployments(db, { address, limit: -1 }, normalize).error);
  } finally { db.close(); }
});

const goal = "uniswap v3 on ethereum";
test("goal preparation makes zero network calls even with a key", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = "unit-test-key";
  const out = await HANDLERS.query_for_goal({ goal, first: 3 });
  assert.equal(out.executed, false);
  assert.equal(out.validation.live_schema, "not_checked");
  assert.equal(out.validation.syntax, "passed");
  assert.match(out.query, /first: 3/);
  assert.match(out.request.query_url, /gateway\.thegraph\.com\/api\/deployments\/id\//);
  assert.equal(requests.length, 0);
});

test("keyless goal execution returns an unsigned request without network or payment", async () => {
  const out = await HANDLERS.query_for_goal({ goal, execute: true });
  assert.equal(out.error, "credentials_required");
  assert.equal(out.executed, false);
  assert.ok(out.request.query_url_x402);
  assert.equal(requests.length, 0);
});

test("explicit goal execution is one fixed-host, pinned request and surfaces data", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = "unit-test-key";
  const out = await HANDLERS.query_for_goal({ goal, execute: true, first: 2 });
  assert.equal(out.execution_attempted, true);
  assert.equal(out.executed, true);
  assert.equal(out.validation.gateway_execution, "succeeded");
  assert.equal(out.validation.live_schema, "not_checked");
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).hostname, "gateway.thegraph.com");
  assert.equal(requests[0].redirect, "error");
  assert.equal(requests[0].headers.Authorization, "Bearer unit-test-key");
  assert.match(JSON.parse(requests[0].body).query, /first: 2/);
  assert.equal(out.freshness.live.indexed_block_number, 12345);
});

test("health probe pins crawled deployment, exposes evidence, and discovery only reads cache", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = "unit-test-key";
  const prepared = await HANDLERS.query_for_goal({ goal });
  const out = await HANDLERS.check_subgraph_health({ subgraph_id: prepared.selected.id });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, prepared.request.query_url);
  assert.equal(JSON.parse(requests[0].body).query, HEALTH_QUERY);
  assert.equal(out.freshness.live.status, "serving");
  const detail = HANDLERS.get_subgraph_detail({ subgraph_id: prepared.selected.id });
  assert.equal(detail.freshness.live.observed_at, out.freshness.live.observed_at);
  assert.equal(requests.length, 1);
});

test("gateway GraphQL/auth/HTTP/malformed/timeout failures never claim successful validation", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = "unit-test-key";
  for (const [body, status, error] of [
    [{ errors: [{ message: "missing authorization header" }] }, 200, null],
    [{ data: { pools: [] }, errors: [{ message: "partial failure" }] }, 200, null],
    [{ message: "unavailable" }, 503, "gateway_http_error"],
    ["not json", 200, "invalid_gateway_response"],
    [{}, 200, "invalid_gateway_response"],
  ]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); };
    const out = await HANDLERS.query_for_goal({ goal, execute: true });
    assert.equal(calls, 1);
    assert.equal(out.execution_attempted, true);
    assert.equal(out.executed, false);
    assert.equal(out.validation.gateway_execution, "failed");
    assert.equal(out.freshness.live.status, "query_failed");
    if (error) assert.equal(out.result.error, error);
  }
  globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
  const out = await HANDLERS.query_for_goal({ goal, execute: true });
  assert.equal(out.result.error, "gateway_error");
  assert.equal(out.validation.gateway_execution, "failed");
});

test("invalid inputs and missing matches cannot trigger gateway calls", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = "unit-test-key";
  for (const args of [{}, { goal: " " }, { goal, execute: "true" }, { goal, first: 100 }, { goal, chain: {} }]) {
    assert.ok((await HANDLERS.query_for_goal(args)).error);
  }
  const noMatch = await HANDLERS.query_for_goal({ goal: "zzyyxxnonexistentprotocol", execute: true });
  assert.equal(noMatch.error, "no_suitable_starter");
  assert.equal(noMatch.executed, false);
  const invalid = await HANDLERS.check_subgraph_health({ id: "../../evil" });
  assert.ok(invalid.error);
  assert.equal(requests.length, 0);
});


test("health cannot spend without a key and invalid contract inputs remain local", async () => {
  const health = await HANDLERS.check_subgraph_health({ subgraph_id: "Sxx812XgeKyzQPaBpR5YZWmGV5fZuBaPdh7DFhzSwiQ" });
  assert.equal(health.error, "credentials_required");
  assert.equal(requests.length, 0);
  assert.ok(HANDLERS.find_by_contract({ address: "0x123" }).error);
  assert.ok(HANDLERS.find_by_contract({ address: "0x" + "a".repeat(40), chain: " " }).error);
});
