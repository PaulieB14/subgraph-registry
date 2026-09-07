/**
 * Acceptance evaluation for recommend_subgraph ranking.
 *
 * Drives the real MCP stdio surface (initialize -> tools/call) so the SQL,
 * the token model and the re-rank are exercised together, exactly as a client
 * sees them. Assertions encode the 2026-09-04 live eval: the failures that had
 * to be fixed, and the results that must not regress while fixing them.
 *
 * Run: node scripts/eval-recommend.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let proc, buf = "", nextId = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++nextId;
    const t = setTimeout(() => rej(new Error("timeout " + method)), 60_000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const names = (d) => (d.recommendations || []).map((r) => r.display_name || "");
const top = (d, n) => names(d).slice(0, n);
const none = (list, re) => !list.some((n) => re.test(n));

// [label, args, assert(d) -> null | reason]
const CASES = [
  // ── the reported failures ────────────────────────────────────────────────
  ["compound v3 +mainnet: Compound first, zero Uniswap in top-5",
   { goal: "compound v3", chain: "mainnet" },
   (d) => (!/compound/i.test(top(d,1)[0]) ? "top1 not Compound" :
           !none(top(d,5), /uniswap/i) ? "Uniswap in top-5" : null)],
  ["rocket pool: Rocket first, no Venus/1inch/Thena in top-3",
   { goal: "rocket pool" },
   (d) => (!/rocket/i.test(top(d,1)[0]) ? "top1 not Rocket" :
           !none(top(d,3), /venus|1inch|thena|linked pool/i) ? "pool-noise in top-3" : null)],
  ["DEX volume on Base: top hit is a high-volume DEX",
   { goal: "DEX volume on Base" },
   (d) => {
     const r = (d.recommendations || [])[0];
     if (!r) return "no results";
     if ((r.query_volume_30d || 0) < 1_000_000) return `top1 volume ${r.query_volume_30d}`;
     return /fwx/i.test(r.display_name) ? "FWX still top" : null;
   }],
  ["Base DEX with highest volume: same, phrased as a goal",
   { goal: "Base DEX with highest volume" },
   (d) => ((d.recommendations?.[0]?.query_volume_30d || 0) < 1_000_000 ? "low-volume top1" : null)],
  ["Safe / Gnosis Safe: gnosis is not consumed as a chain filter",
   { goal: "Safe / Gnosis Safe" },
   (d) => (d.inferred_chain === "gnosis" ? "gnosis wrongly inferred as chain" :
           /hopr/i.test(top(d,1)[0] || "") ? "HOPR still top" : null)],
  ["NFT floor price history: no Floor-brand collision at #1",
   { goal: "NFT floor price history" },
   (d) => (/^floor-protocol$|^floor v2$/i.test(top(d,1)[0] || "") ? "Floor brand at #1" : null)],

  // ── regression guards ────────────────────────────────────────────────────
  ["lido +mainnet: Lido #1, never Clearpool",
   { goal: "lido staking", chain: "mainnet" },
   (d) => (!/lido/i.test(top(d,1)[0]) ? "top1 not Lido" :
           !none(top(d,5), /clearpool/i) ? "Clearpool present" : null)],
  ["lido +ethereum alias",
   { goal: "lido staking", chain: "ethereum" },
   (d) => (d.inferred_chain !== "mainnet" ? "alias lost" :
           !/lido/i.test(top(d,1)[0]) ? "top1 not Lido" : null)],
  ["lido staking on mainnet (prose chain)",
   { goal: "lido staking on mainnet" },
   (d) => (d.inferred_chain !== "mainnet" ? "inferred_chain not set" :
           !/lido/i.test(top(d,1)[0]) ? "top1 not Lido" : null)],
  ["morpho blue on ethereum (prose chain)",
   { goal: "morpho blue on ethereum" },
   (d) => (d.inferred_chain !== "mainnet" ? "inferred_chain not set" :
           !/morpho/i.test(top(d,1)[0]) ? "top1 not Morpho" : null)],
  ["uniswap v3 +mainnet keeps V3 disambiguation",
   { goal: "uniswap v3", chain: "mainnet" },
   (d) => (!/uniswap/i.test(top(d,1)[0]) ? "top1 not Uniswap" :
           !/v3/i.test(top(d,1)[0]) ? "top1 not V3" : null)],
  ["ens", { goal: "ens" }, (d) => (!/ens/i.test(top(d,1)[0]) ? "top1 not ENS" : null)],
  ["eigenlayer", { goal: "eigenlayer" },
   (d) => (!/eigen/i.test(top(d,1)[0]) ? "top1 not EigenLayer" : null)],
  ["aave v3 +arbitrum-one", { goal: "aave v3", chain: "arbitrum-one" },
   (d) => (!/aave/i.test(top(d,1)[0]) ? "top1 not Aave" :
           d.recommendations?.[0]?.network !== "arbitrum-one" ? "wrong network" : null)],
  ["uniswap v3 +arbitrum-one", { goal: "uniswap v3", chain: "arbitrum-one" },
   (d) => (!/uniswap/i.test(top(d,1)[0]) ? "top1 not Uniswap" :
           d.recommendations?.[0]?.network !== "arbitrum-one" ? "wrong network" : null)],
  ["no testnets leak into default results", { goal: "uniswap v3" },
   (d) => (!none(names(d), /sepolia|goerli|holesky|testnet|mumbai/i) ? "testnet present" : null)],
];

async function main() {
  proc = spawn("node", ["src/index.js"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* server logs to stdout are not our concern */ }
    }
  });
  await send("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "eval-recommend", version: "0" },
  });

  let pass = 0, fail = 0;
  for (const [label, args, assertFn] of CASES) {
    const r = await send("tools/call", { name: "recommend_subgraph", arguments: args });
    let d;
    try { d = JSON.parse(r.result.content[0].text); }
    catch { console.log(`FAIL  ${label}\n        unparseable response`); fail++; continue; }
    const why = assertFn(d);
    if (why) {
      fail++;
      console.log(`FAIL  ${label}\n        ${why}\n        top5: ${top(d, 5).join(" | ") || "(none)"}`);
    } else {
      pass++;
      console.log(`pass  ${label}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${CASES.length} total`);
  proc.kill();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e.message); proc?.kill(); process.exit(1); });
