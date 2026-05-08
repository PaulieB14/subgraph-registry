---
name: subgraph-registry-mcp
description: Discover and filter 15,500+ The Graph subgraphs by domain, network, protocol type, or natural language goal with reliability scores and query URLs.
metadata:
  {"openclaw": {"requires": {"bins": ["node"]}, "homepage": "https://github.com/PaulieB14/subgraph-registry"}}
---

# Subgraph Registry

Agent-friendly discovery of 15,500+ classified subgraphs on The Graph Network. Search by domain, network, protocol type, or natural language goal — get reliability-scored results with query URLs.

## Tools

- **search_subgraphs** — Filter by domain (defi, nfts, dao, gaming), network (ethereum, arbitrum, base), protocol type (dex, lending, bridge), entity type, or keyword
- **recommend_subgraph** — Natural language goal like "find DEX trades on Arbitrum" returns the best matching subgraphs
- **get_subgraph_detail** — Full classification, entities, reliability score, and query instructions for a specific subgraph
- **list_registry_stats** — Registry overview with available domains, networks, and protocol types

## Requirements

- **Runtime:** Node.js >= 18 (runs via `npx`)
- **Environment variables:** None required. The registry is pre-built and bundled — no API key needed for read-only use.

## Install

Pin a known-good version. Audit the source on GitHub before installing if you
plan to ship this in an autonomous-agent runtime.

```bash
# Pin to a published version, do not run unpinned (`npx subgraph-registry-mcp`
# without @VERSION will pull whatever's latest at the moment).
npx subgraph-registry-mcp@0.5.0
```

## Network & Data Behavior

- On first run, the server downloads a pre-built `registry.db` (SQLite) from the [GitHub repository](https://github.com/PaulieB14/subgraph-registry) (~5 MB). This is cached locally and reused on subsequent runs.
- The downloaded file's SHA-256 is **verified against a hash pinned in the npm package** before loading — see "Verifying the registry" below. A mismatched file is deleted and the server refuses to start.
- All tool queries run against this local database — no external API calls are made at query time.
- The SSE transport (`--http` / `--http-only`) starts a local HTTP server on port 3848 (configurable via `MCP_HTTP_PORT` env var). Bind only to trusted environments.

## Verifying the registry

The npm package version `0.5.0` ships with this expected hash:

```
SHA-256(registry.db) = f81b79c53cc13c3428472024187fc7fd502f7418f5da20f0a6e01807dd4011c6
```

This hash is hard-coded in `src/index.js` (`EXPECTED_DB_SHA256`). On every run,
the server checks the cached or freshly-downloaded `registry.db` against it. If
the hashes don't match — which would happen if the GitHub-hosted file were
swapped, or your local cache were tampered with — the server **refuses to load
the database** and exits with an error. The bad file is deleted so the next run
attempts a fresh download.

Verify manually:

```bash
shasum -a 256 ~/.npm/_npx/*/node_modules/subgraph-registry-mcp/data/registry.db
# (path varies by npx cache layout; the file is the one referenced as
# `data/registry.db` inside the package)
```

If you intentionally rebuilt the DB locally (using the optional Python
crawler), the hash will not match. Set `SUBGRAPH_REGISTRY_SKIP_VERIFY=1` to
bypass — never set this in an agent-runtime default config.

When the registry is regenerated, the maintainer bumps the npm version *and*
updates the hash constant atomically — so a given npm version uniquely
corresponds to a known DB.

## Use Cases

- Discover the right subgraph before querying The Graph
- Find high-reliability DeFi, NFT, DAO, or governance subgraphs by chain
- Get query URLs and entity schemas without manual exploration
- Compare subgraphs by reliability score (query fees, curation signal, indexer stake)
