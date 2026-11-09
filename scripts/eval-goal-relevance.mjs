#!/usr/bin/env node
// Credential-free goal-relevance matrix for query_for_goal over real MCP stdio.
// Usage: node scripts/eval-goal-relevance.mjs [entry=src/index.js] [report.json]
// Never sends a key or network request: execute is always false.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "graphql";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const entry = resolve(process.argv[2] || "src/index.js");
const output = process.argv[3];

function rootOf(query) {
  if (typeof query !== "string") return null;
  try {
    const op = parse(query).definitions[0];
    const root = op.selectionSet.selections.find((s) => s.name.value !== "_meta");
    return root ? { collection: root.name.value, fields: (root.selectionSet?.selections || []).map((f) => f.name.value), args: Object.fromEntries((root.arguments || []).map((a) => [a.name.value, a.value.kind === "ObjectValue" ? a.value.fields.map((f) => f.name.value) : a.value.value])) } : null;
  } catch { return null; }
}

// [label, args, expectation(root, result)]
export const GOAL_CASES = [
  ["Arc Uniswap V4 pool IDs", { goal: "Uniswap V4 pool IDs on Arc", chain: "arc", first: 3 }, (r) => r?.collection === "pools" && r.fields.join() === "id"],
  ["Ethereum Uniswap V3 pool IDs", { goal: "Uniswap v3 liquidity pool ids on Ethereum", first: 3 }, (r) => r?.collection === "pools" && r.fields.join() === "id"],
  ["Arc OHLCV default filters explain hidden match", { goal: "OHLCV candles for Uniswap v4 pools on Arc", chain: "arc", first: 2 }, (r, out) => r === null && out.goal_mapping?.hidden_candidates?.some((c) => c.entity === "Candle")],
  ["Arc OHLCV candles with opt-in", { goal: "OHLCV candles for Uniswap v4 pools on Arc", chain: "arc", first: 2, include_denied: true }, (r) => r?.collection === "candles"],
  ["latest swaps", { goal: "latest Uniswap v3 swaps on Ethereum", first: 2 }, (r) => r?.collection === "swaps"],
  ["daily pool volume", { goal: "Uniswap v3 daily pool volume on Ethereum", first: 2 }, (r) => r?.collection === "poolDayDatas"],
  ["Aave liquidations", { goal: "Aave v3 liquidations on Ethereum", first: 2 }, (r) => /liquidat/i.test(r?.collection || "")],
  ["Arbitrum positions", { goal: "Uniswap v3 positions on Arbitrum", first: 2 }, (r) => r?.collection === "positions"],
  ["Base token symbols", { goal: "Uniswap v3 token symbols on Base", first: 2 }, (r) => r?.collection === "tokens"],
  ["ENS domains", { goal: "ENS domain names", first: 2 }, (r) => r?.collection === "domains"],
  ["pool address filter", { goal: "Uniswap v3 pool 0x88E6A0c2dDD26FEEb64F039a2c41296FcB3f5640 on Ethereum", first: 1 }, (r) => r?.collection === "pools" && (r.args.where || []).includes("id")],
  ["Arc pool manager counters", { goal: "Uniswap v4 pool manager counters on Arc", chain: "arc", first: 1 }, (r) => r?.collection === "poolManagers"],
  ["Polygon Aave borrows", { goal: "Aave v3 borrows on Polygon", first: 2 }, (r, out) => r?.collection === "borrows" && out.selected?.network === "matic"],
  ["Base Uniswap mints", { goal: "Uniswap v3 mints on Base", first: 2 }, (r, out) => r?.collection === "mints" && out.selected?.network === "base"],
  ["no misleading query for absent entity", { goal: "Uniswap v3 liquidations on Ethereum", first: 2 }, (r, out) => r === null && out.request === null],
  ["hourly token data", { goal: "Uniswap v3 hourly token data on Ethereum", first: 2 }, (r) => r?.collection === "tokenHourDatas"],
];

const client = new Client({ name: "goal-relevance-eval", version: "1" }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe",
  env: { PATH: process.env.PATH, HOME: process.env.HOME, THE_GRAPH_STUDIO_API_KEY: "", GRAPH_STUDIO_API_KEY: "", GATEWAY_API_KEY: "" } });
transport.stderr?.on("data", () => {});
const results = [];
try {
  await client.connect(transport);
  for (const [name, args, expected] of GOAL_CASES) {
    const wire = await client.callTool({ name: "query_for_goal", arguments: { ...args, execute: false } }, undefined, { timeout: 30000 });
    const r = JSON.parse(wire.content[0].text);
    const root = rootOf(r.query);
    const passed = !!expected(root, r);
    results.push({ name, args, passed, selected: r.selected?.display_name ?? null, network: r.selected?.network ?? null, root, confidence: r.goal_mapping?.confidence ?? null, error: r.error ?? null });
    console.log(JSON.stringify(results.at(-1)));
  }
  const report = { entry, count: results.length, passed: results.filter((x) => x.passed).length, results };
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ summary: true, count: report.count, passed: report.passed }));
} finally { await client.close(); }
