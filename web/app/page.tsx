import { ActivityHeatmap, type HeatPoint } from "@/components/ActivityHeatmap";
import { AgentLeaderboard, type AgentRow } from "@/components/AgentLeaderboard";
import { Concentration, type ConcentrationRow } from "@/components/Concentration";
import { CumulativeChart, type CumulativePoint } from "@/components/CumulativeChart";
import { DailyChart, type DailyPoint } from "@/components/DailyChart";
import { Hero, type HeroStats } from "@/components/Hero";
import { NewVsReturning, type NRPoint } from "@/components/NewVsReturning";
import { Panel } from "@/components/Panel";
import { RecentActivity, type PaymentRow } from "@/components/RecentActivity";
import { fetchQueryRows, num, QUERIES, REVALIDATE_SECONDS } from "@/lib/dune";

// Must be a literal — Next.js statically analyzes it
export const revalidate = 60;

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

  // Trend deltas — try to read 7d-vs-prev-7d from query 7507075 if present
  const tr = (trends[0] ?? {}) as Record<string, unknown>;
  const weekDeltaUSDC = num(tr.usdc_7d_delta_pct ?? tr.delta_usdc_7d ?? 0);
  const weekDeltaPayments = num(tr.payments_7d_delta_pct ?? tr.delta_payments_7d ?? 0);
  const paymentsToday = num(tr.payments_24h ?? tr.txs_24h ?? 0);

  // Newest payment timestamp from the activity feed
  const lastPaymentAt = (recentPayments[0] as Record<string, unknown> | undefined)
    ? s(recentPayments[0] as Record<string, unknown>, "block_time", "timestamp", "ts")
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

  // Heatmap
  const heatPoints: HeatPoint[] = (heatmap as Record<string, unknown>[]).map((r) => ({
    hour: n(r, "hour", "hour_of_day"),
    day_of_week: n(r, "day_of_week", "dow"),
    count: n(r, "payments", "count", "n"),
  }));

  // Concentration (try to normalize: top 1% / 10% / 50% / rest)
  const concRows: ConcentrationRow[] = (concentration as Record<string, unknown>[]).map((r) => ({
    bucket: s(r, "bucket", "cohort", "label"),
    payers: n(r, "payers", "n_payers"),
    payments: n(r, "payments", "total_payments"),
    share: n(r, "share_pct", "pct", "share"),
  }));

  // Recent payments — normalize columns
  const paymentRows: PaymentRow[] = (recentPayments as Record<string, unknown>[]).map((r) => ({
    wallet: s(r, "payer", "from", "wallet").toLowerCase(),
    amount_usdc: n(r, "amount_usdc", "usdc", "amount"),
    block_time: s(r, "block_time", "timestamp", "ts"),
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
