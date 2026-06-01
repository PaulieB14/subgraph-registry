import dynamic from "next/dynamic";
import { ActivityHeatmap, type HeatPoint } from "@/components/ActivityHeatmap";
import { AgentLeaderboard, type AgentRow } from "@/components/AgentLeaderboard";
import { Concentration, type ConcentrationRow } from "@/components/Concentration";
import { type CumulativePoint } from "@/components/CumulativeChart";
import { type DailyPoint } from "@/components/DailyChart";
import { Hero, type HeroStats } from "@/components/Hero";
import { type NRPoint } from "@/components/NewVsReturning";
import { Panel } from "@/components/Panel";
import { RecentActivity, type PaymentRow } from "@/components/RecentActivity";
import { fetchQueryRows, num, QUERIES } from "@/lib/dune";

// Recharts' ResponsiveContainer breaks under SSR (ResizeObserver measures 0).
// Dynamically import with ssr:false so charts only render in the browser.
const CumulativeChart = dynamic(
  () => import("@/components/CumulativeChart").then((m) => m.CumulativeChart),
  { ssr: false, loading: () => <ChartSkeleton title="Cumulative USDC paid" /> },
);
const DailyChart = dynamic(
  () => import("@/components/DailyChart").then((m) => m.DailyChart),
  { ssr: false, loading: () => <ChartSkeleton title="Daily payments" /> },
);
const NewVsReturning = dynamic(
  () => import("@/components/NewVsReturning").then((m) => m.NewVsReturning),
  { ssr: false, loading: () => <ChartSkeleton title="New vs returning agents" /> },
);

function ChartSkeleton({ title }: { title: string }) {
  return (
    <Panel title={title}>
      <div className="h-56 animate-pulse rounded-md bg-panelHover/40" />
    </Panel>
  );
}

// Refresh once per day — Dune queries themselves only re-execute daily via
// the refresh-x402-dune workflow, so polling faster wastes Dune credits.
export const revalidate = 86400;

// ── Helpers to coerce Dune row shapes (column names vary; be defensive) ──────

function s(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== "") return String(v);
  }
  return "";
}
function n(row: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) if (row[k] != null) return num(row[k]);
  return 0;
}

function extractAgentName(agent: string): string {
  const m = /^\[([^\]]+)\]/.exec(agent);
  return m ? m[1] : agent;
}
function extractAgentLink(agent: string, fallback: string): string {
  const m = /\(([^)]+)\)$/.exec(agent);
  return m ? m[1] : fallback;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function Page() {
  const [
    lifetime,
    daily,
    cumulative,
    newPayers,
    recentPayments,
    heatmap,
    concentration,
    knownAgents,
    trends,
  ] = await Promise.all([
    fetchQueryRows(QUERIES.LIFETIME_TOTALS),
    fetchQueryRows(QUERIES.DAILY),
    fetchQueryRows(QUERIES.CUMULATIVE),
    fetchQueryRows(QUERIES.NEW_PAYERS),
    fetchQueryRows(QUERIES.RECENT_PAYMENTS),
    fetchQueryRows(QUERIES.ACTIVITY_HEATMAP),
    fetchQueryRows(QUERIES.CONCENTRATION),
    fetchQueryRows(QUERIES.KNOWN_AGENTS),
    fetchQueryRows(QUERIES.TRENDS),
  ]);

  // ── Agents (the headline metric the dashboard is about) ──
  const agentRows: AgentRow[] = (knownAgents as Record<string, unknown>[])
    .map((r) => ({
      agent: s(r, "agent", "agent_name"),
      wallet: s(r, "wallet", "payer").toLowerCase(),
      payments: n(r, "payments", "n_payments"),
      last_seen: s(r, "last_seen"),
      registry: s(r, "registry", "source"),
      agent_link: s(r, "agent_link"),
    }))
    .filter((r) => r.wallet);

  const identityByWallet = new Map<string, { name: string; link: string }>();
  for (const a of agentRows) {
    const name = extractAgentName(a.agent);
    const link = extractAgentLink(a.agent, a.agent_link);
    identityByWallet.set(a.wallet, { name, link });
  }

  const agentsRepeat = agentRows.filter((a) => a.payments > 1).length;

  // ── Hero numbers ──
  const lt = (lifetime[0] ?? {}) as Record<string, unknown>;
  const totalUSDC = num(lt.total_usdc ?? lt.usdc ?? lt.volume_usdc ?? 0);
  const totalPayments = num(lt.payments ?? lt.total_payments ?? lt.tx_count ?? 0);

  // Trends — query exposes raw 24h/7d/30d counts. Derive WoW delta as
  // 7d-vs-(30d-7d)/3 (prior-3-week average) for stability on early data.
  const tr = (trends[0] ?? {}) as Record<string, unknown>;
  const paymentsToday = num(tr.payments_24h ?? tr.txs_24h ?? 0);
  const usdc24h = num(tr.usdc_24h);
  const payments7d = num(tr.payments_7d);
  const usdc7d = num(tr.usdc_7d);
  const payments30d = num(tr.payments_30d);
  const usdc30d = num(tr.usdc_30d);
  const priorWeeklyAvg_payments = Math.max(0, (payments30d - payments7d) / 3);
  const priorWeeklyAvg_usdc = Math.max(0, (usdc30d - usdc7d) / 3);
  const weekDeltaPayments = priorWeeklyAvg_payments > 0
    ? ((payments7d - priorWeeklyAvg_payments) / priorWeeklyAvg_payments) * 100
    : 0;
  const weekDeltaUSDC = priorWeeklyAvg_usdc > 0
    ? ((usdc7d - priorWeeklyAvg_usdc) / priorWeeklyAvg_usdc) * 100
    : 0;

  // Newest payment timestamp from the activity feed (column is `time` in Dune)
  const lastPaymentAt = (recentPayments[0] as Record<string, unknown> | undefined)
    ? s(recentPayments[0] as Record<string, unknown>, "time", "block_time", "timestamp", "ts")
    : "";

  // Count this-week new agents from the directory (first-seen ≥ 7d ago)
  const weekAgo = Date.now() - 7 * 86_400_000;
  const agentsThisWeek = agentRows.filter((a) => {
    const t = Date.parse(a.last_seen);
    return Number.isFinite(t) && t >= weekAgo;
  }).length;

  const heroStats: HeroStats = {
    totalUSDC,
    totalPayments,
    agentsKnown: agentRows.length,
    agentsRepeat,
    weekDeltaUSDC: weekDeltaUSDC || undefined,
    weekDeltaPayments: weekDeltaPayments || undefined,
    agentsThisWeek,
    repeatsThisWeek: undefined,
    lastPaymentAt,
    paymentsToday: paymentsToday || undefined,
  };

  // ── Charts ──
  const cumulativePoints: CumulativePoint[] = (cumulative as Record<string, unknown>[])
    .map((r) => ({
      day: s(r, "day", "date").slice(0, 10),
      cumulative_usdc: n(r, "cumulative_usdc", "cum_usdc", "running_usdc"),
    }))
    .filter((p) => p.day);

  const dailyPoints: DailyPoint[] = (daily as Record<string, unknown>[])
    .map((r) => ({
      day: s(r, "day", "date").slice(0, 10),
      payments: n(r, "payments", "tx_count", "count"),
    }))
    .filter((p) => p.day);

  // New vs returning weekly — derive from new_payers per day if available
  const npByWeek = new Map<string, number>();
  for (const r0 of newPayers as Record<string, unknown>[]) {
    const day = s(r0, "day", "date").slice(0, 10);
    if (!day) continue;
    const wk = isoWeekStart(day);
    npByWeek.set(wk, (npByWeek.get(wk) ?? 0) + n(r0, "new_payers", "first_seen_count", "count"));
  }
  const dailyByWeek = new Map<string, number>();
  for (const p of dailyPoints) {
    const wk = isoWeekStart(p.day);
    dailyByWeek.set(wk, (dailyByWeek.get(wk) ?? 0) + p.payments);
  }
  const nrPoints: NRPoint[] = Array.from(dailyByWeek.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-8)
    .map(([wk, total]) => {
      const newA = npByWeek.get(wk) ?? 0;
      return { week: wk, new_agents: newA, returning_agents: Math.max(0, total - newA) };
    });

  // Heatmap (Dune columns: hour_utc, dow, payments)
  const heatPoints: HeatPoint[] = (heatmap as Record<string, unknown>[]).map((r) => ({
    hour: n(r, "hour_utc", "hour", "hour_of_day"),
    day_of_week: n(r, "dow", "day_of_week"),
    count: n(r, "payments", "count", "n"),
  }));

  // Concentration (Dune columns: bucket, payer_count, total_payments_in_bucket)
  // Share % isn't in the query — derive it from total payments across buckets.
  const concRowsRaw = (concentration as Record<string, unknown>[]).map((r) => ({
    bucket: s(r, "bucket", "cohort", "label"),
    payers: n(r, "payer_count", "payers", "n_payers"),
    payments: n(r, "total_payments_in_bucket", "payments", "total_payments"),
  }));
  const concSum = concRowsRaw.reduce((s, r) => s + r.payments, 0);
  const concRows: ConcentrationRow[] = concRowsRaw.map((r) => ({
    ...r,
    share: concSum > 0 ? (r.payments / concSum) * 100 : 0,
  }));

  // Recent payments (Dune columns: time, payer, usdc_amount, tx_hash)
  const paymentRows: PaymentRow[] = (recentPayments as Record<string, unknown>[]).map((r) => ({
    wallet: s(r, "payer", "from", "wallet").toLowerCase(),
    amount_usdc: n(r, "usdc_amount", "amount_usdc", "usdc", "amount"),
    block_time: s(r, "time", "block_time", "timestamp", "ts"),
    tx_hash: s(r, "tx_hash", "hash"),
  }));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <Hero stats={heroStats} />

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CumulativeChart data={cumulativePoints} />
        <DailyChart data={dailyPoints} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AgentLeaderboard rows={agentRows} />
        </div>
        <RecentActivity rows={paymentRows} identityByWallet={identityByWallet} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NewVsReturning data={nrPoints} />
        <Concentration rows={concRows} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4">
        <ActivityHeatmap data={heatPoints} />
      </div>

      <footer className="mt-10 flex items-center justify-between text-xs text-dim">
        <span>
          Data via{" "}
          <a className="text-muted hover:text-accent" href="https://dune.com/paulieb/x402-payments-to-the-graph-e7ab" target="_blank" rel="noopener noreferrer">
            Dune
          </a>
          {" · "}
          Agent identity via{" "}
          <a className="text-muted hover:text-accent" href="https://8004scan.io" target="_blank" rel="noopener noreferrer">
            8004scan
          </a>{" "}
          +{" "}
          <a className="text-muted hover:text-accent" href="https://thegraph.com" target="_blank" rel="noopener noreferrer">
            The Graph
          </a>{" "}
          agent0 subgraph
        </span>
        <span>refreshed every {REVALIDATE_SECONDS}s</span>
      </footer>
    </>
  );
}

function isoWeekStart(dayStr: string): string {
  const d = new Date(dayStr + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return dayStr;
  const dow = d.getUTCDay(); // 0=Sun
  const offset = (dow + 6) % 7; // make Monday=0
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
