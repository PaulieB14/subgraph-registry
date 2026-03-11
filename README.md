# Subgraph Registry

Agent-friendly semantic classification of all subgraphs on [The Graph Network](https://thegraph.com).

Pre-computed index of 15,500+ subgraphs with domain classification, protocol type detection, schema fingerprinting, canonical entity mapping, and composite reliability scoring.

## The Problem

Agents querying The Graph need to discover and select the right subgraph before they can query data. Today this requires 3-4 tool calls (search, check volumes, fetch schema, infer structure) before any real work happens. This registry flips that: agents start with structured knowledge, not a blank slate.

## What It Does

1. **Crawls** all active subgraphs from the Graph Network meta-subgraph (subgraphs indexing subgraphs)
2. **Fetches** the GraphQL schema for every deployment
3. **Classifies** each subgraph by:
   - **Domain**: DeFi, NFTs, DAOs, Gaming, Identity, Infrastructure, Social, Analytics
   - **Protocol Type**: DEX, Lending, Bridge, Staking, Options, Perpetuals, Marketplace, etc.
   - **Canonical Entities**: Maps schema types to a standard vocabulary (Pool -> `liquidity_pool`, Swap -> `trade`, etc.)
   - **Schema Family**: Groups forks/clones by schema fingerprint
4. **Scores** reliability using on-chain signal (curation signal, indexer stake, query fees)
5. **Publishes** as JSON registry + SQLite database + REST API

## Quick Start

```bash
cd python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Create .env with your Graph API key
echo "GATEWAY_API_KEY=your-key-here" > .env

# Full crawl + classify (all 15K+ subgraphs, ~11 min)
python registry.py

# Or limit to top N by signal
python registry.py --max 500

# Start API server
python server.py
```

## API Endpoints

```
GET /summary                    Registry overview and stats
GET /domains                    Domain breakdown
GET /networks                   Network breakdown
GET /families                   Schema family groups (fork/clone detection)
GET /subgraphs                  Filter subgraphs
GET /subgraphs/{id}             Full detail for one subgraph
GET /search?q=uniswap           Free-text search
GET /recommend?goal=...&chain=  Agent-optimized recommendation
```

### Example: Agent Recommendation

```bash
curl "http://localhost:3847/recommend?goal=query+DEX+trades+on+Arbitrum&chain=arbitrum-one"
```

Returns the top subgraphs matching the intent, with reliability scores and query instructions.

### Example: Filter by Entity Type

```bash
curl "http://localhost:3847/subgraphs?entity=liquidity_pool&network=base&min_reliability=0.5"
```

## Weekly Sync

```bash
# Run weekly incremental updates (only fetches new/changed subgraphs)
python scheduler.py

# One-shot incremental
python scheduler.py --once
```

## Architecture

```
Graph Network Subgraph (meta-subgraph, 140M queries/month)
    |
    v
crawler.py ---- async httpx, ID-based cursor pagination (bypasses 5K skip limit)
    |
    v
classifier.py - rule-based domain/protocol classification + schema fingerprinting
    |
    v
registry.py --- builds JSON registry + SQLite + indices
    |
    v
server.py ----- FastAPI REST API with /recommend endpoint
    |
    v
scheduler.py -- weekly incremental sync via updatedAt filtering
```

## Output

| File | Size | Description |
|---|---|---|
| `registry.json` | ~130 MB | Full registry with all entity details |
| `registry.db` | ~8 MB | SQLite with indexed lookups |
| `sync-state.json` | <1 KB | Last sync timestamp for incremental updates |

## Classification Results (as of March 2026)

| Domain | Count | | Network | Count |
|---|---|---|---|---|
| DeFi | 11,841 | | Ethereum | 2,471 |
| NFTs | 893 | | Base | 1,845 |
| Infrastructure | 602 | | BSC | 1,664 |
| DAO | 450 | | Arbitrum | 1,442 |
| Identity | 424 | | Polygon | 1,364 |
| Analytics | 348 | | Optimism | 593 |
| Gaming | 255 | | Avalanche | 454 |
| Social | 78 | | | |

## How It Stays Current

The Graph Network subgraph indexes all subgraph deployments on-chain. The crawler queries `updatedAt_gte: lastSyncTimestamp` to fetch only what changed since the last run. Weekly syncs keep the registry fresh without full rebuilds.

## License

MIT
