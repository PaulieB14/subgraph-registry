import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { AgentLeaderboard } from "@/components/AgentLeaderboard";
import { Concentration } from "@/components/Concentration";
import { CumulativeChart } from "@/components/CumulativeChart";
import { DailyChart } from "@/components/DailyChart";
import { Hero, type HeroStats } from "@/components/Hero";
import { NewVsReturning } from "@/components/NewVsReturning";
import { RecentActivity } from "@/components/RecentActivity";
import { identifyAgents } from "@/lib/identifyAgents";
import {
  deriveNewVsReturningByWeek,
  fetchActivityHeatmap,
  fetchConcentration,
  fetchCumulative,
  fetchDaily,
  fetchLifetimeTotals,
  fetchNewPayers,
  fetchRecentPayments,
  fetchTopPayers,
  fetchTrends,
  REVALIDATE_SECONDS,
} from "@/lib/subgraph";

// Subgraph data is live; revalidate every 5 minutes (set in subgraph.ts).
// Previous architecture relied on a daily Dune cron (revalidate=86400);
// migrating to the x402-omnigraph subgraph lets the dashboard feel real-time
// without burning gateway query budget.
export const revalidate = REVALIDATE_SECONDS;

function extractAgentName(agent: string): string {
  const m = /^\[([^\]]+)\]/.exec(agent);
  return m ? m[1] : agent;
}
function extractAgentLink(agent: string, fallback: string): string {
  const m = /\(([^)]+)\)$/.exec(agent);
  return m ? m[1] : fallback;
}

export default async function Page() {
  // All gateway-scoped panels derive from a single paginated payment fetch
  // memoized inside subgraph.ts; the parallel Promise.all here is mostly
  // about keeping the call graph readable.
  const [
    lifetime,
    daily,
    cumulative,
    newPayers,
    paymentRows,
    heatPoints,
    concRows,
    topPayers,
    trends,
  ] = await Promise.all([
    fetchLifetimeTotals(),
    fetchDaily(),
    fetchCumulative(),
    fetchNewPayers(),
    fetchRecentPayments(50),
    fetchActivityHeatmap(),
    fetchConcentration(),
    fetchTopPayers(),
    fetchTrends(),
  ]);

  // Agent identity is the only off-subgraph data: enriched at build time via
  // 8004scan + agent0. With backoff + skip-on-429, this degrades gracefully
  // if 8004scan is rate-limiting.
  const agentRows = await identifyAgents(topPayers);

  const identityByWallet = new Map<string, { name: string; link: string }>();
  for (const a of agentRows) {
    const name = extractAgentName(a.agent);
    const link = extractAgentLink(a.agent, a.agent_link);
    identityByWallet.set(a.wallet, { name, link });
  }

  const agentsRepeat = agentRows.filter((a) => a.payments > 1).length;

  // Hero numbers
  const totalUSDC = lifetime.total_usdc;
  const totalPayments = lifetime.total_payments;

  // WoW delta = 7d vs (30d-7d)/3 (prior-3-week average) for stability on
  // early data. Identical formula to the previous Dune-backed version.
  const paymentsToday = trends.payments_24h;
  const payments7d = trends.payments_7d;
  const usdc7d = trends.usdc_7d;
  const payments30d = trends.payments_30d;
  const usdc30d = trends.usdc_30d;
  const priorWeeklyAvg_payments = Math.max(0, (payments30d - payments7d) / 3);
  const priorWeeklyAvg_usdc = Math.max(0, (usdc30d - usdc7d) / 3);
  const weekDeltaPayments = priorWeeklyAvg_payments > 0
    ? ((payments7d - priorWeeklyAvg_payments) / priorWeeklyAvg_payments) * 100
    : 0;
  const weekDeltaUSDC = priorWeeklyAvg_usdc > 0
    ? ((usdc7d - priorWeeklyAvg_usdc) / priorWeeklyAvg_usdc) * 100
    : 0;

  const lastPaymentAt = paymentRows[0]?.block_time ?? lifetime.last_payment_at ?? "";

  // This-week new agents from the directory (first-seen >= 7d ago)
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

  // New vs returning weekly cohort
  const nrPoints = deriveNewVsReturningByWeek(daily, newPayers);

  return (
    <>
      <Hero stats={heroStats} />

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CumulativeChart data={cumulative} />
        <DailyChart data={daily} />
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
          Onchain data via the{" "}
          <a
            className="text-muted hover:text-accent"
            href="https://thegraph.com/explorer/subgraphs/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj"
            target="_blank"
            rel="noopener noreferrer"
          >
            x402-omnigraph subgraph
          </a>
          {" · "}
          agent identity via{" "}
          <a className="text-muted hover:text-accent" href="https://8004scan.io" target="_blank" rel="noopener noreferrer">
            8004scan
          </a>{" "}
          +{" "}
          <a className="text-muted hover:text-accent" href="https://thegraph.com" target="_blank" rel="noopener noreferrer">
            The Graph
          </a>{" "}
          agent0 subgraph
        </span>
        <span>live · 5-min revalidate</span>
      </footer>
    </>
  );
}
