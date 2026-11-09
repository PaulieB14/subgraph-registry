---
name: subgraph-registry-mcp
description: Use to discover The Graph subgraphs by chain, protocol, entity or contract and prepare bounded GraphQL starters. Includes API-key onboarding and explicitly paid external x402 guidance; discovery never executes queries or signs payments.
metadata:
  {"openclaw": {"requires": {"bins": ["node"]}, "homepage": "https://github.com/PaulieB14/subgraph-registry"}}
---

# Subgraph Registry

Same abilities as [graphops/subgraph-mcp](https://github.com/graphops/subgraph-mcp) (hosted SSE `https://subgraphs.mcp.thegraph.com/sse`), **better discovery**. Search/recommend/semantic stay DISCOVERY — they never execute GraphQL. Schema and execute are opt-in and use the **same tool names** as official so an agent can swap connectors. Volume is already on every search hit (`query_volume_30d`) — skip official's extra `get_deployment_30day_query_counts` round-trip. Official that tool has been observed returning 0 for ENS/Lido/Uniswap; this registry does not copy those zeros. No private key. Set `THE_GRAPH_STUDIO_API_KEY` (or `GATEWAY_API_KEY`) for execute/live-schema; without a key those tools return `credentials_required` + both URLs and do not hang or auto-pay x402.

## Agent quick path: connect → discover → prepare → opt in

1. **Connect a reviewed, pinned release.** This is the canonical shareable skill;
   share this file with the GitHub repository, not a second `skills.md` recipe.
   For a stdio MCP host, start with this keyless configuration:

   ```json
   {"mcpServers":{"subgraph-registry":{"command":"npx","args":["-y","subgraph-registry-mcp@0.11.0"]}}}
   ```

   Inspect `tools/list` before calling a tool. Keyless 0.11.0 advertises 10
   discovery/preparation tools; execution/schema/health tools are advertised only
   when a Studio key is configured. A mounted connector can use another runtime
   or corpus: do not assume installing a release updates an existing connector.
2. **Discover with explicit chain identity.** For example, call
   `search_subgraphs({"network":"arc","include_unserved":true,"limit":3})`.
   This explicitly broadens discovery to zero-allocation snapshot records; it
   does **not** probe them or establish serving health. `arc` is mainnet;
   `arc-testnet` is different. Other examples: `ethereum`→`mainnet`,
   `arbitrum`→`arbitrum-one`, `polygon`→`matic`, `sei`→`sei-mainnet`.
   Use `query:"ens"` for a protocol and `network` for its chain. Inspect
   `emerging`, network and testnet labels, not just reliability. If results are
   empty, inspect `diagnostics` when available; otherwise check registry stats
   and deliberately broaden the relevant `include_*` flag. Never interpret an
   empty snapshot as proof that a chain or queryable Subgraph does not exist.
3. **Reuse an existing Studio key; otherwise help a human create one.**
   Open [Studio API Keys](https://thegraph.com/studio/apikeys/) and have the human
   create/manage the key. There is no automated key-minting API in this server.
   Store it via the MCP host's secret manager as `THE_GRAPH_STUDIO_API_KEY`
   (or `GATEWAY_API_KEY`); never ask for it in ordinary chat or put it in tool
   arguments, source, URLs or logs. Reload only the intended host as its setup
   requires. A configured key is not proof that it is valid or has free quota.
   [Official pricing](https://thegraph.com/studio-pricing/) advertises **100,000
   free monthly queries**; check the account's current plan and remaining usage.
   This is not a fresh allowance per key. Studio development endpoints have
   separate limits; do not promise every endpoint has this allowance.
4. **Prepare without spending.** If advertised, call
   `query_for_goal({"goal":"Uniswap v3 pools on Ethereum","first":2,"execute":false})`.
   Inspect `selected`, `query`, `request` and validation labels. A bounded stored
   starter is **not** a generated goal-specific answer or a live-schema check.
   Use local detail/schema metadata and, with a configured key, opt-in schema
   introspection before relying on fields. With an older six-tool connector,
   use `recommend_subgraph` / `get_subgraph_detail` and its stored starter instead.
5. **Execute only when requested and authorized.** With a configured Studio key
   and execution tool available, use `execute_query` with the selected identifier
   and reviewed query. A direct keyed client uses the returned fixed gateway URL
   and `Authorization: Bearer <STUDIO_API_KEY>`; never print the actual header.
   `query_for_goal` with explicit `execute:true` is another opt-in path after
   inspecting the starter; preparation alone never sends a query.
6. **Read errors and evidence.** HTTP 200 can contain GraphQL `errors` or partial
   `data`. Report them, don't claim success from HTTP status alone. For missing
   credentials follow step 3; for quota/billing errors stop rather than silently
   switching to a paid route. Health observations are process-local, stale after
   300 seconds, and do not prove chain-head sync. No observation means unknown.

**Across ALL chains:** rewards/curation eligibility, on-chain allocation counts,
query demand and actual query availability are distinct. A chain can serve data
before rewards or curation signaling are enabled. `include_unserved` is a legacy
flag name for including zero-allocation **snapshot** records, not a declaration
that those records cannot be queried. `denied` means the recorded deployment was
denied indexing rewards, not proof it is malicious or unavailable. The corpus
does not establish every chain's current rewards/signaling eligibility and does
not include every Studio-only deployment. See [supported network modes](https://thegraph.com/docs/en/supported-networks/).

**Paid alternative, never a fallback without consent:** external x402 clients can
sign a USDC payment authorization and retry automatically. This is a financial
capability of that external client, NOT this MCP server. Require the owner's
explicit approval of the payment/amount before using a funded signing client;
do not run the README payment example just because a free/keyed request failed.

## New agent workflow (Node MCP)

- `find_by_contract(address, chain?, limit=3)`: exact normalized EVM manifest lookup; optional chain, limit 1–20. `schema_entities` cover the deployment, not a verified contract/entity mapping. Missing dynamic/substreams coverage is explicit.
- `check_subgraph_health(id | subgraph_id | ipfs_hash | deployment_id)`: opt-in, Studio-key-only fixed `_meta` request; known IDs pin the crawled deployment. `freshness.live` is measured, process-local, stale after 300 seconds, null before observation. Serving is not chain-head sync. `registry_updated_at` is upstream metadata time, not health/crawl time.
- `query_for_goal(goal, chain?, first=5, execute=false)`: local recommendation + bounded starter + unsigned request payload. No calls by default, even with a key. Only `execute:true` with a Studio key performs one pinned gateway query. First is 1–10; no retry, fallback execution, arbitrary endpoint or x402 payment. Syntax/structure checks are not live-schema validation; inspect whether the example starter answers the goal. Execution errors/partial data are surfaced.

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

- **Runtime:** Node.js 20 is CI-tested (runs via pinned `npx`); install native dependencies for the Node major you actually run
- **Environment variables:** None required for discovery. For opt-in execute / live schema: `THE_GRAPH_STUDIO_API_KEY` (preferred) or `GATEWAY_API_KEY` (official subgraph-MCP name). No private key is in the package.
- **For x402 queries you run yourself:** USDC on Base in the agent's signing wallet (one query ≈ $0.01).

## Install

Pin a known-good version. Audit the source on GitHub before installing if you
plan to ship this in an autonomous-agent runtime.

```bash
# Pin to a published version, do not run unpinned (`npx subgraph-registry-mcp`
# without @VERSION will pull whatever's latest at the moment).
npx subgraph-registry-mcp@0.11.0
```

## Network & Data Behavior

- The `registry.db` (SQLite) is **bundled inside the npm package** — no download and no API key needed for read-only use. (If it's ever missing, e.g. a bare source checkout, the server falls back to downloading it from the [GitHub repository](https://github.com/PaulieB14/subgraph-registry).)
- The downloaded file's SHA-256 is **verified against a hash pinned in the npm package** before loading — see "Verifying the registry" below. A mismatched file is deleted and the server refuses to start.
- Discovery tools (`search_subgraphs`, `recommend_subgraph`, `get_subgraph_detail`, `list_registry_stats`, `get_schema_changes`, `get_top_subgraph_deployments`, `find_by_contract`, `get_deployment_30day_query_counts`) run entirely against the local database — no external API calls at query time.
- **Exception — `semantic_search_subgraphs`:** it loads a bundled ONNX embedding model via `@xenova/transformers`. If that bundled model is not present, the runtime downloads it **once** from Hugging Face (`huggingface.co`), then caches it.
- **Exception — opt-in execute / live schema:** `execute_query*`, `check_subgraph_health`, `query_for_goal` with explicit `execute:true`, and live `__schema` on `get_schema*` POST to `gateway.thegraph.com` **only when** `THE_GRAPH_STUDIO_API_KEY` (or `GATEWAY_API_KEY`) is set AND the caller invoked that tool. Without a key they return `credentials_required` with both URLs and do not touch the network. Discovery tools never take this path.
- **Optional local HTTP/SSE server:** default transport is **stdio** (no listener). Passing `--http` or `--http-only` starts a local HTTP/SSE server on port 3848 (`MCP_HTTP_PORT` to change), exposing `/messages`, health, and OpenAPI/manifest endpoints. It is off unless you pass those flags — bind only to trusted/firewalled environments.

## Verifying the registry

The npm package version `0.11.0` ships with this expected hash:

```
SHA-256(registry.db) = 672afa2f0d405483af5fb4c403e515fb0f1342c7eeb31968e78a53d5f6ebdd6b
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
