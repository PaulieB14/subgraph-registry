# Bounded agent usability audit

## Scope and reproduction

> Status: the audited changes were released in 0.12.0 (together with goal-specific `query_for_goal`).

Audit performed November 8, 2026, approximately 9:12–9:22 PM EST. This report distinguishes the connected runtime, immutable published 0.11.0 bytes, and the **unreleased changes in this PR**. The package version is not bumped here; no release, tag, merge, deploy, connector restart, or production crawl is performed.

- `node scripts/audit-discovery.mjs [entrypoint] [report.json]` drives a real MCP SDK stdio handshake, `tools/list`, and tool calls. It reports 30 scenarios and exits nonzero when expectations fail.
- Published entrypoint was unpacked from the verified public 0.11.0 tarball. Its SHA-512 integrity matched the validated artifact for source `0e2ce3a825a96c73e7846d3d5c104cbe45f9df13`. It used the existing compatible dependency installation, not a fresh independent dependency resolution.
- Run with Node 20 (the CI version); the box default Node 24 cannot load the existing Node-20-built native SQLite module. That environment mismatch is not attributed to package source.
- Both SDK runs explicitly clear Studio/gateway credentials. The audit requires the bundled model and refuses its network-download fallback. No gateway query or payment was sent.
- Published package advertises 10 keyless tools, including contract lookup and goal preparation. Health/schema/execute are keyed capabilities; direct keyless health invocation returns `credentials_required`.
- Current branch: **30/30** expectations passed; published package: **21/30**. Passing interface/boundary checks does not establish financial safety, live schema correctness, or ideal semantic relevance.

## Same thirty SDK scenarios

| Scenario and reproducible input | Published 0.11.0 | PR behavior |
|---|---|---|
| chain-only Arc<br>`search_subgraphs {"query":"arc","limit":3}` | FAIL: Aave ARC Ethereum [mainnet]; Uniswap V4 - Arc [arc]; YAK ARC [avalanche] | PASS: argus [arc]; arguspad [arc]; Uniswap V4 - Arc [arc] |
| explicit Arc<br>`search_subgraphs {"network":"arc","limit":5}` | PASS: argus [arc]; arguspad [arc]; Uniswap V4 - Arc [arc] | PASS: argus [arc]; arguspad [arc]; Uniswap V4 - Arc [arc] |
| Arc testnet distinct<br>`search_subgraphs {"network":"arc-testnet","limit":3}` | PASS: quadmarket-arc-testnet [arc-testnet]; MargitArc [arc-testnet]; arc-studio [arc-testnet] | PASS: quadmarket-arc-testnet [arc-testnet]; MargitArc [arc-testnet]; arc-studio [arc-testnet] |
| Ethereum alias<br>`search_subgraphs {"query":"uniswap v3","network":"ETHEREUM","limit":3}` | PASS: Uniswap-V3 [mainnet]; Uniswap V3 Mainnet [mainnet]; Uniswap V3 Ethereum [mainnet] | PASS: Uniswap-V3 [mainnet]; Uniswap V3 Mainnet [mainnet]; Uniswap V3 Ethereum [mainnet] |
| Polygon alias<br>`search_subgraphs {"network":"polygon","limit":3}` | PASS: streamr [matic]; uniswap-v3-matic [matic]; QuickSwap V3 [matic] | PASS: streamr [matic]; uniswap-v3-matic [matic]; QuickSwap V3 [matic] |
| unknown chain explanation<br>`search_subgraphs {"network":"arcc","limit":3}` | FAIL: returned 0 | PASS: returned 0 |
| ENS exact protocol<br>`search_subgraphs {"query":"ens","limit":3}` | FAIL: ENS reclaim deposit subgraph [mainnet]; ENS [mainnet]; ens-subgraph [mainnet] | PASS: ENS [mainnet]; ENS reclaim deposit subgraph [mainnet]; ens-subgraph [mainnet] |
| Uniswap protocol version<br>`search_subgraphs {"query":"uniswap v4","network":"base","limit":3}` | PASS: uniswap-v4-base-3 [base]; uniswap-v4-base [base]; uniswap-v4-base-2 [base] | PASS: uniswap-v4-base-3 [base]; uniswap-v4-base [base]; uniswap-v4-base-2 [base] |
| protocol entity composition<br>`search_subgraphs {"network":"arbitrum","protocol_type":"lending","entity":"liquidation","limit":3}` | PASS: Protocol V3 Arbitrum [arbitrum-one]; Revert Vault Arbitrum [arbitrum-one]; TellerV2 Arbitrum [arbitrum-one] | PASS: Protocol V3 Arbitrum [arbitrum-one]; Revert Vault Arbitrum [arbitrum-one]; TellerV2 Arbitrum [arbitrum-one] |
| new network Monad<br>`search_subgraphs {"network":"monad","limit":3}` | PASS: WOOFi Monad Staging [monad]; tracker-v2-monad [monad]; octoswap-v1-production [monad] | PASS: WOOFi Monad Staging [monad]; tracker-v2-monad [monad]; octoswap-v1-production [monad] |
| hidden allocation explanation<br>`search_subgraphs {"query":"tolly-arc-mainnet","network":"arc","limit":3}` | FAIL: returned 0 | PASS: returned 0 |
| zero allocation opt-in<br>`search_subgraphs {"query":"tolly-arc-mainnet","network":"arc","include_unserved":true,"limit":3}` | PASS: tolly-arc-mainnet [arc] | PASS: tolly-arc-mainnet [arc] |
| denied opt-in visible<br>`search_subgraphs {"network":"arc","include_denied":true,"include_unserved":true,"limit":20}` | PASS: gamma-uniswap-v4-ohlcv-arc [arc]; argus [arc]; arguspad [arc] | PASS: gamma-uniswap-v4-ohlcv-arc [arc]; argus [arc]; arguspad [arc] |
| default testnet exclusion<br>`search_subgraphs {"query":"uniswap","limit":5}` | PASS: uniswap-v4-base-3 [base]; uniswap-v2-ethereum [mainnet]; Uniswap-V3 [mainnet] | PASS: uniswap-v4-base-3 [base]; uniswap-v2-ethereum [mainnet]; Uniswap-V3 [mainnet] |
| fresh candidates companion<br>`search_subgraphs {"query":"uniswap","limit":3}` | PASS: uniswap-v4-base-3 [base]; uniswap-v2-ethereum [mainnet]; Uniswap-V3 [mainnet] | PASS: uniswap-v4-base-3 [base]; uniswap-v2-ethereum [mainnet]; Uniswap-V3 [mainnet] |
| contract mixed case<br>`find_by_contract {"address":"0x1F98431c8aD98523631AE4a59f267346ea31F984","chain":"ethereum","limit":3}` | PASS: Uniswap-V3 [mainnet]; Uniswap V3 Mainnet [mainnet]; Uniswap V3 Ethereum [mainnet] | PASS: Uniswap-V3 [mainnet]; Uniswap V3 Mainnet [mainnet]; Uniswap V3 Ethereum [mainnet] |
| contract chain constraint<br>`find_by_contract {"address":"0x1F98431c8aD98523631AE4a59f267346ea31F984","chain":"arc","limit":3}` | PASS: returned 0 | PASS: returned 0 |
| contract malformed<br>`find_by_contract {"address":"0x123","chain":"mainnet"}` | PASS: error: address must be a 0x-prefixed 40-hex EVM address | PASS: error: address must be a 0x-prefixed 40-hex EVM address |
| goal bounded payload<br>`query_for_goal {"goal":"Uniswap v3 pools on Ethereum","first":2}` | PASS: prepared Uniswap V3 Pools; no execution | PASS: prepared Uniswap V3 Pools; no execution |
| semantic offline chain constraint<br>`semantic_search_subgraphs {"query":"liquid staking derivatives","network":"ethereum","limit":3}` | PASS: illuvium-staking [mainnet]; pos-staking [mainnet]; Lido [mainnet] | PASS: illuvium-staking [mainnet]; pos-staking [mainnet]; Lido [mainnet] |
| goal refuses costly bound<br>`query_for_goal {"goal":"uniswap","first":100}` | PASS: error: execute must be boolean; first must be an integer from 1 to 10 | PASS: error: execute must be boolean; first must be an integer from 1 to 10 |
| goal execute credentials gate<br>`query_for_goal {"goal":"Uniswap v3","execute":true}` | PASS: error: credentials_required | PASS: error: credentials_required |
| health credentials gate<br>`check_subgraph_health {"id":"7xLobfNG9xx8yM5hkxagRuPmdjCJP4Kj9vtomrn9LrRM"}` | PASS: error: credentials_required | PASS: error: credentials_required |
| discovery health unobserved<br>`search_subgraphs {"network":"arc","limit":1}` | PASS: argus [arc] | PASS: argus [arc] |
| reject negative limit<br>`search_subgraphs {"network":"arc","limit":-1}` | FAIL: argus [arc] | PASS: error: limit must be an integer from 1 to 100 |
| reject fractional limit<br>`search_subgraphs {"network":"arc","limit":1.5}` | FAIL: error: datatype mismatch | PASS: error: limit must be an integer from 1 to 100 |
| reject string boolean<br>`search_subgraphs {"network":"arc","include_unserved":"false","limit":3}` | FAIL: argus [arc]; arguspad [arc]; Uniswap V4 - Arc [arc] | PASS: error: include_unserved must be boolean |
| reject unsupported pagination<br>`search_subgraphs {"network":"arc","offset":10,"limit":3}` | FAIL: argus [arc]; arguspad [arc]; Uniswap V4 - Arc [arc] | PASS: error: Unsupported argument: offset; pagination is not supported |
| recommend Arc chain intent<br>`recommend_subgraph {"goal":"find DEX swaps on Arc","chain":"arc"}` | PASS: argus [arc]; arguspad [arc]; Uniswap V4 - Arc [arc] | PASS: argus [arc]; arguspad [arc]; Uniswap V4 - Arc [arc] |
| invalid recommendation input<br>`recommend_subgraph {"goal":42}` | FAIL: error: goal.toLowerCase is not a function | PASS: error: goal must be a string of at most 1000 characters |

## Mounted live connector: twelve additional read-only scenarios

The connected tools are not assumed to be the new release. Measured live stats are **15,330 records; arc=1; arc-testnet=2**, while the immutable published database has **15,452; arc=9; arc-testnet=12**. Live lookup of the published Arc Uniswap ID returns not found. This proves a corpus mismatch, not its cause or exact installed version. Six mounted tools alone do not prove a broken connector. No configuration or process was changed.

| Live input | Observed result |
|---|---|
| `search {"query":"arc","limit":3}` | Aave ARC Ethereum [mainnet]; YAK ARC [avalanche]; farcaster-user [optimism] |
| `search {"query":"Uniswap v3","network":"ethereum","limit":3}` | Uniswap-V3 [mainnet]; Uniswap V3 Mainnet [mainnet]; Uniswap V3 Ethereum [mainnet] |
| `search {"query":"ens","limit":3}` | ENS [mainnet]; conditional-tokens-gc [gnosis]; gardens-gnosis [gnosis] |
| `recommend {"goal":"find DEX swaps on Arc","chain":"arc"}` | returned 0 |
| `search {"network":"monad","limit":3}` | WOOFi Monad Staging [monad]; tracker-v2-monad [monad]; octoswap-v1-production [monad] |
| `search {"network":"arbitrum","protocol_type":"lending","entity":"liquidation","limit":3}` | Revert Vault Arbitrum [arbitrum-one]; Silo Finance Arbitrum [arbitrum-one]; Dolomite Arbitrum One [arbitrum-one] |
| `search {"network":"arcc","limit":3}` | returned 0 |
| `search {"network":"arc","query":"tolly-arc-mainnet","include_unserved":true,"limit":3}` | tolly-arc-mainnet [arc] |
| `search {"network":"arc-testnet","limit":3}` | Sendly [arc-testnet]; zk-sendly [arc-testnet] |
| `search {"network":"polygon","limit":3}` | streamr [matic]; Uniswap V3 Polygon [matic]; QuickSwap V3 [matic] |
| `search {"network":"sei-mainnet","limit":3}` | sofa sei opt [sei-mainnet]; yei-finance [sei-mainnet]; takara-assets-stagging [sei-mainnet] |
| `semantic {"query":"liquid staking derivatives","network":"ethereum","limit":3}` | illuvium-staking [mainnet]; Lido [mainnet]; Lido Ethereum [mainnet] |

The live `arc` default zero-result is explained by its sole record having zero **snapshot** allocations; `include_unserved:true` reveals tolly-arc-mainnet. This does not test whether a query would work. Explicit `arc-testnet` includes that testnet without the boolean flag. Live unknown-network search returns no useful diagnostics. The connected responses already advertise API-key onboarding and the free allowance in prose, but lack the new structured next-action hints.

## Verified fixes and non-goals

- Standalone known-chain search routes rather than mixing same-name protocols and substrings; `inferred_network` is visible and explicit network wins. Arc mainnet is never rewritten to Arc Testnet.
- Removed the emerging-list claim that the newest global top-25 deployment is 280 days old: the shipped snapshot includes a much newer top-25 entry. The caveat now describes ranking limits without frozen age facts or claiming all four ranking inputs are cumulative.
- Exact distinctive protocol names outrank similarly named variants, including ENS for `ens name lookups on ethereum`. This also resolves the previously reproducible full-suite ENS baseline failure without changing its expected ID.
- Search empty-result diagnostics count scoped records and overlapping visibility exclusions, distinguish unknown networks, and suggest a local discovery-only retry for zero-allocation records. Defaults and all execution/payment gates remain unchanged.
- Invalid limits/types/booleans and unsupported pagination are rejected before SQL/inference/model loading. `total` is explicitly returned-count; no pagination implementation is implied.
- Structured next actions distinguish missing vs configured-but-unvalidated credentials, point a human to Studio, qualify the official free allowance, and never expose keys or silently switch to payment.
- The installed-bin smoke previously matched `capabilities.tools` in initialize, reported only one tool entry, and exited before tools/list. It now parses the exact tools/list response and requires search plus the new contract/goal tools.
- The existing canonical SKILL.md now covers installation through errors. README executable package examples are pinned; the optional payment example has an explicit approval guard. payql version pinning is not a third-party security review. No ClawHub scan was rerun and no warning clearance is claimed.

## Honest remaining limits

- Semantic `liquid staking derivatives` on Ethereum ranks illuvium-staking first, with Lido later in the top three. The interface/filter/offline check passes; ideal semantic relevance is **not** solved by this PR. A ranking floor is not an uptime or rewards-eligibility metric.
- Goal preparation uses a stored starter, not goal-specific query synthesis. For `Uniswap v3 pools on Ethereum`, the prepared first-2-row `liquidityPools` starter remains labelled live-schema-not-checked. It can be irrelevant or invalid for a live deployment; inspect schema and selected network before execution.
- No authenticated live _meta, query or quota check was performed: account allowance cannot be assumed free. Existing gateway/auth/HTTP-200-error/health-cache regressions use explicitly mocked responses and a fake test key, not production data. Real unobserved health remains null.
- Allocation counts, missing curation and denied rewards do not establish query availability or chain-wide reward eligibility. Legacy allocation filters and contract lookup coverage can miss usable deployments; opt-in search broadens discovery without claiming endpoints work.
- Empty diagnostics apply to keyword search; recommendation/goal failures direct agents to that path rather than inventing precise exclusion counts. Studio-only deployments and stale/unmounted runtimes still need separately scoped operational work.
- Published 0.11.0 remains unchanged until a separately authorized release; installing it does not restart a mounted connector.

## Sources checked this turn

- [Supported-network modes](https://thegraph.com/docs/en/supported-networks/): Arc and Sei are listed STUDIO, separately from reward-supported chains.
- [Arc mainnet](https://thegraph.com/docs/en/supported-networks/arc/): `arc`, eip155:5042, publishing enabled, no guaranteed decentralized indexing.
- [Arc testnet](https://thegraph.com/docs/en/supported-networks/arc-testnet/): distinct `arc-testnet`, eip155:5042002.
- [Sei](https://thegraph.com/docs/en/supported-networks/sei-mainnet/): `sei-mainnet`, eip155:1329, Studio indexing. Live discovery returned sofa sei opt, yei-finance and takara-assets-stagging; these were not health-tested.
- [Indexer revenue/allocation definitions](https://thegraph.com/docs/en/indexing/overview/) and [glossary](https://thegraph.com/docs/en/resources/glossary/): indexing rewards and query fee revenue are distinct.
- [Official pricing](https://thegraph.com/studio-pricing/): first 100K monthly queries advertised free; no account-specific quota check.
- [API-key management](https://thegraph.com/docs/en/subgraphs/providers/subgraph-studio/managing-api-keys/): human Studio creation, secure environment/secrets storage, bearer auth and spending limits.

## Validation results

- Node 20: `node --test test/` — **89/89 passed**, including the original ENS regression (previous untouched baseline was 79/80).
- `node scripts/audit-discovery.mjs src/index.js report.json` — **30/30**; same matrix on published 0.11.0 — **21/30**, nine reproduced expectation failures.
- Python: `cd python && ../.venv/bin/python -m pytest -q test_classifier.py` — **3/3 passed**.
- `node scripts/smoke-bin.mjs` — installed package/bin responds to actual tools/list and includes the contract/goal tools.
- `node --check src/index.js`, generated OpenAPI synchronization, workflow/skill/OpenAPI YAML parsing and `git diff --check` passed.
- No production queries, signing, payments, database changes or public runtime updates were part of validation.
