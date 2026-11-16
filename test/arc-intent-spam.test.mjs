// 0.13.5 regressions: queryable chains are never hidden by snapshot signals, "pools
// containing <token>" maps to a token filter, spam heuristics catch bogus TVL/supply,
// and keyless plans use the bundled schema-family catalog. MOCKED gateway only.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parse } from "graphql";
import { HANDLERS, PINNED_NPX_PACKAGE, resetHealthObservationsForTests } from "../src/index.js";
import { assessRows, applyTokenQuality, resolveTokenSymbol } from "../src/token-quality.js";
import { parseGoal, planFromBundledCatalog } from "../src/goal-query.js";
import { readFileSync } from "node:fs";

const KEYS = ["THE_GRAPH_STUDIO_API_KEY", "GRAPH_STUDIO_API_KEY", "GATEWAY_API_KEY", "SUBGRAPH_REGISTRY_MOCK_GATEWAY"];
const FAKE_KEY = "arc-intent-spam-fake-key-456";
const originalFetch = globalThis.fetch;
const saved = { ...process.env };
let requests;
let responder;
beforeEach(() => {
  resetHealthObservationsForTests();
  for (const k of KEYS) delete process.env[k];
  requests = [];
  responder = () => ({ data: { _meta: { block: { number: 1, timestamp: 1 } } } });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return new Response(JSON.stringify(responder(JSON.parse(options.body).query, requests.length, url)), { status: 200 });
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
const POOL_PROBE = {
  q: { fields: [
    { name: "pools", args: [{ name: "first", defaultValue: "100", type: T("SCALAR", "Int") }], type: T("OBJECT", "Pool", { list: true, nonNull: true }) },
    { name: "_meta", args: [], type: T("OBJECT", "_Meta_") },
  ] },
  e: { name: "Pool", fields: [["id", "SCALAR", "ID"], ["totalValueLockedUSD", "SCALAR", "BigDecimal"], ["volumeUSD", "SCALAR", "BigDecimal"], ["txCount", "SCALAR", "BigInt"], ["token0", "OBJECT", "Token"], ["token1", "OBJECT", "Token"]]
    .map(([name, kind, type]) => ({ name, type: T(kind, type, { nonNull: name === "id" }) })) },
  o: { enumValues: ["id", "totalValueLockedUSD", "volumeUSD", "txCount"].map((name) => ({ name })) },
  f: { inputFields: [["id", "ID"], ["token0", "String"], ["token1", "String"], ["totalValueLockedUSD_gte", "BigDecimal"]].map(([name, type]) => ({ name, type: T("SCALAR", type) })) },
  i: null,
};
const META = { _meta: { deployment: "x", hasIndexingErrors: false, block: { number: 9, timestamp: Math.floor(Date.now() / 1000) } } };
const roots = (q) => parse(q).definitions[0].selectionSet.selections.filter((s) => s.name.value !== "_meta");
const whereOf = (q) => roots(q)[0].arguments.find((a) => a.name.value === "where");

test("Arc: a gateway 'no allocations' rejection falls back to the next queryable deployment", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  responder = (query, n) => n === 1
    ? { errors: [{ message: "auth error: no allocations found for deployment" }] }
    : query.includes("__type") ? { data: POOL_PROBE } : { data: { pools: [{ id: "0x1" }], ...META } };
  const out = await HANDLERS.query_for_goal({ goal: "Uniswap V4 pools on Arc", chain: "arc", include_unserved: true, validate_schema: true, execute: true });
  assert.equal(out.goal_mapping.skipped_deployments[0].reason, "not_serving");
  assert.equal(out.goal_mapping.skipped_deployments[0].display_name, "Uniswap V4 - Arc");
  assert.notEqual(out.selected.display_name, "Uniswap V4 - Arc");
  assert.equal(out.selected.network, "arc");
  assert.equal(out.validation.gateway_execution, "succeeded");
  assert.ok(requests.length <= 6);
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY));
});

test("Arc: snapshot signals rank, never hide - a plan exists by default and carries a note", async () => {
  const out = await HANDLERS.query_for_goal({ goal: "Uniswap V4 pools on Arc", chain: "arc" });
  assert.equal(out.selected.network, "arc");
  assert.ok(out.query, "plan returned without include_unserved/include_denied");
  const hidden = await HANDLERS.query_for_goal({ goal: "OHLCV candles on Arc", chain: "arc" });
  assert.equal(hidden.selected.network, "arc");
  assert.match(hidden.goal_mapping.unmet.join(" "), /not a health signal/);
  assert.equal(requests.length, 0);
});

test("pools containing WETH map to a token0/token1 filter with per-chain addresses", async () => {
  const cases = [
    ["pools containing WETH on Optimism", "0x4200000000000000000000000000000000000006"],
    ["pools containing WETH on Ethereum", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
    ["top pools containing ETH on Base", "0x4200000000000000000000000000000000000006"],
  ];
  for (const [goal, addr] of cases) {
    const out = await HANDLERS.query_for_goal({ goal, first: 3 });
    assert.ok(out.query, goal);
    assert.equal(roots(out.query)[0].name.value, "pools");
    const w = whereOf(out.query).value;
    assert.equal(w.fields[0].name.value, "or", goal);
    assert.deepEqual(w.fields[0].value.values.map((v) => v.fields[0].name.value), ["token0", "token1"]);
    assert.ok(w.fields[0].value.values.every((v) => v.fields[0].value.value === addr), goal);
    assert.equal(out.goal_mapping.resolved_tokens[0].address, addr);
  }
  const unknown = await HANDLERS.query_for_goal({ goal: "pools containing FOOBARX on Ethereum" });
  assert.equal(unknown.query, null, "an unfilterable request never returns unfiltered rows");
  assert.equal(requests.length, 0);
});

test("token symbols resolve only for known majors on known chains", () => {
  assert.equal(resolveTokenSymbol("weth", "mainnet").address, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  assert.equal(resolveTokenSymbol("ETH", "optimism").symbol, "WETH");
  assert.ok(resolveTokenSymbol("FOOBARX", "mainnet").error);
  assert.ok(resolveTokenSymbol("WETH", "no-such-chain").error);
  const intent = parseGoal("pools containing WETH", { now: 1 });
  assert.deepEqual(intent.token_symbols, ["WETH"]);
  assert.ok(!intent.protocol_terms.some((t) => /weth|containing/i.test(t)));
});

const base = { id: "0xa", totalValueLockedUSD: "3.7e25", volumeUSD: "1000", txCount: "3", token0: { id: "0x1", symbol: "AAA" }, token1: { id: "0x2", symbol: "BBB" } };
test("spam: TVL/transaction, TVL/volume, absolute cap and total supply plausibility", () => {
  const rows = [
    base,
    { ...base, id: "0xb", totalValueLockedUSD: "2.65e10", volumeUSD: "50", txCount: "20" },
    { ...base, id: "0xc", totalValueLockedUSD: "2000000", volumeUSD: "9000000", txCount: "90000" },
  ];
  const [a, b, c] = assessRows(rows, { network: "base", kind: "pool" });
  assert.ok(a.flagged && a.reasons.includes("implausible_tvl_usd"));
  assert.ok(b.flagged && b.reasons.includes("tvl_per_transaction_implausible"));
  assert.equal(c.flagged, false);
  const cod = { id: "0xe", totalValueLockedUSD: "1136457759.29", volumeUSD: "97959579.7", txCount: "73755", token0: { id: "0x4200000000000000000000000000000000000006", symbol: "WETH" }, token1: { id: "0x9999999999999999999999999999999999999999", symbol: "COD" } };
  const [co] = assessRows([cod], { network: "base", kind: "pool" });
  assert.ok(co.flagged && co.reasons.includes("extreme_tvl_with_unlisted_token"));
  const realBig = { ...cod, totalValueLockedUSD: "400000000", token1: { id: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC" } };
  assert.equal(assessRows([realBig], { network: "base", kind: "pool" })[0].flagged, false);
  const apple = { id: "0xd", symbol: "Apple", name: "Apple", totalSupply: "2.1e33", decimals: "18", volumeUSD: "10", totalValueLockedUSD: "16000000", txCount: "30" };
  const [ap] = assessRows([apple], { network: "polygon", kind: "token" });
  assert.ok(ap.flagged && ap.reasons.includes("implausible_total_supply"));
});

test("spam: rows are never dropped; flag_only and off still work; all-flagged is reordered by volumeUSD", () => {
  const rows = [base, { ...base, id: "0xb", totalValueLockedUSD: "9e24", volumeUSD: "500" }, { ...base, id: "0xc", totalValueLockedUSD: "8e24", volumeUSD: "90000" }];
  const r = applyTokenQuality(rows, { network: "base", kind: "pool", collection: "pools" });
  assert.equal(r.rows.length, 3);
  assert.equal(r.report.all_flagged, true);
  assert.deepEqual(r.rows.map((x) => x.id), ["0xc", "0xa", "0xb"]);
  assert.ok(r.report.reordered_by);
  const flagOnly = applyTokenQuality(rows, { network: "base", kind: "pool", collection: "pools", handling: "flag_only" });
  assert.deepEqual(flagOnly.rows.map((x) => x.id), ["0xa", "0xb", "0xc"]);
  const off = applyTokenQuality(rows, { network: "base", kind: "pool", collection: "pools", handling: "off" });
  assert.equal(off.report, null);
});

test("every row flagged on the first deployment falls back to the next one", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  let executions = 0;
  responder = (query) => {
    if (query.includes("__type")) return { data: POOL_PROBE };
    executions++;
    const rows = executions === 1
      ? [base, { ...base, id: "0xb" }]
      : [{ ...base, id: "0xgood", totalValueLockedUSD: "4000000", volumeUSD: "9000000", txCount: "90000" }];
    return { data: { pools: rows, ...META } };
  };
  const out = await HANDLERS.query_for_goal({ goal: "top Uniswap V3 pools by TVL on Base", validate_schema: true, execute: true });
  assert.ok(out.goal_mapping.skipped_deployments.some((s) => s.reason === "all_rows_flagged_as_spam"), JSON.stringify(out.goal_mapping.skipped_deployments));
  assert.equal(out.result.data.pools[0].id, "0xgood");
  assert.ok(requests.length <= 6);
});

test("keyless plans use the bundled family catalog with timestamp/TVL ordering", async () => {
  const swaps = await HANDLERS.query_for_goal({ goal: "latest Uniswap v3 swaps on Ethereum", first: 3 });
  const root = roots(swaps.query)[0];
  const args = Object.fromEntries(root.arguments.map((a) => [a.name.value, a.value.value]));
  assert.equal(args.orderBy, "timestamp");
  assert.equal(args.orderDirection, "desc");
  const fields = root.selectionSet.selections.map((f) => f.name.value);
  assert.ok(fields.includes("amountUSD") && fields.includes("timestamp"));
  assert.equal(swaps.goal_mapping.field_source, "bundled_family_catalog");
  assert.equal(swaps.goal_mapping.schema_source, "bundled_family_catalog");
  assert.match(swaps.goal_mapping.unmet.join(" "), /not live-checked/);
  const pools = await HANDLERS.query_for_goal({ goal: "top Uniswap v3 pools on Ethereum by TVL" });
  assert.match(pools.query, /orderBy: totalValueLockedUSD/);
  assert.match(pools.query, /volumeUSD/);
  const positions = await HANDLERS.query_for_goal({ goal: "Uniswap v3 positions on Ethereum" });
  assert.equal(roots(positions.query)[0].name.value, "positions");
  assert.ok(roots(positions.query)[0].selectionSet.selections.length > 1);
  assert.equal(planFromBundledCatalog({ intent: parseGoal("daily ens domains", { now: 1 }), entity: { name: "Domain" }, entities: [{ name: "Domain" }], first: 3 }), null);
  assert.equal(requests.length, 0);
});

test("search keeps word-boundary matches beyond the SQL candidate pool (ens)", async () => {
  const out = await HANDLERS.search_subgraphs({ query: "ens", limit: 5 });
  assert.ok(out.subgraphs.slice(0, 3).some((r) => /\bens\b/i.test(r.display_name || r.name || "")), out.subgraphs.map((r) => r.display_name || r.name).join(","));
});

test("pinned npx package equals package.json version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PINNED_NPX_PACKAGE, `subgraph-registry-mcp@${pkg.version}`);
});
