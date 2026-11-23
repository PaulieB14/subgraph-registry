// 0.13.7 regressions: Base WETH pool routing & catalog fallback, Polygon
// Apple/USDT TVL-to-volume spam rule, and Ethereum Aave V3 user positions.
// MOCKED gateway only; no live key or network.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parse } from "graphql";
import { HANDLERS, PINNED_NPX_PACKAGE, resetHealthObservationsForTests } from "../src/index.js";
import { assessRows, applyTokenQuality, normalizeTrusted } from "../src/token-quality.js";
import { parseGoal, planFromBundledCatalog, planWithSchema } from "../src/goal-query.js";
import { readFileSync } from "node:fs";

const KEYS = ["THE_GRAPH_STUDIO_API_KEY", "GRAPH_STUDIO_API_KEY", "GATEWAY_API_KEY", "SUBGRAPH_REGISTRY_MOCK_GATEWAY"];
const FAKE_KEY = "base-spam-aave-fake-key-789";
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
const roots = (q) => parse(q).definitions[0].selectionSet.selections.filter((s) => s.name.value !== "_meta");
const whereOf = (q) => roots(q)[0].arguments.find((a) => a.name.value === "where");
const META = { _meta: { deployment: "x", hasIndexingErrors: false, block: { number: 9, timestamp: Math.floor(Date.now() / 1000) } } };

test("Base: 'pools containing WETH' routes to Uniswap V3/Aerodrome family, never Naumachy Pools Base", async () => {
  const out = await HANDLERS.query_for_goal({ goal: "pools containing WETH on Base", first: 5 });
  assert.notEqual(out.selected.display_name, "Naumachy Pools Base");
  assert.equal(out.selected.network, "base");
  assert.equal(out.goal_mapping.field_source, "bundled_family_catalog");
  assert.equal(out.goal_mapping.schema_family, "uniswap_v3");
  assert.equal(out.goal_mapping.resolved_tokens[0].address, "0x4200000000000000000000000000000000000006");
  const w = whereOf(out.query).value;
  assert.equal(w.fields[0].name.value, "or");
  assert.deepEqual(w.fields[0].value.values.map((v) => v.fields[0].name.value), ["token0", "token1"]);
  assert.equal(requests.length, 0);
});

test("Base: falls back to Uniswap V3 Base when top candidate lacks token0/token1 filter in live schema", async () => {
  process.env.THE_GRAPH_STUDIO_API_KEY = FAKE_KEY;
  const noFilterPoolProbe = {
    q: { fields: [{ name: "pools", args: [{ name: "first", defaultValue: "100", type: T("SCALAR", "Int") }], type: T("OBJECT", "Pool", { list: true, nonNull: true }) }, { name: "_meta", args: [], type: T("OBJECT", "_Meta_") }] },
    e: { name: "Pool", fields: [["id", "SCALAR", "ID"], ["name", "SCALAR", "String"]].map(([name, kind, type]) => ({ name, type: T(kind, type, { nonNull: name === "id" }) })) },
    o: { enumValues: ["id"].map((name) => ({ name })) },
    f: { inputFields: [["id", "ID"]].map(([name, type]) => ({ name, type: T("SCALAR", type) })) },
    i: null,
  };
  const uniPoolProbe = {
    q: noFilterPoolProbe.q,
    e: { name: "Pool", fields: [["id", "SCALAR", "ID"], ["totalValueLockedUSD", "SCALAR", "BigDecimal"], ["volumeUSD", "SCALAR", "BigDecimal"], ["txCount", "SCALAR", "BigInt"], ["token0", "OBJECT", "Token"], ["token1", "OBJECT", "Token"]].map(([name, kind, type]) => ({ name, type: T(kind, type, { nonNull: name === "id" }) })) },
    o: { enumValues: ["id", "totalValueLockedUSD", "volumeUSD"].map((name) => ({ name })) },
    f: { inputFields: [["id", "ID"], ["token0", "String"], ["token1", "String"], ["or", "String"]].map(([name, type]) => ({ name, type: T("SCALAR", type) })) },
    t: { name: "Token", fields: [["id", "SCALAR", "ID"], ["symbol", "SCALAR", "String"], ["name", "SCALAR", "String"]].map(([name, kind, type]) => ({ name, type: T(kind, type) })) },
    i: null,
  };
  let probes = 0;
  responder = (query) => {
    if (query.includes("__type")) {
      probes++;
      return { data: probes === 1 ? noFilterPoolProbe : uniPoolProbe };
    }
    return { data: { pools: [{ id: "0xpool1", totalValueLockedUSD: "50000000", volumeUSD: "100000000", txCount: "50000", token0: { id: "0x4200000000000000000000000000000000000006", symbol: "WETH" }, token1: { id: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC" } }], ...META } };
  };
  const out = await HANDLERS.query_for_goal({ goal: "pools containing WETH on Base", first: 3, validate_schema: true, execute: true });
  assert.equal(out.executed, true);
  assert.ok(out.goal_mapping.skipped_deployments.some((s) => s.reason === "requested_filter_unsupported"));
  assert.equal(out.result.data.pools[0].token0.symbol, "WETH");
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY));
});

test("Polygon Apple/USDT ($14.9M TVL, $155k vol) is flagged and pushed down without flagging legit major pools", () => {
  const appleUsdt = {
    id: "0x8f6463fbd1e5992e14c438d61ebeec4b77b1dabd",
    totalValueLockedUSD: "14883807.56", volumeUSD: "155346.92", txCount: "13743",
    token0: { id: "0x3cbfcd1cc5016ab6aee067c309065cdf077e3e67", symbol: "Apple", name: "Apple" },
    token1: { id: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", symbol: "USDT", name: "(PoS) Tether USD" },
  };
  const wmaticUsdt = {
    id: "0x9b08288c3be4f62bbf8d1c20ac9c5e6f9467d8b7",
    totalValueLockedUSD: "1307967.67", volumeUSD: "7090937501.90", txCount: "21691449",
    token0: { id: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", symbol: "WMATIC", name: "Wrapped Matic" },
    token1: { id: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", symbol: "USDT", name: "(PoS) Tether USD" },
  };
  const usdcWethLowVolAllowlisted = {
    id: "0xmajorlow",
    totalValueLockedUSD: "5000000", volumeUSD: "10000", txCount: "100",
    token0: { id: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", symbol: "USDC" },
    token1: { id: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", symbol: "WETH" },
  };
  const usdtFelyActive = {
    id: "0xc810868393de87e0daa3b1f4e90c6738192d2a06",
    totalValueLockedUSD: "1326172.79", volumeUSD: "7631867.98", txCount: "34418",
    token0: { id: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", symbol: "USDT" },
    token1: { id: "0xee997788f625809332baabb3110bcf1ba7400824", symbol: "FELY" },
  };
  const checks = assessRows([appleUsdt, wmaticUsdt, usdcWethLowVolAllowlisted, usdtFelyActive], { network: "matic", kind: "pool" });
  assert.ok(checks[0].flagged && checks[0].reasons.includes("unlisted_token_low_volume_for_tvl"));
  assert.equal(checks[1].flagged, false);
  assert.equal(checks[2].flagged, false, "legitimate allowlisted major pools are never flagged");
  assert.equal(checks[3].flagged, false, "active unlisted pair with high volume is not flagged");

  const pushed = applyTokenQuality([appleUsdt, usdtFelyActive, wmaticUsdt], { network: "matic", kind: "pool", collection: "pools" });
  assert.equal(pushed.rows.length, 3, "rows are never deleted");
  assert.deepEqual(pushed.rows.map((r) => r.id), [usdtFelyActive.id, wmaticUsdt.id, appleUsdt.id]);

  const flagOnly = applyTokenQuality([appleUsdt, wmaticUsdt], { network: "matic", kind: "pool", collection: "pools", handling: "flag_only" });
  assert.deepEqual(flagOnly.rows.map((r) => r.id), [appleUsdt.id, wmaticUsdt.id]);
  assert.equal(flagOnly.report.flagged_count, 1);

  assert.equal(applyTokenQuality([appleUsdt, wmaticUsdt], { network: "matic", kind: "pool", collection: "pools", handling: "off" }).report, null);

  const trusted = normalizeTrusted([appleUsdt.token0.id]);
  assert.equal(assessRows([appleUsdt], { network: "matic", kind: "pool", trusted: trusted.set })[0].flagged, false);
});

test("Ethereum Aave V3 user positions pick account/balances/asset/market and filter out zero-address/zero-balance records", async () => {
  const out = await HANDLERS.query_for_goal({ goal: "Aave V3 user positions on Ethereum", first: 5 });
  assert.equal(out.selected.display_name, "Aave V3 Ethereum");
  assert.equal(out.goal_mapping.field_source, "bundled_family_catalog");
  assert.equal(out.goal_mapping.schema_family, "messari_lending");
  const [root] = roots(out.query);
  assert.equal(root.name.value, "positions");
  const selText = out.query;
  for (const want of ["balance", "account {", "asset {", "symbol", "market {", "name"]) {
    assert.ok(selText.includes(want), `missing ${want} in ${selText}`);
  }
  assert.match(selText, /orderBy: balance/);
  assert.match(selText, /balance_gt: "0"/);
  assert.match(selText, /account_not: "0x0000000000000000000000000000000000000000"/);
  assert.equal(requests.length, 0);

  // Also check live-introspection path with Market and Token relation sub-selections.
  const aaveProbe = {
    q: { fields: [{ name: "positions", args: [{ name: "first", defaultValue: "100", type: T("SCALAR", "Int") }], type: T("OBJECT", "Position", { list: true, nonNull: true }) }, { name: "_meta", args: [], type: T("OBJECT", "_Meta_") }] },
    e: { name: "Position", fields: [
      ["id", "SCALAR", "ID"], ["balance", "SCALAR", "BigInt"], ["principal", "SCALAR", "BigInt"], ["side", "SCALAR", "String"], ["isCollateral", "SCALAR", "Boolean"],
      ["account", "OBJECT", "Account"], ["asset", "OBJECT", "Token"], ["market", "OBJECT", "Market"],
    ].map(([name, kind, type]) => ({ name, type: T(kind, type, { nonNull: name === "id" }) })) },
    o: { enumValues: ["id", "balance", "principal"].map((name) => ({ name })) },
    f: { inputFields: [["id", "ID"], ["balance_gt", "BigInt"], ["account_not", "String"], ["account", "String"]].map(([name, type]) => ({ name, type: T("SCALAR", type) })) },
    t: { name: "Token", fields: [["id", "SCALAR", "ID"], ["symbol", "SCALAR", "String"], ["name", "SCALAR", "String"]].map(([name, kind, type]) => ({ name, type: T(kind, type) })) },
    mkt: { name: "Market", fields: [["id", "SCALAR", "ID"], ["name", "SCALAR", "String"]].map(([name, kind, type]) => ({ name, type: T(kind, type) })) },
    rsv: null, i: null,
  };
  const live = planWithSchema({ intent: parseGoal("Aave V3 user positions on Ethereum", { now: 1 }), entity: { name: "Position" }, probe: aaveProbe, first: 3 });
  assert.deepEqual(live.errors, []);
  assert.equal(live.where.balance_gt, "0");
  assert.equal(live.where.account_not, "0x0000000000000000000000000000000000000000");
  assert.ok(live.fields.includes("account { id }") && live.fields.includes("asset { id symbol name }") && live.fields.includes("market { id name }"));
  assert.equal(planFromBundledCatalog({ intent: parseGoal("Aave V3 user positions on Ethereum", { now: 1 }), entity: { name: "Position" }, entities: [{ name: "LendingProtocol", fields: 53 }, { name: "Market", fields: 87 }, { name: "Account", fields: 0 }, { name: "Position", fields: 0 }, { name: "Token", fields: 9 }], first: 3 }).family, "messari_lending");
});

test("pinned npx package equals package.json version (0.13.7)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PINNED_NPX_PACKAGE, `subgraph-registry-mcp@${pkg.version}`);
});
