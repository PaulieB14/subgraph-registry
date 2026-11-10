// Healthy-alternative fallback and spam-token flags, against a MOCKED gateway.
// No real network or key is used.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HANDLERS, resetHealthObservationsForTests } from "../src/index.js";
import { applyTokenQuality, assessRows, normalizeTrusted } from "../src/token-quality.js";
import { probeHealth } from "../src/goal-query.js";

const KEYS = ["THE_GRAPH_STUDIO_API_KEY", "GRAPH_STUDIO_API_KEY", "GATEWAY_API_KEY", "SUBGRAPH_REGISTRY_MOCK_GATEWAY"];
const FAKE_KEY = "health-test-secret-value-456";
const originalFetch = globalThis.fetch;
const saved = { ...process.env };
let requests, responder;
const now = () => Math.floor(Date.now() / 1000);
beforeEach(() => {
  resetHealthObservationsForTests();
  for (const k of KEYS) delete process.env[k];
  requests = [];
  responder = () => ({ data: {} });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, query: JSON.parse(options.body).query });
    const body = responder(url, JSON.parse(options.body).query, requests.length);
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const T = (kind, name, { list = false, nonNull = false } = {}) => {
  let t = { kind, name, ofType: null };
  if (list) t = { kind: "LIST", name: null, ofType: { kind: "NON_NULL", name: null, ofType: t } };
  if (nonNull) t = { kind: "NON_NULL", name: null, ofType: t };
  return t;
};
function probe({ entity, collection, fields, orderBy, filter = [["id", "ID"]], meta = { block: { number: 100, timestamp: now() - 30 }, hasIndexingErrors: false } }) {
  return {
    q: { fields: [{ name: collection, args: [{ name: "first", defaultValue: "100", type: T("SCALAR", "Int") }], type: T("OBJECT", entity, { list: true, nonNull: true }) }] },
    e: { name: entity, fields: fields.map(([name, kind, type]) => ({ name, type: T(kind, type, { nonNull: name === "id" }) })) },
    o: { enumValues: orderBy.map((name) => ({ name })) },
    f: { inputFields: filter.map(([name, type]) => ({ name, type: T("SCALAR", type) })) },
    i: null,
    t: { name: "Token", fields: [["id", "ID"], ["symbol", "String"], ["name", "String"]].map(([name, type]) => ({ name, type: T("SCALAR", type) })) },
    m: meta,
  };
}
const SWAP = (meta) => probe({ entity: "Swap", collection: "swaps", meta,
  fields: [["id", "SCALAR", "ID"], ["timestamp", "SCALAR", "BigInt"], ["amountUSD", "SCALAR", "BigDecimal"]], orderBy: ["id", "timestamp"] });
const GOAL = { goal: "latest Uniswap v3 swaps on Ethereum", first: 2, validate_schema: true, execute: true };

async function firstCandidate() {
  const keyless = await HANDLERS.query_for_goal({ goal: GOAL.goal, first: 2 });
  assert.equal(requests.length, 0);
  return keyless.selected;
}
const swapsData = () => ({ data: { _meta: { block: { number: 101, timestamp: now() - 20 } }, swaps: [{ id: "s1", timestamp: String(now() - 25), amountUSD: "10" }] } });

test("not-serving deployment is skipped for the best healthy alternative and reported", async () => {
  const bad = await firstCandidate();
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  responder = (url, q) => url.includes(bad.ipfs_hash)
    ? { errors: [{ message: "bad indexers: {0xabc: BadResponse(no attestation: indexing_error)}" }] }
    : q.includes("__type") ? { data: SWAP() } : swapsData();
  const out = await HANDLERS.query_for_goal(GOAL);
  assert.notEqual(out.selected.id, bad.id);
  assert.equal(out.executed, true);
  assert.equal(out.gateway_requests, 3);
  assert.equal(out.goal_mapping.fallback_used, true);
  assert.equal(out.goal_mapping.skipped_deployments[0].id, bad.id);
  assert.equal(out.goal_mapping.skipped_deployments[0].reason, "not_serving");
  assert.match(out.goal_mapping.skipped_deployments[0].evidence, /bad indexers/);
  assert.match(out.goal_mapping.rationale.join(" "), /Fell back from/);
  assert.equal(out.goal_mapping.confidence, "high");
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY));

  // The failure is remembered: a second call skips it without spending a request,
  // and recommend_subgraph yields its slot and reports why.
  requests = [];
  const again = await HANDLERS.query_for_goal(GOAL);
  assert.equal(again.gateway_requests, 2);
  assert.equal(again.goal_mapping.skipped_deployments[0].source, "process_local_observation");
  assert.ok(requests.every((r) => !r.url.includes(bad.ipfs_hash)));
  const rec = await HANDLERS.recommend_subgraph({ goal: "uniswap v3 swaps on ethereum" });
  assert.ok(rec.recommendations.every((r) => r.id !== bad.id));
  assert.ok(rec.skipped_unhealthy.some((s) => s.id === bad.id && s.reason === "not_serving"));
  assert.match(rec.health_note, /not used/);
});

test("timeouts and stale _meta trigger fallback; all-stale returns the stale one with a warning", async () => {
  const bad = await firstCandidate();
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  responder = (url, q) => url.includes(bad.ipfs_hash) ? Object.assign(new Error("aborted"), { name: "TimeoutError" })
    : q.includes("__type") ? { data: SWAP() } : swapsData();
  const timedOut = await HANDLERS.query_for_goal(GOAL);
  assert.equal(timedOut.goal_mapping.skipped_deployments[0].reason, "not_serving");
  assert.match(timedOut.goal_mapping.skipped_deployments[0].evidence, /timed out/);
  assert.equal(timedOut.executed, true);

  resetHealthObservationsForTests(); requests = [];
  responder = (url, q) => q.includes("__type")
    ? { data: SWAP(url.includes(bad.ipfs_hash) ? { block: { number: 5, timestamp: now() - 86400 }, hasIndexingErrors: false } : undefined) }
    : swapsData();
  const stale = await HANDLERS.query_for_goal(GOAL);
  assert.equal(stale.goal_mapping.skipped_deployments[0].reason, "stale_indexing");
  assert.notEqual(stale.selected.id, bad.id);
  assert.equal(stale.goal_mapping.deployment_health.status, "serving");

  resetHealthObservationsForTests(); requests = [];
  responder = (url, q) => q.includes("__type") ? { data: SWAP({ block: { number: 5, timestamp: now() - 86400 } }) } : swapsData();
  const allStale = await HANDLERS.query_for_goal(GOAL);
  assert.ok(allStale.query);
  assert.equal(allStale.goal_mapping.confidence, "medium");
  assert.ok(allStale.goal_mapping.unmet.some((u) => /stale/.test(u)));
  assert.ok(allStale.gateway_requests <= 6);
});

test("auth/quota errors never fall back; budget caps attempts at 3 deployments / 6 requests", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  responder = () => ({ errors: [{ message: "Payment required: quota exceeded" }] });
  const out = await HANDLERS.query_for_goal(GOAL);
  assert.equal(requests.length, 1);
  assert.equal(out.execution_skipped, "auth_or_quota_error");
  assert.deepEqual(out.goal_mapping.skipped_deployments, []);

  resetHealthObservationsForTests(); requests = [];
  responder = () => ({ errors: [{ message: "bad indexers: all unavailable" }] });
  const none = await HANDLERS.query_for_goal(GOAL);
  assert.ok(requests.length <= 3);
  assert.equal(none.query, null);
  assert.equal(none.validation.live_schema, "failed");
  assert.equal(none.goal_mapping.skipped_deployments.length, requests.length);
  assert.equal(none.execution_attempted, false);
});

test("reward denial and no-reward chains are not treated as unhealthy", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  responder = (url, q) => q.includes("__type")
    ? { data: probe({ entity: "Candle", collection: "candles", fields: [["id", "SCALAR", "ID"], ["open", "SCALAR", "BigDecimal"], ["periodStartUnix", "SCALAR", "Int"]], orderBy: ["id", "periodStartUnix"] }) }
    : { data: { _meta: { block: { number: 1, timestamp: now() } }, candles: [{ id: "c1" }] } };
  const out = await HANDLERS.query_for_goal({ goal: "OHLCV candles for Uniswap v4 pools on Arc", chain: "arc", first: 1, include_denied: true, validate_schema: true, execute: true });
  assert.equal(out.selected.network, "arc");
  assert.equal(out.selected.denied_indexing_rewards, true);
  assert.deepEqual(out.goal_mapping.skipped_deployments, []);
  assert.equal(out.executed, true);
  assert.match(out.goal_mapping.health_policy, /not treated as unhealthy/);
});

test("probeHealth labels fresh, stale and unknown metadata", () => {
  assert.equal(probeHealth({ block: { number: 1, timestamp: 1000 } }, 1100).status, "serving");
  assert.equal(probeHealth({ block: { number: 1, timestamp: 1000 }, hasIndexingErrors: true }, 1100).status, "serving_with_indexing_errors");
  assert.equal(probeHealth({ block: { number: 1, timestamp: 1000 } }, 1000 + 3 * 3600).status, "stale");
  assert.equal(probeHealth(undefined).status, "unknown");
});

const EASE = { id: "0x160de4468586b6b2f8a92feb0c260fc6cfc743b1", symbol: "ease.org", name: "Ease Fun Token", volumeUSD: "1.14", totalValueLockedUSD: "1109778722632.18", txCount: "40" };
const WETH = { id: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", name: "Wrapped Ether", volumeUSD: "1536319463295.97", totalValueLockedUSD: "1289673250.95", txCount: "99999999" };
const LURE = { id: "0x1111111111111111111111111111111111111111", symbol: "CLAIM", name: "Visit rewards-drop.xyz to claim", volumeUSD: "0", totalValueLockedUSD: "12", txCount: "2" };
const REAL = { id: "0x2222222222222222222222222222222222222222", symbol: "PEPE", name: "Pepe", volumeUSD: "9000000", totalValueLockedUSD: "4000000", txCount: "50000" };

test("token heuristics flag spam with reasons; allowlist and trusted_tokens are never flagged", () => {
  const checks = assessRows([EASE, WETH, LURE, REAL], { network: "mainnet" });
  assert.deepEqual(checks[0].reasons.sort(), ["implausible_tvl_usd", "symbol_contains_url_or_domain", "tvl_without_trading_volume"].sort());
  assert.equal(checks[1].flagged, false); assert.equal(checks[1].allowlisted, true);
  assert.ok(checks[2].reasons.includes("name_contains_url_or_domain") && checks[2].reasons.includes("name_contains_lure_word") && checks[2].reasons.includes("low_activity"));
  assert.equal(checks[3].flagged, false);
  const t = normalizeTrusted([EASE.id.toUpperCase().replace("0X", "0x")]);
  assert.ok(t.ok);
  assert.equal(assessRows([EASE], { network: "mainnet", trusted: t.set })[0].flagged, false);
  assert.equal(normalizeTrusted(["nope"]).ok, false);
  // Pools: implausible TVL with no volume, and lure token symbols on either side.
  const pools = assessRows([
    { id: "0xp1", totalValueLockedUSD: "1110167010695.78", volumeUSD: "0", txCount: "4", token0: { id: "0xaaa", symbol: "ease.org" }, token1: { id: WETH.id, symbol: "WETH" } },
    { id: "0xp2", totalValueLockedUSD: "365193615.49", volumeUSD: "608856479188.70", txCount: "12485850", token0: { id: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC" }, token1: { id: WETH.id, symbol: "WETH" } },
  ], { network: "mainnet", kind: "pool" });
  assert.ok(pools[0].reasons.includes("token0_symbol_contains_url_or_domain") && pools[0].reasons.includes("implausible_tvl_usd") && pools[0].reasons.includes("low_activity"));
  assert.equal(pools[1].flagged, false); assert.equal(pools[1].allowlisted, true);
});

test("push-down reorders but never drops; flag_only keeps order; off disables", () => {
  const rows = [EASE, WETH, LURE, REAL];
  const pushed = applyTokenQuality(rows, { network: "mainnet", collection: "tokens" });
  assert.equal(pushed.rows.length, 4);
  assert.deepEqual(pushed.rows.map((r) => r.symbol), ["WETH", "PEPE", "ease.org", "CLAIM"]);
  assert.equal(pushed.report.flagged_count, 2);
  assert.equal(pushed.report.reordered, true);
  assert.deepEqual(pushed.report.flagged.map((f) => f.original_index), [0, 2]);
  const flagOnly = applyTokenQuality(rows, { network: "mainnet", handling: "flag_only", collection: "tokens" });
  assert.deepEqual(flagOnly.rows, rows);
  assert.equal(flagOnly.report.reordered, false);
  assert.equal(applyTokenQuality(rows, { network: "mainnet", handling: "off" }).report, null);
  const allBad = applyTokenQuality([EASE, LURE], { network: "mainnet", collection: "tokens" });
  assert.deepEqual(allBad.rows, [EASE, LURE]);
  assert.equal(allBad.report.flagged_count, 2);
});

test("query_for_goal flags spam tokens in executed results, over-fetching only when first is implicit", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  const tokenProbe = probe({ entity: "Token", collection: "tokens",
    fields: [["id", "SCALAR", "ID"], ["symbol", "SCALAR", "String"], ["name", "SCALAR", "String"], ["volumeUSD", "SCALAR", "BigDecimal"], ["totalValueLockedUSD", "SCALAR", "BigDecimal"], ["txCount", "SCALAR", "BigInt"]],
    orderBy: ["id", "totalValueLockedUSD", "volumeUSD"] });
  responder = (url, q) => q.includes("__type") ? { data: tokenProbe } : { data: { _meta: { block: { number: 9, timestamp: now() } }, tokens: [EASE, WETH, LURE, REAL] } };
  const out = await HANDLERS.query_for_goal({ goal: "top Uniswap v3 tokens by TVL on Ethereum", validate_schema: true, execute: true });
  assert.equal(out.executed, true);
  assert.match(out.query, /tokens\(orderBy: totalValueLockedUSD, orderDirection: desc, first: 10\)/);
  assert.equal(out.goal_mapping.first_fetched, 10);
  assert.equal(out.first, 5);
  assert.deepEqual(out.result.data.tokens.map((r) => r.symbol), ["WETH", "PEPE", "ease.org", "CLAIM"]);
  assert.equal(out.token_quality.flagged_count, 2);
  assert.match(out.token_quality.caveat, /Heuristic/);
  assert.equal(out.token_quality_plan.applies, true);

  requests = [];
  const explicit = await HANDLERS.query_for_goal({ goal: "top Uniswap v3 tokens by TVL on Ethereum", first: 3, validate_schema: true, execute: true, spam_handling: "flag_only" });
  assert.match(explicit.query, /first: 3/);
  assert.deepEqual(explicit.result.data.tokens.map((r) => r.symbol), ["ease.org", "WETH", "CLAIM", "PEPE"]);
  assert.equal(explicit.token_quality.reordered, false);
  assert.ok((await HANDLERS.query_for_goal({ goal: "tokens", spam_handling: "drop" })).error);
  assert.ok((await HANDLERS.query_for_goal({ goal: "tokens", trusted_tokens: ["0x12"] })).error);
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY));
});

test("pool plans select token symbols for spam checks; chain words late in long goals are honoured", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  const poolProbe = probe({ entity: "Pool", collection: "pools",
    fields: [["id", "SCALAR", "ID"], ["totalValueLockedUSD", "SCALAR", "BigDecimal"], ["volumeUSD", "SCALAR", "BigDecimal"], ["txCount", "SCALAR", "BigInt"], ["feeTier", "SCALAR", "BigInt"], ["token0", "OBJECT", "Token"], ["token1", "OBJECT", "Token"]],
    orderBy: ["id", "totalValueLockedUSD"] });
  responder = () => ({ data: poolProbe });
  const out = await HANDLERS.query_for_goal({ goal: "top Uniswap v3 pools by TVL on Ethereum", first: 2, validate_schema: true });
  assert.match(out.query, /token0 \{\s*id\s*symbol\s*name\s*\}/);
  const base = await HANDLERS.recommend_subgraph({ goal: "top Uniswap v3 tokens by volume on Base" });
  assert.equal(base.inferred_chain, "base");
  assert.ok(base.recommendations.every((r) => r.network === "base"));
});
