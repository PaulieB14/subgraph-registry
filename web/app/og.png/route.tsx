import { ImageResponse } from "next/og";
import { fetchDaily, fetchLifetimeTotals } from "@/lib/subgraph";

// Served as an explicit route rather than Next's opengraph-image file
// convention. That convention appends a cache-busting hash as a BARE query key
// ("/opengraph-image?3e3659d3a1a117e1" — a key with no "="), and some social
// crawlers refuse to fetch a URL with a malformed query string. A plain
// "/og.png" removes that variable entirely.
const size = { width: 1200, height: 630 };

// The card is generated per request so a share posted during a spike shows the
// spike. It must never be the reason a share fails, so every number is fetched
// inside a try/catch and the card still renders (without stats) if the subgraph
// is unreachable.
export const revalidate = 300;

function compactUsd(n: number) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

export async function GET() {
  let totalUsdc: number | null = null;
  let totalPayments: number | null = null;
  let today: number | null = null;

  try {
    const [totals, daily] = await Promise.all([fetchLifetimeTotals(), fetchDaily()]);
    totalUsdc = totals.total_usdc;
    totalPayments = totals.total_payments;
    const todayKey = new Date().toISOString().slice(0, 10);
    today = daily.find((d) => d.day === todayKey)?.payments ?? 0;
  } catch {
    // Leave the stats null — the card degrades to title + tagline rather than
    // rendering a broken preview or 500ing the share.
  }

  const stats: Array<[string, string]> = [];
  if (totalUsdc !== null) stats.push([compactUsd(totalUsdc), "total USDC"]);
  if (totalPayments !== null) stats.push([totalPayments.toLocaleString(), "payments"]);
  if (today !== null && today > 0) stats.push([today.toLocaleString(), "today"]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(135deg, #050810 0%, #0a1024 55%, #0d1b2e 100%)",
          color: "#f8fafc",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                background: "#22d3ee",
                marginRight: 16,
                display: "flex",
              }}
            />
            <div style={{ fontSize: 26, letterSpacing: 2, color: "#22d3ee", display: "flex" }}>
              LIVE ON BASE
            </div>
          </div>
          <div style={{ fontSize: 92, fontWeight: 700, marginTop: 18, display: "flex" }}>
            x402 Watch
          </div>
          <div
            style={{
              fontSize: 34,
              color: "#94a3b8",
              marginTop: 12,
              display: "flex",
              maxWidth: 900,
            }}
          >
            Agent payments to The Graph, with ERC-8004 identity attribution
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex" }}>
            {stats.map(([value, label]) => (
              <div
                key={label}
                style={{ display: "flex", flexDirection: "column", marginRight: 72 }}
              >
                <div style={{ fontSize: 68, fontWeight: 700, display: "flex" }}>{value}</div>
                <div
                  style={{
                    fontSize: 26,
                    color: "#64748b",
                    letterSpacing: 1,
                    marginTop: 4,
                    display: "flex",
                  }}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 24, color: "#475569", display: "flex" }}>
            data via The Graph
          </div>
        </div>
      </div>
    ),
    size,
  );
}
