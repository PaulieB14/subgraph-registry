---
name: subgraph-registry-mcp
description: Same abilities as graphops/subgraph-mcp with better discovery. Search 15,000+ classified subgraphs; real 30-day query volume on every hit; opt-in schema and execute under the official tool names. Discovery tools never auto-query.
metadata:
  {"openclaw": {"requires": {"bins": ["node"]}, "homepage": "https://github.com/PaulieB14/subgraph-registry"}}
---

# Subgraph Registry

Same abilities as [graphops/subgraph-mcp](https://github.com/graphops/subgraph-mcp) (hosted SSE `https://subgraphs.mcp.thegraph.com/sse`), **better discovery**. Search/recommend/semantic stay DISCOVERY — they never execute GraphQL. Schema and execute are opt-in and use the **same tool names** as official so an agent can swap connectors. Volume is already on every search hit (`query_volume_30d`) — skip official's extra `get_deployment_30day_query_counts` round-trip. Official that tool has been observed returning 0 for ENS/Lido/Uniswap; this registry does not copy those zeros. No private key. Set `THE_GRAPH_STUDIO_API_KEY` (or `GATEWAY_API_KEY`) for execute/live-schema; without a key those tools return `credentials_required` + both URLs and do not hang or auto-pay x402.

## Tools

### Discovery (local index, no gateway)

- **search_subgraphs** — Beats official `search_subgraphs_by_keyword`. Filter by domain, network (ethereum/arbitrum/base aliases resolve to mainnet/arbitrum-one/etc.), protocol type, entity, or keyword. Testnets excluded by default. Every hit carries `query_volume_30d`, `reliability_score`, `network`, `age_days`, `maturity`, `example_query`, and both query routes, plus a separate `emerging` list — read `emerging_caveat` before recommending one
- **recommend_subgraph** — Natural language goal like "find DEX trades on Arbitrum" returns the best matching subgraphs
- **get_subgraph_detail** — Full classification, crawled `contract_addresses`, entities, reliability, both query URLs
- **list_registry_stats** — Registry overview with available domains, networks, and protocol types
- **semantic_search_subgraphs** — Embedding-based natural-language search. Uses a bundled ONNX model via `@xenova/transformers`; **if the bundled model is missing it downloads it once from Hugging Face** (see Network & Data Behavior). Skip this tool for a strictly offline runtime.
- **get_schema_changes** — Report schema/entity changes for a subgraph across indexed versions

### Official-name tools (swap-in for graphops/subgraph-mcp)

- **get_schema_by_subgraph_id** / **get_schema_by_deployment_id** / **get_schema_by_ipfs_hash** — Opt-in. Local `registry_schema` with no network when in the corpus; live `__schema` only if a Studio key is set; otherwise `credentials_required` + URLs. Discovery never introspects.
- **execute_query_by_subgraph_id** / **execute_query_by_deployment_id** / **execute_query_by_ipfs_hash** — Opt-in POST to The Graph gateway. Same routing as official (`subgraphs/id` vs `deployments/id`). Without a key: `credentials_required` immediately. Gateway often returns HTTP 200 with a GraphQL error body when auth is missing; `http_status` and `errors` are surfaced honestly. Does not auto-pay x402.
- **execute_query** / **get_schema** — Convenience supersets: one tool that accepts `id` OR `deployment_id` OR `ipfs_hash`.
- **get_top_subgraph_deployments** — `(contract_address, chain)` like official. Official `chain` is `mainnet` (not `ethereum`); we accept both. Ranked by reliability then real volume from crawled manifests, default 3. Substreams gap is reported, not faked.
- **get_deployment_30day_query_counts** — Official name, `ipfs_hashes` in. Returns registry `query_volume_30d` (real). Unknown hashes are `not_in_registry`, never a fake 0. Usually unnecessary — the same number is already on every search hit.

## Query paths

Every discovery result ships with two URLs in `payment_options` (neither is labelled recommended — pick by what you have):

- **`query_url`** — `https://gateway.thegraph.com/api/subgraphs/id/{id}`. POST GraphQL with header `Authorization: Bearer <STUDIO_API_KEY>`. Get a key at [thegraph.com/studio/apikeys](https://thegraph.com/studio/apikeys/). The gateway often returns HTTP 200 with a GraphQL error body when the header is missing — read the body.
- **`query_url_x402`** — `https://gateway.thegraph.com/api/x402/subgraphs/id/{id}`. POST; gateway returns HTTP 402; an x402 client signs **$0.01 USDC on Base**. This server never auto-pays.

Optional next step after discovery: `execute_query_by_subgraph_id` (or `execute_query`) with the `id` and GraphQL, if a Studio key is in env.

## Requirements

- **Runtime:** Node.js >= 18 (runs via `npx`)
- **Environment variables:** None required for discovery. For opt-in execute / live schema: `THE_GRAPH_STUDIO_API_KEY` (preferred) or `GATEWAY_API_KEY` (official subgraph-MCP name). No private key is in the package.
- **For x402 queries you run yourself:** USDC on Base in the agent's signing wallet (one query ≈ $0.01).

## Install

Pin a known-good version. Audit the source on GitHub before installing if you
plan to ship this in an autonomous-agent runtime.

```bash
# Pin to a published version, do not run unpinned (`npx subgraph-registry-mcp`
# without @VERSION will pull whatever's latest at the moment).
npx subgraph-registry-mcp@0.9.13
```

## Network & Data Behavior

- The `registry.db` (SQLite) is **bundled inside the npm package** — no download and no API key needed for read-only use. (If it's ever missing, e.g. a bare source checkout, the server falls back to downloading it from the [GitHub repository](https://github.com/PaulieB14/subgraph-registry).)
- The downloaded file's SHA-256 is **verified against a hash pinned in the npm package** before loading — see "Verifying the registry" below. A mismatched file is deleted and the server refuses to start.
- Discovery tools (`search_subgraphs`, `recommend_subgraph`, `get_subgraph_detail`, `list_registry_stats`, `get_schema_changes`, `get_top_subgraph_deployments`, `get_deployment_30day_query_counts`) run entirely against the local database — no external API calls at query time.
- **Exception — `semantic_search_subgraphs`:** it loads a bundled ONNX embedding model via `@xenova/transformers`. If that bundled model is not present, the runtime downloads it **once** from Hugging Face (`huggingface.co`), then caches it.
- **Exception — opt-in execute / live schema:** `execute_query*` and live `__schema` on `get_schema*` POST to `gateway.thegraph.com` **only when** `THE_GRAPH_STUDIO_API_KEY` (or `GATEWAY_API_KEY`) is set AND the caller invoked that tool. Without a key they return `credentials_required` with both URLs and do not touch the network. Discovery tools never take this path.
- **Optional local HTTP/SSE server:** default transport is **stdio** (no listener). Passing `--http` or `--http-only` starts a local HTTP/SSE server on port 3848 (`MCP_HTTP_PORT` to change), exposing `/messages`, health, and OpenAPI/manifest endpoints. It is off unless you pass those flags — bind only to trusted/firewalled environments.

## Verifying the registry

The npm package version `0.9.13` ships with this expected hash:

```
SHA-256(registry.db) = f5b6d5a1743c65ba11032036a935fb6742568be6b0b33d05ffdc9459d2b952f9
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

- Drop-in for official subgraph-MCP schema/execute/contract tools, with better search
- Discover the right subgraph before querying The Graph — volume is already on the hit, no extra counts call
- Find high-reliability DeFi, NFT, DAO, or governance subgraphs by chain
- Opt-in execute GraphQL when the caller wants data, with a Studio key from env
- Compare subgraphs by reliability score (query fees, volume, curation signal, indexer stake)
