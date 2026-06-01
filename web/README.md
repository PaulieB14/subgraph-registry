# x402 Watch

Live tracker of x402 micropayments on Base, with ERC-8004 agent attribution.

**Current scope:** payments to The Graph's gateway (`0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB`).
Easy to broaden later — every panel reads from Dune queries that can be cloned per receiver.

**Stack:** Next.js 15 (App Router) · Tailwind · Recharts · Vercel · Dune API
**Refresh:** every 60s server-side via ISR (no client polling)
**Data sources:** the 14 Dune queries already maintained by `.github/workflows/refresh-x402-dune.yml`, plus the agent identity directory rebuilt nightly by `scripts/refresh_known_agents.py`.

## Local dev

```bash
cd web
npm install
DUNE_API_KEY=… npm run dev
open http://localhost:3000
```

## Deploy to Vercel

1. Import this repo into Vercel.
2. Set the project **Root Directory** to `web`.
3. Add env var `DUNE_API_KEY` (Production + Preview).
4. Deploy.

No DB, no cron, no auth. Server components fetch Dune via revalidating fetch; Vercel's edge network handles caching.

## Panels

- **Hero** — total USDC · payments · identified agents · repeat agents (with week-over-week deltas)
- **Cumulative USDC** — running total area chart
- **Daily payments** — bar + 7-day moving average
- **Agent leaderboard** — every paying agent we can identify, name → 8004scan link
- **Recent activity** — last 20 payments, agent-attributed where known
- **New vs returning** — weekly stack of first-time vs returning agents
- **Concentration** — payer cohorts (whales vs long tail)
- **Activity heatmap** — hour-of-day × day-of-week (UTC)

Every agent row is clickable — opens that agent's 8004scan detail page.

## Why this exists

Dune already hosts the queries. This site is just a polished, agent-aware face: it foregrounds the "who's paying" question that Dune's generic UI buries.
