// Goal-specific query planning: keyless (registry data only) and with a
// caller-supplied key against a MOCKED gateway. No real network or key.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parse } from "graphql";
import { collectionName, parseGoal, planWithSchema, schemaProbeQuery } from "../src/goal-query.js";
import { HANDLERS } from "../src/index.js";

const KEYS = ["THE_GRAPH_STUDIO_API_KEY", "GRAPH_STUDIO_API_KEY", "GATEWAY_API_KEY", "SUBGRAPH_REGISTRY_MOCK_GATEWAY"];
const FAKE_KEY = "goal-test-secret-value-123";
const originalFetch = globalThis.fetch;
const saved = { ...process.env };
let requests;
let responder;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  requests = [];
  responder = () => ({ data: { _meta: { block: { number: 1, timestamp: 1 } } } });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    const body = responder(JSON.parse(options.body).query, requests.length);
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
function probe({ entity, collection, fields, orderBy, filter, args = [], interval = null }) {
  return {
    q: { fields: [
      { name: collection, args: [{ name: "first", defaultValue: "100", type: T("SCALAR", "Int") }, ...args], type: T("OBJECT", entity, { list: true, nonNull: true }) },
      { name: "_meta", args: [], type: T("OBJECT", "_Meta_") },
    ] },
    e: { name: entity, fields: fields.map(([name, kind, type]) => ({ name, type: T(kind, type, { nonNull: name === "id" }) })) },
    o: { enumValues: orderBy.map((name) => ({ name })) },
    f: { inputFields: filter.map(([name, type]) => ({ name, type: T("SCALAR", type) })) },
    i: interval ? { enumValues: interval.map((name) => ({ name })) } : null,
  };
}
const SWAP_PROBE = probe({ entity: "Swap", collection: "swaps",
  fields: [["id", "SCALAR", "ID"], ["timestamp", "SCALAR", "BigInt"], ["amountUSD", "SCALAR", "BigDecimal"], ["amount0", "SCALAR", "BigDecimal"], ["origin", "SCALAR", "Bytes"], ["pool", "OBJECT", "Pool"], ["transaction", "OBJECT", "Transaction"]],
  orderBy: ["id", "timestamp", "amountUSD"], filter: [["id", "ID"], ["timestamp_gte", "BigInt"], ["pool", "String"], ["origin", "Bytes"]] });

const roots = (q) => parse(q).definitions[0].selectionSet.selections.filter((s) => s.name.value !== "_meta");

test("collection names follow graph-node inflection used by the crawler", () => {
  assert.deepEqual(["Pool", "Factory", "UniswapFactory", "Users", "Address", "Candle", "PoolDayData", "Day"].map(collectionName),
    ["pools", "factories", "uniswapFactories", "users", "addresses", "candles", "poolDayDatas", "days"]);
});

test("goal parsing extracts entity intent, ids, ordering, time, addresses and row counts", () => {
  const now = 1_700_000_000;
  const ids = parseGoal("Uniswap V4 pool IDs on Arc", { now, isChain: (w) => w === "arc" });
  assert.equal(ids.primary, "pool");
  assert.equal(ids.ids_only, true);
  assert.deepEqual(ids.protocol_terms, ["uniswap", "v4"]);
  const candles = parseGoal("OHLCV candles for Uniswap v4 pools", { now });
  assert.equal(candles.primary, "candle");
  assert.deepEqual(candles.secondary, ["pool"]);
  const swaps = parseGoal("latest swaps on Ethereum over the last 7 days", { now });
  assert.equal(swaps.ordering, "latest");
  assert.equal(swaps.time_range.from, now - 7 * 86400);
  assert.equal(swaps.first_from_goal, null, "a time window is not a row count");
  assert.equal(parseGoal("top 3 pools by tvl", { now }).first_from_goal, 3);
  const addr = parseGoal("swaps for pool 0x88E6A0c2dDD26FEEb64F039a2c41296FcB3f5640", { now });
  assert.deepEqual(addr.addresses, [{ address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", context: "pool" }]);
  assert.equal(parseGoal("uniswap v3 on ethereum", { now }).primary, null);
});

test("observed failure: pool IDs return pools{id}, not tokens or pool-manager counters (keyless, no network)", async () => {
  for (const [args, network] of [[{ goal: "Uniswap V4 pool IDs on Arc", chain: "arc", first: 3 }, "arc"], [{ goal: "Uniswap v3 liquidity pool ids on Ethereum", first: 3 }, "mainnet"]]) {
    const out = await HANDLERS.query_for_goal(args);
    const [root] = roots(out.query);
    assert.equal(root.name.value, "pools");
    assert.deepEqual(root.selectionSet.selections.map((f) => f.name.value), ["id"]);
    assert.equal(out.selected.network, network);
    assert.equal(out.goal_mapping.confidence, "medium");
    assert.equal(out.goal_mapping.goal_specific, true);
    assert.equal(out.validation.live_schema, "not_checked");
    assert.ok(out.goal_mapping.rationale.length && out.goal_mapping.alternatives.length);
    assert.equal(out.executed, false);
  }
  assert.equal(requests.length, 0);
});

test("observed failure: OHLCV intent explains hidden candle deployment, then maps to candles on explicit opt-in", async () => {
  const goal = "OHLCV candles for Uniswap v4 pools on Arc";
  const hidden = await HANDLERS.query_for_goal({ goal, chain: "arc" });
  assert.equal(hidden.query, null, "no misleading poolManagers query");
  assert.equal(hidden.request, null);
  assert.ok(hidden.goal_mapping.hidden_candidates.some((c) => c.entity === "Candle" && c.network === "arc"));
  assert.match(hidden.goal_mapping.unmet.join(" "), /NOT proof they cannot be queried/);
  const opted = await HANDLERS.query_for_goal({ goal, chain: "arc", include_denied: true, first: 2 });
  assert.equal(roots(opted.query)[0].name.value, "candles");
  assert.equal(opted.selected.denied_indexing_rewards, true);
  assert.match(opted.goal_mapping.unmet.join(" "), /interval argument/);
  assert.equal(requests.length, 0);
});

test("other goals and chains map to the requested entity", async () => {
  for (const [args, collection] of [
    [{ goal: "latest Uniswap v3 swaps on Ethereum" }, "swaps"],
    [{ goal: "Uniswap v3 daily pool volume on Ethereum" }, "poolDayDatas"],
    [{ goal: "Aave v3 liquidations on Ethereum" }, "liquidates"],
    [{ goal: "Aave v3 borrows on Polygon" }, "borrows"],
    [{ goal: "Uniswap v3 positions on Arbitrum" }, "positions"],
    [{ goal: "Uniswap v3 hourly token data on Ethereum" }, "tokenHourDatas"],
    [{ goal: "ENS domain names" }, "domains"],
  ]) {
    const out = await HANDLERS.query_for_goal({ ...args, first: 2 });
    assert.equal(roots(out.query)[0].name.value, collection, args.goal);
  }
  const ens = await HANDLERS.query_for_goal({ goal: "ENS domain names", first: 2 });
  const fields = roots(ens.query)[0].selectionSet.selections.map((f) => f.name.value);
  assert.ok(!fields.includes("parent") && !fields.includes("subdomains"), "likely relations need sub-selections and are dropped keylessly");
  const latest = await HANDLERS.query_for_goal({ goal: "latest Uniswap v3 swaps on Ethereum" });
  assert.match(latest.goal_mapping.unmet.join(" "), /ordering/);
  assert.equal(requests.length, 0);
});

test("address goals filter by entity id keylessly; absent entities return no query and never execute", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  const out = await HANDLERS.query_for_goal({ goal: "Uniswap v3 pool 0x88E6A0c2dDD26FEEb64F039a2c41296FcB3f5640 on Ethereum", first: 1 });
  assert.match(out.query, /where: \{id: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"\}/);
  const none = await HANDLERS.query_for_goal({ goal: "Uniswap v3 liquidations on Ethereum", execute: true });
  assert.equal(none.query, null);
  assert.equal(none.goal_mapping.confidence, "none");
  assert.equal(none.execution_skipped, "no_confident_goal_query");
  assert.equal(none.executed, false);
  assert.equal(requests.length, 0);
});

test("goals without entity intent keep the stored starter, labelled generic", async () => {
  const out = await HANDLERS.query_for_goal({ goal: "uniswap v3 on ethereum", first: 2 });
  assert.equal(out.goal_mapping.confidence, "generic_starter");
  assert.equal(out.goal_mapping.goal_specific, false);
  assert.match(out.query, /first: 2/);
});

test("keyless onboarding is a human handoff with placeholders only", async () => {
  const out = await HANDLERS.query_for_goal({ goal: "Uniswap V4 pool IDs on Arc", chain: "arc" });
  const o = out.onboarding;
  assert.equal(o.who, "human_operator");
  assert.match(o.relay_to_human, /Studio account you manage/);
  assert.match(o.relay_to_human, /THE_GRAPH_STUDIO_API_KEY/);
  assert.match(o.relay_to_human, /don't paste the key/);
  assert.match(o.relay_to_human, /100,000 free queries per month; check your plan/);
  assert.equal(o.mcp_config_example.mcpServers["subgraph-registry"].env.THE_GRAPH_STUDIO_API_KEY, "<set from your host's secret manager>");
  assert.match(o.curl_example, /Authorization: Bearer \$THE_GRAPH_STUDIO_API_KEY/);
  assert.match(o.curl_example, /gateway\.thegraph\.com\/api\/deployments\/id\//);
  assert.match(o.alternatives, /never signs or auto-pays/);
  assert.ok(!/sign up|create an account|captcha|email/i.test(JSON.stringify(o)), "agents are not told to self-provision");
  assert.equal(out.next_action.api_key.who, "human_operator");
  const denied = await HANDLERS.query_for_goal({ goal: "Uniswap V4 pool IDs on Arc", chain: "arc", execute: true });
  assert.equal(denied.error, "credentials_required");
  assert.ok(denied.onboarding.relay_to_human);
  assert.equal(requests.length, 0);
});

test("with a caller key, preparation stays local and offers an explicit validate+execute call", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  const out = await HANDLERS.query_for_goal({ goal: "Uniswap V4 pool IDs on Arc", chain: "arc" });
  assert.equal(out.onboarding, undefined);
  assert.deepEqual(out.next_action.execute_call.arguments, { goal: "Uniswap V4 pool IDs on Arc", chain: "arc", first: 5, validate_schema: true, execute: true });
  assert.equal(requests.length, 0);
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY));
});

test("validate_schema uses one scoped probe, adds typed ordering/filters, then one execution; key never echoed", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  responder = (query) => query.includes("__type") ? { data: SWAP_PROBE } : { data: { swaps: [{ id: "0xabc" }], _meta: { deployment: "x", hasIndexingErrors: false, block: { number: 7, timestamp: 1 } } } };
  const out = await HANDLERS.query_for_goal({ goal: "latest Uniswap v3 swaps on Ethereum in the last 7 days", first: 2, validate_schema: true, execute: true });
  assert.equal(requests.length, 2);
  assert.match(JSON.parse(requests[0].body).query, /__type\(name: "Swap"\)/);
  for (const r of requests) {
    assert.equal(new URL(r.url).hostname, "gateway.thegraph.com");
    assert.equal(r.redirect, "error");
    assert.equal(r.headers.Authorization, `Bearer ${FAKE_KEY}`);
  }
  const [root] = roots(out.query);
  assert.equal(root.name.value, "swaps");
  const args = Object.fromEntries(root.arguments.map((a) => [a.name.value, a.value]));
  assert.equal(args.orderBy.value, "timestamp");
  assert.equal(args.orderDirection.value, "desc");
  assert.equal(args.where.fields[0].name.value, "timestamp_gte");
  assert.equal(args.where.fields[0].value.kind, "StringValue", "BigInt filter values are strings");
  assert.equal(args.first.value, "2");
  const sel = root.selectionSet.selections.map((f) => f.name.value);
  assert.ok(sel.includes("amountUSD") && sel.includes("timestamp") && !sel.includes("transaction"));
  assert.equal(JSON.parse(requests[1].body).query, out.query);
  assert.equal(out.goal_mapping.confidence, "high");
  assert.equal(out.validation.live_schema, "validated_fields_and_arguments");
  assert.equal(out.validation.gateway_execution, "succeeded");
  assert.equal(out.gateway_requests, 2);
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY));
});

test("probe auth/GraphQL failures stop before execution and never claim validation", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  responder = () => ({ errors: [{ message: "missing authorization header" }] });
  const out = await HANDLERS.query_for_goal({ goal: "latest Uniswap v3 swaps on Ethereum", validate_schema: true, execute: true });
  assert.equal(requests.length, 1);
  assert.equal(out.validation.live_schema, "failed");
  assert.equal(out.query, null);
  assert.equal(out.execution_attempted, false);
  assert.equal(out.execution_skipped, "no_confident_goal_query");
  assert.equal(out.goal_mapping.live_schema_errors[0].auth_error, true);
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY));
});

test("live planning supplies required aggregation intervals and rejects unknown fields", () => {
  const intent = parseGoal("daily OHLCV candles", { now: 1 });
  const candleProbe = probe({ entity: "Candle", collection: "candles",
    fields: [["id", "SCALAR", "Int8"], ["timestamp", "SCALAR", "Timestamp"], ["open", "SCALAR", "BigDecimal"], ["close", "SCALAR", "BigDecimal"]],
    orderBy: ["id", "timestamp"], filter: [["timestamp_gte", "Timestamp"]],
    args: [{ name: "interval", defaultValue: null, type: T("ENUM", "Aggregation_interval", { nonNull: true }) }], interval: ["hour", "day"] });
  const plan = planWithSchema({ intent, entity: { name: "Candle" }, probe: candleProbe, first: 3 });
  assert.deepEqual(plan.errors, []);
  assert.match(plan.query, /candles\(interval: day, orderBy: timestamp, orderDirection: desc, first: 3\)/);
  const missing = planWithSchema({ intent, entity: { name: "Candle" }, probe: { ...candleProbe, q: { fields: [] } }, first: 3 });
  assert.match(missing.errors[0], /no Query collection/);
  const required = planWithSchema({ intent, entity: { name: "Candle" }, first: 3, probe: { ...candleProbe,
    q: { fields: [{ ...candleProbe.q.fields[0], args: [{ name: "secret", defaultValue: null, type: T("SCALAR", "String", { nonNull: true }) }] }] } } });
  assert.match(required.errors[0], /required argument secret/);
  assert.throws(() => schemaProbeQuery('Pool"){x}'));
});

test("new inputs are validated before any work", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  for (const args of [{ goal: "pools", validate_schema: "true" }, { goal: "pools", include_denied: 1 }, { goal: "pools", first: 0 }]) {
    assert.ok((await HANDLERS.query_for_goal(args)).error);
  }
  assert.equal(requests.length, 0);
});

test("live relation filters: owner context, token0/token1 OR, and dropped filters block execution", async () => {
  const domainProbe = probe({ entity: "Domain", collection: "domains",
    fields: [["id", "SCALAR", "ID"], ["name", "SCALAR", "String"], ["createdAt", "SCALAR", "BigInt"], ["owner", "OBJECT", "Account"]],
    orderBy: ["id", "createdAt"], filter: [["id", "ID"], ["owner", "String"], ["createdAt_gte", "BigInt"]] });
  const owner = "0x983110309620d911731ac0932219af06091b6744";
  const owned = planWithSchema({ intent: parseGoal(`ENS domains owned by ${owner}`, { now: 1 }), entity: { name: "Domain" }, probe: domainProbe, first: 2 });
  assert.deepEqual(owned.errors, []);
  assert.deepEqual(owned.where, { owner });
  assert.deepEqual(owned.blocking_unmet, []);

  const poolFilter = [["id", "ID"], ["token0", "String"], ["token1", "String"]];
  const poolProbe = (filter) => probe({ entity: "Pool", collection: "pools",
    fields: [["id", "SCALAR", "ID"], ["totalValueLockedUSD", "SCALAR", "BigDecimal"]], orderBy: ["id", "totalValueLockedUSD"], filter });
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const intent = parseGoal(`Uniswap v3 pools with token ${weth}`, { now: 1 });
  const both = planWithSchema({ intent, entity: { name: "Pool" }, probe: poolProbe([...poolFilter, ["or", "Pool_filter"]]), first: 2 });
  assert.deepEqual(both.errors, []);
  assert.match(both.query, new RegExp(`or: \\[\\{token0: "${weth}"\\}, \\{token1: "${weth}"\\}\\]`));
  assert.deepEqual(both.where, { or: [{ token0: weth }, { token1: weth }] });
  const one = planWithSchema({ intent, entity: { name: "Pool" }, probe: poolProbe(poolFilter), first: 2 });
  assert.deepEqual(one.where, { token0: weth });
  assert.ok(one.unmet.some((u) => /other token side/.test(u)));

  const noField = planWithSchema({ intent: parseGoal(`ENS domains owned by ${owner}`, { now: 1 }), entity: { name: "Domain" },
    probe: probe({ entity: "Domain", collection: "domains", fields: [["id", "SCALAR", "ID"]], orderBy: ["id"], filter: [["id", "ID"]] }), first: 2 });
  assert.deepEqual(noField.blocking_unmet, [`address ${owner}`]);

  // Keyless plan with a key but no validate_schema: the owner filter cannot be
  // applied, so execute:true must not spend a request on unfiltered rows.
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("no network in tests"); };
  try {
    const out = await HANDLERS.query_for_goal({ goal: `ENS domains owned by ${owner}`, first: 2, execute: true });
    assert.equal(out.execution_skipped, "requested_filter_not_applied");
    assert.equal(out.gateway_requests, 0);
    assert.equal(calls, 0);
    assert.deepEqual(out.goal_mapping.filters_not_applied, [`address ${owner}`]);
    assert.ok(!JSON.stringify(out).includes(FAKE_KEY));
  } finally { globalThis.fetch = realFetch; delete process.env.THE_GRAPH_STUDIO_API_KEY; }
});
