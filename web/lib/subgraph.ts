// x402-omnigraph subgraph client — server-side only.
//
// Replaces the 14 Dune queries previously used by the dashboard. Reads live
// from the published subgraph (Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj)
// via The Graph Gateway and derives every dashboard panel from a single
// paginated fetch of `X402Payment` rows scoped to the gateway recipient.
//
// Auth: GRAPH_API_KEY env var (same key used by refresh_known_agents.py for
// the agent0 enrichment path). NEVER log the key value.

import type { ConcentrationRow } from "@/components/Concentration";
import type { CumulativePoint } from "@/components/CumulativeChart";
import type { DailyPoint } from "@/components/DailyChart";
import type { HeatPoint } from "@/components/ActivityHeatmap";
import type { NRPoint } from "@/components/NewVsReturning";
import type { PaymentRow } from "@/components/RecentActivity";

// ── Constants ────────────────────────────────────────────────────────────────

// The Graph's x402 gateway payTo address on Base. Lowercased to match the
// Bytes-comparison semantics of the subgraph's `to` field.
export const GATEWAY_RECIPIENT = "0x79dc34e41b2b591078d3de222c43ecaabd52fccb";

const SUBGRAPH_ID = "Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj";

// 5-minute revalidate. Subgraph is live (indexes through current block) and
// the gateway gets a handful of payments per day at most, so 5-min staleness
// preserves the "real-time dashboard" feel that wasn't possible with the
// daily Dune cron without burning gateway query budget.
export const REVALIDATE_SECONDS = 300;

// Safety cap on the paginated payment fetch. Current dataset is 143 rows;
// 50k = ~year of growth at 100x current rate.
const MAX_ROWS = 50_000;
const PAGE_SIZE = 1000;

// ── Gateway client ────────────────────────────────────────────────────────────

function gatewayUrl(): string {
  const key = process.env.GRAPH_API_KEY;
  if (!key) {
    // Keep parity with the old dune.ts behavior: warn loudly but return
    // empty data so local dev without an API key still renders.
    console.warn("[subgraph] GRAPH_API_KEY not set; queries will return empty results");
    return "";
  }
  return `https://gateway.thegraph.com/api/${key}/subgraphs/id/${SUBGRAPH_ID}`;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export async function postGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T | null> {
  const url = gatewayUrl();
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      next: { revalidate: REVALIDATE_SECONDS, tags: ["subgraph:x402-omnigraph"] },
    });
    if (!res.ok) {
      console.warn(`[subgraph] HTTP ${res.status} from gateway`);
      return null;
    }
    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length) {
      console.warn(`[subgraph] GraphQL error: ${json.errors[0].message.slice(0, 200)}`);
      return null;
    }
    return json.data ?? null;
  } catch (e) {
    console.warn("[subgraph] fetch failed:", e);
    return null;
  }
}

// ── Raw entity types (subset of the schema we use) ───────────────────────────

interface RawPayment {
  id: string;
  blockNumber: string;
  blockTimestamp: string;
  transactionHash: string;
  from: string;
  to: string;
  amountDecimal: string;
}

interface RawSummary {
  id: string;
  totalPayments: string;
  totalVolumeDecimal: string;
  firstPaymentTimestamp: string | null;
  lastPaymentTimestamp: string | null;
}

interface PaymentsPage {
  x402Payments: RawPayment[];
}

interface SummaryQuery {
  x402AddressSummary: RawSummary | null;
}

// ── Workhorse: paginated payments to the gateway ──────────────────────────────

let _cachedPayments: RawPayment[] | null = null;

/**
 * Paginated id_gt cursor fetch of every X402Payment where to=gateway.
 * The dashboard derives DAILY, CUMULATIVE, CONCENTRATION, NEW_PAYERS,
 * ACTIVITY_HEATMAP, TRENDS, and TOP_PAYERS from this single dataset to
 * minimize gateway query cost.
 *
 * Memoized for the duration of a request so the dashboard's parallel
 * `Promise.all` does not refetch the same data N times.
 */
export async function getGatewayPaymentsAll(): Promise<RawPayment[]> {
  if (_cachedPayments) return _cachedPayments;

  const query = `
    query Payments($to: Bytes!, $cursor: String!, $first: Int!) {
      x402Payments(
        where: { to: $to, id_gt: $cursor }
        first: $first
        orderBy: id
        orderDirection: asc
      ) {
        id
        blockNumber
        blockTimestamp
        transactionHash
        from
        to
        amountDecimal
      }
    }
  `;

  const all: RawPayment[] = [];
  let cursor = "";
  while (all.length < MAX_ROWS) {
    const data = await postGraphQL<PaymentsPage>(query, {
      to: GATEWAY_RECIPIENT,
      cursor,
      first: PAGE_SIZE,
    });
    const rows = data?.x402Payments ?? [];
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    cursor = rows[rows.length - 1].id;
  }
  _cachedPayments = all;
  return all;
}

// ── Individual fetchers (cards keyed by Dune query name) ─────────────────────

export interface LifetimeTotals {
  total_usdc: number;
  total_payments: number;
  first_payment_at: string;
  last_payment_at: string;
}

/** LIFETIME_TOTALS — Hero card top numbers. */
export async function fetchLifetimeTotals(): Promise<LifetimeTotals> {
  // Try the single-entity read first (cheap). Fall back to a derive over the
  // workhorse dataset if the summary entity isn't keyed by raw address.
  const query = `
    query Summary($id: ID!) {
      x402AddressSummary(id: $id) {
        id
        totalPayments
        totalVolumeDecimal
        firstPaymentTimestamp
        lastPaymentTimestamp
      }
    }
  `;
  const data = await postGraphQL<SummaryQuery>(query, { id: GATEWAY_RECIPIENT });
  if (data?.x402AddressSummary) {
    const s = data.x402AddressSummary;
    return {
      total_usdc: Number(s.totalVolumeDecimal ?? 0),
      total_payments: Number(s.totalPayments ?? 0),
      first_payment_at: tsToIso(s.firstPaymentTimestamp),
      last_payment_at: tsToIso(s.lastPaymentTimestamp),
    };
  }
  // Fallback derive
  const payments = await getGatewayPaymentsAll();
  const total_usdc = payments.reduce((s, p) => s + Number(p.amountDecimal), 0);
  const sorted = [...payments].sort(
    (a, b) => Number(a.blockTimestamp) - Number(b.blockTimestamp),
  );
  return {
    total_usdc,
    total_payments: payments.length,
    first_payment_at: sorted.length ? tsToIso(sorted[0].blockTimestamp) : "",
    last_payment_at: sorted.length ? tsToIso(sorted[sorted.length - 1].blockTimestamp) : "",
  };
}

/** DAILY — per-day payment counts for the gateway. */
export async function fetchDaily(): Promise<DailyPoint[]> {
  const payments = await getGatewayPaymentsAll();
  const byDay = new Map<string, number>();
  for (const p of payments) {
    const day = dayKey(p.blockTimestamp);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, payments]) => ({ day, payments }));
}

/** CUMULATIVE — running sum of USDC paid to the gateway. */
export async function fetchCumulative(): Promise<CumulativePoint[]> {
  const payments = await getGatewayPaymentsAll();
  const byDayUsdc = new Map<string, number>();
  for (const p of payments) {
    const day = dayKey(p.blockTimestamp);
    byDayUsdc.set(day, (byDayUsdc.get(day) ?? 0) + Number(p.amountDecimal));
  }
  let running = 0;
  return Array.from(byDayUsdc.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, amount]) => {
      running += amount;
      return { day, cumulative_usdc: running };
    });
}

/** TOP_PAYERS — payer wallets ranked by payment count to the gateway.
 *  Returned for identifyAgents() consumption — page.tsx no longer renders
 *  this directly, but the enrichment pass needs the wallet list. */
export interface TopPayer {
  wallet: string;
  payments: number;
  last_seen: string;
}

export async function fetchTopPayers(): Promise<TopPayer[]> {
  const payments = await getGatewayPaymentsAll();
  const byPayer = new Map<string, { count: number; last: number }>();
  for (const p of payments) {
    const w = p.from.toLowerCase();
    const ts = Number(p.blockTimestamp);
    const prev = byPayer.get(w);
    if (prev) {
      prev.count += 1;
      if (ts > prev.last) prev.last = ts;
    } else {
      byPayer.set(w, { count: 1, last: ts });
    }
  }
  return Array.from(byPayer.entries())
    .map(([wallet, v]) => ({
      wallet,
      payments: v.count,
      last_seen: tsToIso(v.last),
    }))
    .sort((a, b) => b.payments - a.payments);
}

/** CONCENTRATION — payer cohort buckets (1, 2-5, 6-20, 21+). */
export async function fetchConcentration(): Promise<ConcentrationRow[]> {
  const payers = await fetchTopPayers();
  const buckets = [
    { bucket: "1 payment", min: 1, max: 1, payers: 0, payments: 0 },
    { bucket: "2–5 payments", min: 2, max: 5, payers: 0, payments: 0 },
    { bucket: "6–20 payments", min: 6, max: 20, payers: 0, payments: 0 },
    { bucket: "21+ payments", min: 21, max: Infinity, payers: 0, payments: 0 },
  ];
  for (const p of payers) {
    for (const b of buckets) {
      if (p.payments >= b.min && p.payments <= b.max) {
        b.payers += 1;
        b.payments += p.payments;
        break;
      }
    }
  }
  const total = buckets.reduce((s, b) => s + b.payments, 0);
  return buckets
    .filter((b) => b.payers > 0)
    .map((b) => ({
      bucket: b.bucket,
      payers: b.payers,
      payments: b.payments,
      share: total > 0 ? (b.payments / total) * 100 : 0,
    }));
}

/** NEW_PAYERS — per-day count of first-time payers to the gateway. */
export interface NewPayerRow {
  day: string;
  new_payers: number;
}

export async function fetchNewPayers(): Promise<NewPayerRow[]> {
  const payments = await getGatewayPaymentsAll();
  // first-seen day per payer
  const firstSeen = new Map<string, number>();
  for (const p of payments) {
    const w = p.from.toLowerCase();
    const ts = Number(p.blockTimestamp);
    const prev = firstSeen.get(w);
    if (prev === undefined || ts < prev) firstSeen.set(w, ts);
  }
  const byDay = new Map<string, number>();
  for (const ts of firstSeen.values()) {
    const day = dayKey(String(ts));
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, new_payers]) => ({ day, new_payers }));
}

/** RECENT_PAYMENTS — last 50 payments to the gateway. Direct query (cheaper
 *  than scanning the whole dataset). */
export async function fetchRecentPayments(limit = 50): Promise<PaymentRow[]> {
  const query = `
    query Recent($to: Bytes!, $first: Int!) {
      x402Payments(
        where: { to: $to }
        first: $first
        orderBy: blockTimestamp
        orderDirection: desc
      ) {
        from
        amountDecimal
        blockTimestamp
        transactionHash
      }
    }
  `;
  const data = await postGraphQL<{
    x402Payments: {
      from: string;
      amountDecimal: string;
      blockTimestamp: string;
      transactionHash: string;
    }[];
  }>(query, { to: GATEWAY_RECIPIENT, first: limit });
  const rows = data?.x402Payments ?? [];
  return rows.map((r) => ({
    wallet: r.from.toLowerCase(),
    amount_usdc: Number(r.amountDecimal),
    block_time: tsToIso(r.blockTimestamp),
    tx_hash: r.transactionHash,
  }));
}

/** ACTIVITY_HEATMAP — 7x24 matrix of payment counts by UTC day-of-week and hour. */
export async function fetchActivityHeatmap(): Promise<HeatPoint[]> {
  const payments = await getGatewayPaymentsAll();
  const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const p of payments) {
    const d = new Date(Number(p.blockTimestamp) * 1000);
    const dow = d.getUTCDay();
    const hour = d.getUTCHours();
    matrix[dow][hour] += 1;
  }
  const out: HeatPoint[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      out.push({ day_of_week: dow, hour, count: matrix[dow][hour] });
    }
  }
  return out;
}

/** HOURS_SINCE — single-row hours-since-last-payment. Unused by page.tsx
 *  (last-paid timestamp is sourced from fetchRecentPayments), but kept as
 *  a typed helper for future use. */
export async function fetchHoursSinceLastPayment(): Promise<number> {
  const totals = await fetchLifetimeTotals();
  const t = Date.parse(totals.last_payment_at);
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / 3_600_000;
}

/** INTER_ARRIVAL — placeholder helper for the time-between-payments
 *  distribution (currently unused by page.tsx; left in for future cards). */
export async function fetchInterArrival(): Promise<{ wallet: string; gaps_seconds: number[] }[]> {
  const payments = await getGatewayPaymentsAll();
  const byPayer = new Map<string, number[]>();
  for (const p of payments) {
    const w = p.from.toLowerCase();
    const arr = byPayer.get(w) ?? [];
    arr.push(Number(p.blockTimestamp));
    byPayer.set(w, arr);
  }
  const out: { wallet: string; gaps_seconds: number[] }[] = [];
  for (const [wallet, ts] of byPayer.entries()) {
    if (ts.length < 2) continue;
    ts.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    out.push({ wallet, gaps_seconds: gaps });
  }
  return out;
}

/** ACTIVE_DAYS — distinct active days per payer (unused by page.tsx today). */
export async function fetchActiveDaysShare(): Promise<{ wallet: string; active_days: number }[]> {
  const payments = await getGatewayPaymentsAll();
  const byPayer = new Map<string, Set<string>>();
  for (const p of payments) {
    const w = p.from.toLowerCase();
    const day = dayKey(p.blockTimestamp);
    const set = byPayer.get(w) ?? new Set<string>();
    set.add(day);
    byPayer.set(w, set);
  }
  return Array.from(byPayer.entries())
    .map(([wallet, set]) => ({ wallet, active_days: set.size }))
    .sort((a, b) => b.active_days - a.active_days);
}

/** TRENDS — 24h / 7d / 30d payment & USDC totals for the gateway. */
export interface TrendsRow {
  payments_24h: number;
  payments_7d: number;
  payments_30d: number;
  usdc_24h: number;
  usdc_7d: number;
  usdc_30d: number;
}

export async function fetchTrends(): Promise<TrendsRow> {
  const payments = await getGatewayPaymentsAll();
  const nowSec = Date.now() / 1000;
  const w24 = nowSec - 86_400;
  const w7 = nowSec - 7 * 86_400;
  const w30 = nowSec - 30 * 86_400;
  const r: TrendsRow = {
    payments_24h: 0, payments_7d: 0, payments_30d: 0,
    usdc_24h: 0, usdc_7d: 0, usdc_30d: 0,
  };
  for (const p of payments) {
    const ts = Number(p.blockTimestamp);
    const amt = Number(p.amountDecimal);
    if (ts >= w30) { r.payments_30d += 1; r.usdc_30d += amt; }
    if (ts >= w7)  { r.payments_7d  += 1; r.usdc_7d  += amt; }
    if (ts >= w24) { r.payments_24h += 1; r.usdc_24h += amt; }
  }
  return r;
}

// ── Derivers used by page.tsx (kept exported for reuse in tests/scripts) ──

export function deriveNewVsReturningByWeek(
  daily: DailyPoint[],
  newPayers: NewPayerRow[],
): NRPoint[] {
  const npByWeek = new Map<string, number>();
  for (const r of newPayers) {
    const wk = isoWeekStart(r.day);
    npByWeek.set(wk, (npByWeek.get(wk) ?? 0) + r.new_payers);
  }
  const dailyByWeek = new Map<string, number>();
  for (const p of daily) {
    const wk = isoWeekStart(p.day);
    dailyByWeek.set(wk, (dailyByWeek.get(wk) ?? 0) + p.payments);
  }
  return Array.from(dailyByWeek.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-8)
    .map(([wk, total]) => {
      const newA = npByWeek.get(wk) ?? 0;
      return { week: wk, new_agents: newA, returning_agents: Math.max(0, total - newA) };
    });
}

// ── Small helpers ────────────────────────────────────────────────────────────

function tsToIso(ts: string | number | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") return "";
  const n = typeof ts === "string" ? Number(ts) : ts;
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString();
}

function dayKey(ts: string | number): string {
  const n = typeof ts === "string" ? Number(ts) : ts;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

function isoWeekStart(dayStr: string): string {
  const d = new Date(dayStr + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return dayStr;
  const dow = d.getUTCDay(); // 0=Sun
  const offset = (dow + 6) % 7; // make Monday=0
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
