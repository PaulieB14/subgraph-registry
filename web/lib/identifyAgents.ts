// Build-time agent enrichment for the dashboard.
//
// Resolves a list of payer wallets into AgentRow entries by querying:
//   1. OPERATOR_SEED (inline; mirrors scripts/refresh_known_agents.py)
//   2. graphadvocate.com/bazaar/active (active x402 services)
//   3. 8004scan ?search=<wallet> exact-owner-match (with backoff on 429)
//   4. agent0-base-mainnet subgraph (catches operator-paid agents that
//      8004scan misses)
//
// Returns rows in the same shape page.tsx expects: { agent, wallet,
// payments, last_seen, registry, agent_link }. The `agent` field is
// markdown-wrapped `[name](link)` so the AgentLeaderboard component's
// existing extractName() keeps working unchanged.

import type { TopPayer } from "./subgraph";

const AGENT0_BASE_SUBGRAPH_ID = "43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb";
const GA_8004_BASE_AGENT_ID = "8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:41034";

const CHAIN_SLUG: Record<number, string> = {
  1: "ethereum", 8453: "base", 42161: "arbitrum", 10: "optimism",
  56: "bsc", 137: "polygon", 42220: "celo", 130: "unichain",
  1923: "swellchain", 2741: "abstract", 5042002: "ronin",
  84532: "base-sepolia", 11155111: "sepolia",
};

function scan8004(agentId: string | null | undefined): string {
  if (!agentId) return "https://8004scan.io";
  const parts = agentId.split(":");
  if (parts.length === 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[2])) {
    const slug = CHAIN_SLUG[Number(parts[0])];
    if (slug) return `https://8004scan.io/agents/${slug}/${parts[2]}`;
  }
  return "https://8004scan.io";
}

function basescan(wallet: string): string {
  return `https://basescan.org/address/${wallet}`;
}

// Mirror of OPERATOR_SEED in scripts/refresh_known_agents.py.
// Format: [wallet, name, source, link]. All three GA-controlled wallets
// surface as the same agent identity to match the single-name format the
// other identified agents use.
const OPERATOR_SEED: [string, string, string, string][] = [
  ["0x575267eed09c338fae5716a486a7b58a5749a292", "graphadvocate", "operator", scan8004(GA_8004_BASE_AGENT_ID)],
  ["0xe121e3a8611e1f44f7cc52892ee1117fddc8f734", "graphadvocate", "operator", scan8004(GA_8004_BASE_AGENT_ID)],
  ["0x0ff5a6ecef783bba35463ec2f8403b9b5e9e7c86", "graphadvocate", "operator", scan8004(GA_8004_BASE_AGENT_ID)],
];

// ── HTTP helpers ─────────────────────────────────────────────────────────────

interface FetchOpts {
  timeoutMs?: number;
}

async function fetchJSON<T>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  const { timeoutMs = 8000 } = opts;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "x402-watch-build/1.0", Accept: "application/json" },
      signal: controller.signal,
      // No revalidate — this runs at build/render time with its own caching layer above.
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 429) throw new RateLimitError();
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function postJSON<T>(url: string, body: unknown, opts: FetchOpts = {}): Promise<T | null> {
  const { timeoutMs = 15_000 } = opts;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "x402-watch-build/1.0",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 429) throw new RateLimitError();
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    return null;
  } finally {
    clearTimeout(t);
  }
}

class RateLimitError extends Error {
  constructor() { super("rate limit"); this.name = "RateLimitError"; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Bazaar fetch ─────────────────────────────────────────────────────────────

interface BazaarItem {
  pay_to?: string;
  resource?: string;
  erc8004_agent?: {
    name?: string;
    ens?: string;
    owner?: string;
    agent_id?: string;
  };
}

async function fromBazaar(): Promise<[string, string, string, string][]> {
  const d = await fetchJSON<{ results?: BazaarItem[] }>(
    "https://graphadvocate.com/bazaar/active",
    { timeoutMs: 10_000 },
  ).catch(() => null);
  if (!d || !d.results) return [];
  const rows: [string, string, string, string][] = [];
  for (const it of d.results) {
    const payTo = (it.pay_to ?? "").toLowerCase();
    const e8 = it.erc8004_agent ?? {};
    const name = e8.name ?? e8.ens ?? hostname(it.resource ?? "") ?? "?";
    const agentIdFull = e8.agent_id ?? null;
    const link = agentIdFull ? scan8004(agentIdFull) : basescan(payTo);
    if (payTo.startsWith("0x")) rows.push([payTo, String(name), "bazaar", link]);
    const owner = (e8.owner ?? "").toLowerCase();
    if (owner.startsWith("0x") && owner !== payTo) {
      rows.push([
        owner,
        agentIdFull ? `ERC-8004 #${agentIdFull}` : String(name),
        "erc8004",
        scan8004(agentIdFull),
      ]);
    }
  }
  return rows;
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ── 8004scan exact-wallet enrichment ─────────────────────────────────────────

interface Scan8004Agent {
  owner_address?: string;
  owner_ens?: string;
  name?: string;
  chain_id?: number;
  agent_id?: string;
}

async function enrichFrom8004scan(
  wallet: string,
): Promise<[string, string, string, string] | null> {
  // 5s exponential backoff, max 3 retries. Skip-on-final-failure so the build
  // doesn't fail if 8004scan is degraded.
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      const d = await fetchJSON<{ data?: Scan8004Agent[] }>(
        `https://8004scan.io/api/v1/public/agents?search=${wallet}`,
        { timeoutMs: 8000 },
      );
      if (!d || !d.data) return null;
      for (const a of d.data) {
        if ((a.owner_address ?? "").toLowerCase() !== wallet.toLowerCase()) continue;
        let name = a.name ?? "";
        if (!name || name.startsWith("Agent #")) {
          name = a.owner_ens ?? "";
          if (!name) continue;
        }
        const chain = a.chain_id;
        const agentIdFull = a.agent_id ?? null;
        const label = chain === 8453 ? name : `${name} (chain ${chain})`;
        return [wallet.toLowerCase(), label, "8004scan", scan8004(agentIdFull)];
      }
      return null;
    } catch (e) {
      if (e instanceof RateLimitError && attempt < delays.length - 1) {
        await sleep(delays[attempt]);
        continue;
      }
      // Any other error: skip this wallet, don't block the build.
      return null;
    }
  }
  return null;
}

// ── agent0 subgraph enrichment ───────────────────────────────────────────────

interface Agent0Result {
  data?: {
    agents?: {
      agentId?: string;
      owner?: string;
      agentWallet?: string;
      agentURI?: string;
    }[];
  };
  errors?: { message: string }[];
}

async function enrichFromAgent0(
  wallet: string,
): Promise<[string, string, string, string] | null> {
  const key = process.env.GRAPH_API_KEY;
  if (!key) return null;
  const url = `https://gateway.thegraph.com/api/${key}/subgraphs/id/${AGENT0_BASE_SUBGRAPH_ID}`;
  // Match the exact schema-correct query refresh_known_agents.py uses.
  const query = `
    query($w: Bytes!) {
      agents(first: 5, where: {or: [
        {owner: $w},
        {agentWallet: $w},
        {operators_contains: [$w]}
      ]}) {
        agentId owner agentWallet agentURI
      }
    }
  `;
  const d = await postJSON<Agent0Result>(url, { query, variables: { w: wallet.toLowerCase() } });
  if (!d || d.errors || !d.data?.agents) return null;
  for (const a of d.data.agents) {
    if (!a) continue;
    const agentId = a.agentId ?? "";
    let name = `ERC-8004 #${agentId}`;
    const uri = a.agentURI ?? "";
    if (uri.startsWith("data:application/json;base64,")) {
      try {
        const meta = JSON.parse(
          Buffer.from(uri.split(",", 2)[1] ?? "", "base64").toString("utf8"),
        ) as { name?: string };
        if (meta.name) name = meta.name;
      } catch {
        // ignore parse errors
      }
    }
    const isOwner = (a.owner ?? "").toLowerCase() === wallet.toLowerCase();
    const isAgentWallet = (a.agentWallet ?? "").toLowerCase() === wallet.toLowerCase();
    if (!(isOwner || isAgentWallet)) name = `${name} (operator)`;
    const agentIdFull = agentId
      ? `8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:${agentId}`
      : null;
    return [wallet.toLowerCase(), name, "agent0", scan8004(agentIdFull)];
  }
  return null;
}

// ── Top-level identify ───────────────────────────────────────────────────────

export interface AgentRow {
  agent: string;
  wallet: string;
  payments: number;
  last_seen: string;
  registry: string;
  agent_link: string;
}

/**
 * Resolve a list of payers (from fetchTopPayers) into AgentRow entries.
 * Only rows that resolve to a registered identity are returned — unknown
 * wallets fall through and are excluded from the leaderboard but still
 * appear in the Recent Activity feed as a shortened address.
 */
export async function identifyAgents(payers: TopPayer[]): Promise<AgentRow[]> {
  // Source 1+2: operator seed and bazaar (one network call total)
  const bazaarRows = await fromBazaar();
  const directory = new Map<string, [string, string, string, string]>();
  for (const row of [...OPERATOR_SEED, ...bazaarRows]) {
    const w = row[0].toLowerCase();
    if (!directory.has(w)) directory.set(w, row);
  }

  // Source 3+4: per-payer 8004scan + agent0 fallback. Sequential to keep
  // 8004scan happy; the dataset is small (<100 wallets at GA scale).
  for (const p of payers) {
    const w = p.wallet.toLowerCase();
    if (directory.has(w)) continue;
    const fromScan = await enrichFrom8004scan(w);
    if (fromScan) { directory.set(w, fromScan); continue; }
    const fromAgent0 = await enrichFromAgent0(w);
    if (fromAgent0) directory.set(w, fromAgent0);
  }

  // Join directory with payer counts. Drop directory entries that have no
  // payments to the gateway (they're seeded operators that haven't paid yet).
  const countsByWallet = new Map(payers.map((p) => [p.wallet.toLowerCase(), p]));
  const rows: AgentRow[] = [];
  for (const [wallet, [, name, source, link]] of directory.entries()) {
    const stats = countsByWallet.get(wallet);
    if (!stats) continue;
    rows.push({
      // Markdown-wrapped to match the format AgentLeaderboard.extractName() expects.
      agent: `[${name}](${link})`,
      wallet,
      payments: stats.payments,
      last_seen: stats.last_seen,
      registry: source,
      agent_link: link,
    });
  }
  rows.sort((a, b) => b.payments - a.payments);
  return rows;
}
