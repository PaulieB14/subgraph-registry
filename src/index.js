#!/usr/bin/env node

/**
 * Subgraph Registry MCP Server
 *
 * Exposes the classified subgraph registry as MCP tools that agents can call
 * to discover and select the right subgraph before querying The Graph.
 *
 * Tools:
 *   - search_subgraphs: Filter by domain, network, protocol type, entity, keyword
 *   - recommend_subgraph: Natural language goal -> best subgraphs
 *   - get_subgraph_detail: Full classification detail for a specific subgraph
 *   - list_registry_stats: Available domains, networks, protocol types
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { get as httpsGet } from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DATA_DIR, "registry.db");
const GITHUB_DB_URL =
  "https://github.com/PaulieB14/subgraph-registry/raw/main/python/data/registry.db";

// ── Download DB from GitHub if missing ─────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      httpsGet(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          writeFileSync(dest, Buffer.concat(chunks));
          resolve();
        });
        res.on("error", reject);
      }).on("error", reject);
    };
    follow(url);
  });
}

async function ensureDb() {
  if (existsSync(DB_PATH)) return;
  mkdirSync(DATA_DIR, { recursive: true });
  console.error("Registry not found locally. Downloading from GitHub...");
  await downloadFile(GITHUB_DB_URL, DB_PATH);
  console.error("Downloaded registry.db");
}

// ── Database ───────────────────────────────────────────────

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
  }
  return db;
}

// ── Tool Implementations ───────────────────────────────────

function searchSubgraphs({
  query = "",
  domain = "",
  network = "",
  protocol_type = "",
  entity = "",
  min_reliability = 0,
  limit = 20,
} = {}) {
  const conditions = [];
  const params = [];

  if (domain) {
    conditions.push("domain = ?");
    params.push(domain);
  }
  if (network) {
    conditions.push("network = ?");
    params.push(network);
  }
  if (protocol_type) {
    conditions.push("protocol_type = ?");
    params.push(protocol_type);
  }
  if (entity) {
    conditions.push('canonical_entities LIKE ?');
    params.push(`%"${entity}"%`);
  }
  if (min_reliability > 0) {
    conditions.push("reliability_score >= ?");
    params.push(min_reliability);
  }
  if (query) {
    conditions.push("(display_name LIKE ? OR description LIKE ?)");
    params.push(`%${query}%`, `%${query}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT id, display_name, description, domain, protocol_type, network,
           reliability_score, ipfs_hash, entity_count, canonical_entities,
           powered_by_substreams
    FROM subgraphs
    ${where}
    ORDER BY reliability_score DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = getDb().prepare(sql).all(...params);
  const results = rows.map((r) => ({
    id: r.id,
    display_name: r.display_name,
    description: (r.description || "").slice(0, 200),
    domain: r.domain,
    protocol_type: r.protocol_type,
    network: r.network,
    reliability_score: r.reliability_score,
    ipfs_hash: r.ipfs_hash,
    entity_count: r.entity_count,
    canonical_entities: JSON.parse(r.canonical_entities),
    powered_by_substreams: Boolean(r.powered_by_substreams),
  }));

  return { total: results.length, subgraphs: results };
}

function recommendSubgraph({ goal, chain = "" }) {
  const goalLower = goal.toLowerCase();

  const domainMap = {
    defi: ["defi", "swap", "trade", "lend", "borrow", "yield", "stake", "liquidity", "pool", "token"],
    nfts: ["nft", "collectible", "art", "marketplace"],
    dao: ["governance", "vote", "proposal", "dao"],
    identity: ["ens", "domain", "name", "identity"],
    infrastructure: ["indexer", "graph", "oracle"],
    social: ["social", "profile", "post", "lens"],
    gaming: ["game", "player", "quest"],
  };
  const typeMap = {
    dex: ["dex", "swap", "trade", "exchange", "amm", "uniswap", "sushi"],
    lending: ["lend", "borrow", "loan", "collateral", "aave", "compound"],
    bridge: ["bridge", "cross-chain"],
    staking: ["stake", "validator", "delegation"],
    options: ["option", "call", "put", "strike"],
    perpetuals: ["perp", "perpetual", "leverage", "margin"],
    governance: ["governance", "vote", "proposal"],
    "name-service": ["ens", "name service", "domain name"],
    "nft-marketplace": ["nft market", "opensea", "blur"],
  };

  const domains = Object.entries(domainMap)
    .filter(([, kws]) => kws.some((k) => goalLower.includes(k)))
    .map(([d]) => d);
  const ptypes = Object.entries(typeMap)
    .filter(([, kws]) => kws.some((k) => goalLower.includes(k)))
    .map(([t]) => t);

  const conditions = [];
  const params = [];

  if (chain) {
    conditions.push("network = ?");
    params.push(chain);
  }
  if (domains.length) {
    conditions.push(`domain IN (${domains.map(() => "?").join(",")})`);
    params.push(...domains);
  }
  if (ptypes.length) {
    conditions.push(`protocol_type IN (${ptypes.map(() => "?").join(",")})`);
    params.push(...ptypes);
  }

  if (!domains.length && !ptypes.length) {
    const words = goalLower.split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
    if (words.length) {
      const textConds = words.map(() => "(display_name LIKE ? OR description LIKE ?)");
      words.forEach((w) => params.push(`%${w}%`, `%${w}%`));
      conditions.push(`(${textConds.join(" OR ")})`);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT id, display_name, description, domain, protocol_type, network,
           reliability_score, ipfs_hash, canonical_entities
    FROM subgraphs
    ${where}
    ORDER BY reliability_score DESC
    LIMIT 5
  `;

  const rows = getDb().prepare(sql).all(...params);
  const recommendations = rows.map((r) => ({
    id: r.id,
    display_name: r.display_name,
    description: (r.description || "").slice(0, 200),
    domain: r.domain,
    protocol_type: r.protocol_type,
    network: r.network,
    reliability_score: r.reliability_score,
    ipfs_hash: r.ipfs_hash,
    canonical_entities: JSON.parse(r.canonical_entities),
    usage: `Query via subgraph ID '${r.id}' or IPFS hash '${r.ipfs_hash}'`,
  }));

  return {
    goal,
    chain_filter: chain || null,
    inferred_domain: domains.length ? domains : null,
    inferred_protocol_type: ptypes.length ? ptypes : null,
    total_matches: recommendations.length,
    recommendations,
  };
}

function getSubgraphDetail({ subgraph_id }) {
  const row = getDb()
    .prepare("SELECT * FROM subgraphs WHERE id = ? OR ipfs_hash = ?")
    .get(subgraph_id, subgraph_id);

  if (!row) return { error: `Subgraph '${subgraph_id}' not found` };

  const result = { ...row };
  result.canonical_entities = JSON.parse(result.canonical_entities);
  result.categories = JSON.parse(result.categories);
  return result;
}

function listRegistryStats() {
  const d = getDb();
  const domains = d
    .prepare("SELECT domain, COUNT(*) as count FROM subgraphs GROUP BY domain ORDER BY count DESC")
    .all();
  const networks = d
    .prepare("SELECT network, COUNT(*) as count FROM subgraphs WHERE network IS NOT NULL GROUP BY network ORDER BY count DESC")
    .all();
  const ptypes = d
    .prepare("SELECT protocol_type, COUNT(*) as count FROM subgraphs GROUP BY protocol_type ORDER BY count DESC")
    .all();
  const total = d.prepare("SELECT COUNT(*) as c FROM subgraphs").get().c;

  return {
    total_subgraphs: total,
    domains: Object.fromEntries(domains.map((r) => [r.domain, r.count])),
    networks: Object.fromEntries(networks.map((r) => [r.network, r.count])),
    protocol_types: Object.fromEntries(ptypes.map((r) => [r.protocol_type, r.count])),
  };
}

// ── MCP Server ─────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_subgraphs",
    description:
      "Search and filter the classified subgraph registry. Filter by domain (defi, nfts, dao, gaming, identity, infrastructure, social, analytics), network (mainnet, arbitrum-one, base, matic, bsc, optimism, avalanche), protocol_type (dex, lending, bridge, staking, options, perpetuals, nft-marketplace, yield-aggregator, governance, name-service), canonical entity type (liquidity_pool, trade, token, position, vault, loan, collateral, liquidation, nft_collection, nft_item, nft_sale, proposal, delegate, domain_name, account, transaction, daily_snapshot, hourly_snapshot), or free-text keyword. Returns subgraphs ranked by reliability score.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search across names and descriptions" },
        domain: { type: "string", description: "Filter by domain: defi, nfts, dao, gaming, identity, infrastructure, social, analytics" },
        network: { type: "string", description: "Filter by chain: mainnet, arbitrum-one, base, matic, bsc, optimism, avalanche, etc." },
        protocol_type: { type: "string", description: "Filter by protocol type: dex, lending, bridge, staking, options, perpetuals, etc." },
        entity: { type: "string", description: "Filter by canonical entity: liquidity_pool, trade, token, position, vault, loan, etc." },
        min_reliability: { type: "number", description: "Minimum reliability score (0-1). Higher = more signal/stake/fees." },
        limit: { type: "integer", description: "Max results to return (default: 20)", default: 20 },
      },
    },
  },
  {
    name: "recommend_subgraph",
    description:
      "Given a natural-language goal like 'find DEX trades on Arbitrum' or 'get lending liquidation data', returns the best matching subgraphs with reliability scores and query instructions. Automatically infers domain and protocol type from the goal.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What you want to do, e.g. 'query Uniswap pool data on Base'" },
        chain: { type: "string", description: "Optional chain filter: mainnet, arbitrum-one, base, matic, etc." },
      },
      required: ["goal"],
    },
  },
  {
    name: "get_subgraph_detail",
    description:
      "Get full classification detail for a specific subgraph by its subgraph ID or IPFS hash. Returns domain, protocol type, canonical entities, reliability score, signal data, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        subgraph_id: { type: "string", description: "Subgraph ID or IPFS hash (Qm...)" },
      },
      required: ["subgraph_id"],
    },
  },
  {
    name: "list_registry_stats",
    description:
      "Get an overview of the subgraph registry: total count, available domains, networks, and protocol types with counts. Use this to understand what data is available before searching.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

const HANDLERS = {
  search_subgraphs: searchSubgraphs,
  recommend_subgraph: recommendSubgraph,
  get_subgraph_detail: getSubgraphDetail,
  list_registry_stats: listRegistryStats,
};

async function main() {
  await ensureDb();

  const server = new Server(
    { name: "subgraph-registry", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }
    try {
      const result = handler(args || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Subgraph Registry MCP server running (${getDb().prepare("SELECT COUNT(*) as c FROM subgraphs").get().c} subgraphs)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
