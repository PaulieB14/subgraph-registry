"""
Subgraph Registry Crawler

Queries the Graph Network Arbitrum subgraph to pull metadata, schemas,
signal data, and deployment info for all 15K+ active subgraphs.

Handles:
- Pagination past The Graph's 5000 skip limit via ID-based cursoring
- Incremental sync via createdAt/updatedAt timestamps
- Batched schema fetching with rate limiting
- Streaming JSON output to handle large datasets
"""

import asyncio
import json
import time
from pathlib import Path
from datetime import datetime, timezone

import os

import httpx

# Load .env file if present
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip())

GRAPH_NETWORK_SUBGRAPH_ID = "DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp"

# Support API key via env var or .env
GATEWAY_API_KEY = os.environ.get("GATEWAY_API_KEY", "")
if GATEWAY_API_KEY:
    GATEWAY_URL = f"https://gateway.thegraph.com/api/{GATEWAY_API_KEY}/subgraphs/id/{GRAPH_NETWORK_SUBGRAPH_ID}"
else:
    GATEWAY_URL = f"https://gateway.thegraph.com/api/subgraphs/id/{GRAPH_NETWORK_SUBGRAPH_ID}"

PAGE_SIZE = 1000
SCHEMA_BATCH_SIZE = 10
DATA_DIR = Path(__file__).parent / "data"

# ── GraphQL Queries ──────────────────────────────────────────

SUBGRAPHS_QUERY = """
query CrawlSubgraphs($first: Int!, $lastId: String!, $minUpdatedAt: Int!) {
  subgraphs(
    first: $first
    orderBy: id
    orderDirection: asc
    where: { active: true, id_gt: $lastId, updatedAt_gte: $minUpdatedAt }
  ) {
    id
    createdAt
    updatedAt
    currentSignalledTokens
    signalledTokens
    unsignalledTokens
    nameSignalAmount
    metadata {
      displayName
      description
      categories
      codeRepository
      website
    }
    owner {
      id
      defaultName { name }
    }
    currentVersion {
      version
      subgraphDeployment {
        ipfsHash
        signalledTokens
        stakedTokens
        queryFeesAmount
        indexingRewardAmount
        curatorFeeRewards
        activeSubgraphCount
        deniedAt
        manifest {
          network
          poweredBySubstreams
          schemaIpfsHash
          startBlock
        }
      }
    }
  }
}
"""

SCHEMAS_QUERY = """
query FetchSchemas($ids: [String!]!) {
  subgraphDeploymentManifests(where: { id_in: $ids }) {
    id
    network
    schema { id schema }
    manifest
  }
}
"""

# Active allocations per deployment. activeForIndexer is non-null only when the
# allocation is currently open — the cleanest filter for "served by ≥1 indexer".
ALLOCATIONS_QUERY = """
query ActiveAllocations($first: Int!, $lastId: String!) {
  allocations(
    first: $first
    orderBy: id
    orderDirection: asc
    where: { id_gt: $lastId, activeForIndexer_not: null }
  ) {
    id
    subgraphDeployment { ipfsHash }
  }
}
"""

NETWORK_STATS_QUERY = """
{
  graphNetwork(id: "1") {
    subgraphCount
    activeSubgraphCount
    totalQueryFees
    totalIndexingRewards
  }
}
"""


async def query_subgraph(client: httpx.AsyncClient, query: str, variables: dict | None = None) -> dict:
    """Execute a GraphQL query against the Graph Network subgraph."""
    payload = {"query": query}
    if variables:
        payload["variables"] = variables

    for attempt in range(3):
        try:
            resp = await client.post(GATEWAY_URL, json=payload, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if "errors" in data:
                raise Exception(f"GraphQL errors: {data['errors']}")
            return data["data"]
        except (httpx.HTTPStatusError, httpx.ReadTimeout) as e:
            if attempt < 2:
                wait = 2 ** attempt
                print(f"  Retry {attempt+1} after {wait}s: {e}")
                await asyncio.sleep(wait)
            else:
                raise


async def crawl_all_subgraphs(client: httpx.AsyncClient, min_updated_at: int = 0) -> list[dict]:
    """
    Crawl all active subgraphs using ID-based cursor pagination.
    This avoids The Graph's 5000 skip limit.
    """
    all_subgraphs = []
    last_id = ""
    page = 0

    print(f"Crawling subgraphs (updated after {datetime.fromtimestamp(min_updated_at, tz=timezone.utc).isoformat() if min_updated_at else 'epoch'})...")

    while True:
        data = await query_subgraph(client, SUBGRAPHS_QUERY, {
            "first": PAGE_SIZE,
            "lastId": last_id,
            "minUpdatedAt": min_updated_at,
        })

        batch = data["subgraphs"]
        all_subgraphs.extend(batch)
        page += 1

        print(f"  Page {page}: +{len(batch)} (total: {len(all_subgraphs)})")

        if len(batch) < PAGE_SIZE:
            break

        last_id = batch[-1]["id"]
        await asyncio.sleep(0.2)  # gentle rate limit

    return all_subgraphs


def _extract_contract_addresses(manifest_yaml: str) -> list[dict] | None:
    """Pull dataSources[].source.address from a subgraph manifest YAML string.

    Returns a list of {kind, name, address, network, startBlock} dicts, or
    None if the YAML can't be parsed or has no addresses. Substreams-powered
    subgraphs have a different shape (no `dataSources[].source.address`) —
    they return None too.

    Lets agents answer "which subgraph indexes contract 0x... on chain X?"
    without going to IPFS or running an introspect call per subgraph.
    """
    if not manifest_yaml:
        return None
    try:
        import yaml as _yaml  # PyYAML
        doc = _yaml.safe_load(manifest_yaml)
    except Exception:
        return None
    if not isinstance(doc, dict):
        return None
    out = []
    for ds in (doc.get("dataSources") or []):
        src = (ds.get("source") or {}) if isinstance(ds, dict) else {}
        addr = src.get("address")
        if not addr:
            continue
        # Lowercase for consistent matching downstream
        out.append({
            "kind": ds.get("kind"),
            "name": ds.get("name"),
            "address": str(addr).lower(),
            "network": ds.get("network"),
            "startBlock": src.get("startBlock"),
        })
    # Templates (dynamic data sources) — capture their addresses too if present
    for ds in (doc.get("templates") or []):
        src = (ds.get("source") or {}) if isinstance(ds, dict) else {}
        addr = src.get("address")
        if not addr:
            continue
        out.append({
            "kind": ds.get("kind"),
            "name": ds.get("name"),
            "address": str(addr).lower(),
            "network": ds.get("network"),
            "startBlock": src.get("startBlock"),
            "template": True,
        })
    return out or None


async def fetch_schemas(
    client: httpx.AsyncClient, ipfs_hashes: list[str]
) -> tuple[dict[str, str], dict[str, list[dict] | None]]:
    """Fetch schema text + contract-address list for deployments, batched.

    Returns (schemas, contract_addresses) — both keyed by IPFS hash. The
    manifest YAML is parsed here so it doesn't have to be re-fetched later;
    the raw manifest string is dropped after extraction.
    """
    schemas: dict[str, str] = {}
    addresses: dict[str, list[dict] | None] = {}
    total = len(ipfs_hashes)

    for i in range(0, total, SCHEMA_BATCH_SIZE):
        batch = ipfs_hashes[i:i + SCHEMA_BATCH_SIZE]
        try:
            data = await query_subgraph(client, SCHEMAS_QUERY, {"ids": batch})
            for manifest in data.get("subgraphDeploymentManifests", []):
                mid = manifest.get("id")
                if not mid:
                    continue
                if manifest.get("schema") and manifest["schema"].get("schema"):
                    schemas[mid] = manifest["schema"]["schema"]
                addrs = _extract_contract_addresses(manifest.get("manifest") or "")
                if addrs:
                    addresses[mid] = addrs
        except Exception as e:
            print(f"  Schema batch error at {i}: {e}")

        done = min(i + SCHEMA_BATCH_SIZE, total)
        if done % 100 == 0 or done == total:
            print(f"  Schemas fetched: {len(schemas)}/{total}  Addresses: {len(addresses)}")

        await asyncio.sleep(0.1)

    return schemas, addresses


async def crawl_active_allocations(client: httpx.AsyncClient) -> dict[str, int]:
    """Count currently-active indexer allocations per deployment ipfsHash.

    An allocation is "active" when activeForIndexer is non-null. Returns
    `{ipfs_hash: count}`. Subgraph IDs absent from the result have 0 active
    allocations — i.e., no indexer is currently serving them.
    """
    counts: dict[str, int] = {}
    last_id = ""
    page = 0
    while True:
        data = await query_subgraph(
            client, ALLOCATIONS_QUERY, {"first": 1000, "lastId": last_id}
        )
        allocs = data.get("allocations", [])
        if not allocs:
            break
        for a in allocs:
            dep = a.get("subgraphDeployment") or {}
            h = dep.get("ipfsHash")
            if h:
                counts[h] = counts.get(h, 0) + 1
        last_id = allocs[-1]["id"]
        page += 1
        if page > 50:
            print(f"  WARNING: allocation pagination hit the {page - 1}-page safety cap "
                  f"(~{(page - 1) * 1000} allocations) — counts may be truncated. Raise the cap.")
            break
        if len(allocs) < 1000:
            break
    return counts


def flatten_subgraph(
    sg: dict,
    schemas: dict[str, str],
    contract_addresses: dict[str, list[dict] | None] | None = None,
) -> dict:
    """Flatten a raw subgraph response into a clean record."""
    meta = sg.get("metadata") or {}
    deployment = (sg.get("currentVersion") or {}).get("subgraphDeployment") or {}
    manifest = deployment.get("manifest") or {}
    ipfs_hash = deployment.get("ipfsHash")
    owner = sg.get("owner") or {}

    return {
        "id": sg["id"],
        "display_name": meta.get("displayName"),
        "description": meta.get("description"),
        "categories": meta.get("categories") or [],
        "code_repository": meta.get("codeRepository"),
        "website": meta.get("website"),
        "owner_id": owner.get("id"),
        "owner_name": (owner.get("defaultName") or {}).get("name"),
        "created_at": sg.get("createdAt", 0),
        "updated_at": sg.get("updatedAt", 0),
        "current_signalled_tokens": sg.get("currentSignalledTokens", "0"),
        # Deployment
        "ipfs_hash": ipfs_hash,
        "network": manifest.get("network"),
        "powered_by_substreams": manifest.get("poweredBySubstreams", False),
        "start_block": manifest.get("startBlock"),
        "signalled_tokens": deployment.get("signalledTokens", "0"),
        "staked_tokens": deployment.get("stakedTokens", "0"),
        "query_fees": deployment.get("queryFeesAmount", "0"),
        "indexing_rewards": deployment.get("indexingRewardAmount", "0"),
        "curator_fees": deployment.get("curatorFeeRewards", "0"),
        "active_subgraph_count": deployment.get("activeSubgraphCount", 0),
        "denied_at": deployment.get("deniedAt", 0),
        # Schema (can be None)
        "schema": schemas.get(ipfs_hash) if ipfs_hash else None,
        # Contract addresses extracted from manifest YAML. None means either
        # we didn't extract (e.g. substreams-powered, or YAML had no addresses),
        # not "no contracts" — distinguish with .get vs default {}.
        "contract_addresses": (contract_addresses or {}).get(ipfs_hash) if ipfs_hash else None,
        # Filled in by full_crawl after crawl_active_allocations runs
        "active_allocation_count": 0,
    }


# ── Gateway QoS oracle feed (live replacement for the frozen QoS subgraph) ──
# The QoS subgraph (Dtr9rET…) froze 2026-06-30 when the gateway rotated its
# submitter key: queryDailyDataPoints stopped, so a trailing-30-day scan of it
# decays to zero. The same telemetry is still posted on-chain — the gateway
# writes a per-deployment query-stats payload to a DataEdge contract on Gnosis
# every ~5 min as submitQoSPayload(bytes) calldata = JSON {topic, hash (IPFS
# CID), timestamp}; the bulk rows live on IPFS. We enumerate recent submissions
# via Blockscout (cheap — no block scan, no key), fetch the per-window IPFS
# payloads for the query-result topic, and aggregate query_count per deployment
# over the FULL 30-day window — a true 30-day total per deployment (parity with
# the old QoS subgraph's 30d sum, incl. long-tail deployments queried on any day).
# QOS_SAMPLE_DAYS can be lowered for a faster, approximate run — the sampled total
# is then uniformly scaled up to 30d, which still preserves the classifier's
# log10(queries)/8 ranking. A full 30-day scan is ~8.6k IPFS fetches / ~10-15 min,
# which is why the crawl cadence is every 5 days.
QOS_DATAEDGE = "0x5b4293b4c0f36cb5d4448950830bc777759b6c4f"  # Gnosis DataEdge
QOS_TOPIC_QR = "gateway_query_result_qos_5_minutes_prod_v3"  # per-deployment query stats
QOS_BLOCKSCOUT = os.environ.get("GNOSIS_BLOCKSCOUT_API", "https://gnosis.blockscout.com/api")
QOS_IPFS = os.environ.get("QOS_IPFS_GATEWAY", "https://api.thegraph.com/ipfs").rstrip("/")
QOS_SAMPLE_DAYS = float(os.environ.get("QOS_SAMPLE_DAYS", "30"))  # full 30-day window; lower = faster/approx
QOS_IPFS_CONCURRENCY = int(os.environ.get("QOS_IPFS_CONCURRENCY", "16"))  # bounded fetches over the window

# ── QoS source selector — switch back easily, per source ─────────────────────
# QOS_SOURCE:
#   "auto"     (default) — prefer the QoS subgraph, fall back to the oracle scan
#                          automatically if the subgraph returns nothing (e.g. it
#                          freezes, like the previous one did on 2026-06-30).
#   "subgraph"           — force the QoS subgraph only (Ellipra's — indexes the
#                          same Gateway QoS oracle feed, but as clean GraphQL).
#   "oracle"             — force the DataEdge/Blockscout oracle scan only (the
#                          fully-decentralised raw source; no single-publisher dep).
# Reverting is a one-env-var change, no code edit; both code paths stay intact.
QOS_SOURCE = os.environ.get("QOS_SOURCE", "auto").strip().lower()
# The QoS subgraph deployment (swap via env if the publisher ships a new one or it
# freezes). Default is Ellipra's, verified live + served by 2 indexers 2026-07-21.
QOS_SUBGRAPH_DEPLOYMENT = os.environ.get(
    "QOS_SUBGRAPH_DEPLOYMENT", "QmddS3TgRzYAbY4pnf31fsYosfun4imiAFyJ6bV5Z3QdHs"
)


def _decode_qos_calldata(input_hex: str):
    """Decode submitQoSPayload(bytes) calldata into its JSON {topic, hash, timestamp}."""
    try:
        h = input_hex[2:] if input_hex.startswith("0x") else input_hex
        if len(h) <= 8:
            return None
        h = h[8:]  # strip the 4-byte selector
        off = int(h[:64], 16) * 2
        ln = int(h[off:off + 64], 16) * 2
        return json.loads(bytes.fromhex(h[off + 64:off + 64 + ln]).decode("utf-8", "replace"))
    except Exception:
        return None


async def _gnosis_block_at(client: httpx.AsyncClient, ts: int) -> int | None:
    """Gnosis block number at/just-before `ts`, via Blockscout getblocknobytime."""
    try:
        r = await client.get(QOS_BLOCKSCOUT, params={
            "module": "block", "action": "getblocknobytime",
            "timestamp": int(ts), "closest": "before",
        }, timeout=30)
        res = r.json().get("result")
        if isinstance(res, dict):
            return int(res.get("blockNumber"))
        return int(res) if res else None
    except Exception:
        return None


async def _list_qos_windows(client: httpx.AsyncClient, since_ts: int) -> dict:
    """Return {window_timestamp: newest_ipfs_cid} for query-result QoS submissions
    since `since_ts`. Enumerated via Blockscout txlist in BLOCK-RANGE CHUNKS:
    Blockscout hard-caps a single txlist scan at 10k results (page*offset<=10000),
    which for this busy DataEdge is only ~12 days — so a plain global paginate can't
    reach 30 days. Walking back in ~7-day block chunks keeps each chunk under the cap."""
    now = int(time.time())
    end_b = await _gnosis_block_at(client, now)
    start_b = await _gnosis_block_at(client, since_ts)
    by_window: dict[int, str] = {}
    if not end_b or not start_b:
        return by_window
    CHUNK_BLOCKS = 120_000  # ~7 days on Gnosis (~5s blocks); ~4k txs/chunk, under the 10k cap
    b_hi = end_b
    while b_hi > start_b:
        b_lo = max(start_b, b_hi - CHUNK_BLOCKS)
        for page in range(1, 12):  # <=10 pages * 1000 stays under the 10k window per chunk
            try:
                r = await client.get(QOS_BLOCKSCOUT, params={
                    "module": "account", "action": "txlist", "address": QOS_DATAEDGE,
                    "startblock": b_lo, "endblock": b_hi, "sort": "desc",
                    "page": page, "offset": 1000,
                }, timeout=60)
                txs = r.json().get("result") or []
            except Exception:
                break
            if not isinstance(txs, list) or not txs:
                break
            for tx in txs:
                if (tx.get("to") or "").lower() != QOS_DATAEDGE:
                    continue
                p = _decode_qos_calldata(tx.get("input", ""))
                if not p or p.get("topic") != QOS_TOPIC_QR:
                    continue
                wts = int(p.get("timestamp", 0) or 0)
                if wts >= since_ts and p.get("hash"):
                    by_window.setdefault(wts, p["hash"])  # newest-first → first seen wins
            if len(txs) < 1000:
                break
        b_hi = b_lo - 1
    return by_window


async def _fetch_qos_payload(client: httpx.AsyncClient, cid: str) -> list:
    for attempt in range(3):
        try:
            r = await client.post(f"{QOS_IPFS}/api/v0/cat?arg={cid}", timeout=60)
            j = r.json()
            return j if isinstance(j, list) else []
        except Exception:
            await asyncio.sleep(1.5 * (attempt + 1))
    return []


async def _fetch_qos_volumes_oracle(client: httpx.AsyncClient, deployment_hashes: list[str]) -> dict[str, int]:
    """Live per-deployment query volumes from the Gateway QoS oracle feed, scaled to a
    30-day estimate. The fully-decentralised raw source. {deployment_ipfs: est_30d_query_count}."""
    now = int(time.time())
    since = now - int(QOS_SAMPLE_DAYS * 86400)
    windows = await _list_qos_windows(client, since)
    if not windows:
        print("  QoS oracle feed: no submissions found — no volume data this run")
        return {}

    sem = asyncio.Semaphore(QOS_IPFS_CONCURRENCY)

    async def _one(cid: str) -> list:
        async with sem:
            return await _fetch_qos_payload(client, cid)

    payloads = await asyncio.gather(*[_one(c) for c in windows.values()])

    sample: dict[str, int] = {}
    for rows in payloads:
        for row in rows:
            dep = row.get("subgraph_deployment_ipfs_hash")
            if dep:
                sample[dep] = sample.get(dep, 0) + int(row.get("query_count", 0) or 0)

    # Scale the sampled span up to a 30-day estimate. Ranking is log-scale, so a
    # uniform scale factor preserves ordering regardless of exactness.
    span_days = max((now - min(windows)) / 86400.0, 0.5)
    scale = 30.0 / span_days
    volumes = {dep: int(qc * scale) for dep, qc in sample.items()}
    print(f"  QoS oracle feed: {len(windows)} windows over ~{span_days:.1f}d, "
          f"{len(volumes)} deployments (scaled x{scale:.1f} -> 30d estimate)")
    return volumes


def _qos_subgraph_url() -> str:
    dep = QOS_SUBGRAPH_DEPLOYMENT
    if GATEWAY_API_KEY:
        return f"https://gateway.thegraph.com/api/{GATEWAY_API_KEY}/deployments/id/{dep}"
    return f"https://gateway.thegraph.com/api/deployments/id/{dep}"


async def _fetch_qos_volumes_subgraph(client: httpx.AsyncClient, deployment_hashes: list[str]) -> dict[str, int]:
    """Per-deployment query volumes from the QoS subgraph (indexes the SAME Gateway QoS
    oracle feed as the oracle path, but as clean GraphQL — one paginated query instead
    of Blockscout block-range chunking). Sums real daily query_count over the window and
    scales to a 30-day estimate for parity with the oracle path. {deployment_ipfs: est_30d}."""
    url = _qos_subgraph_url()
    now = int(time.time())
    since = now - int(QOS_SAMPLE_DAYS * 86400)
    q = ("query($since:BigInt!,$last:ID!){ "
         "queryDailyDataPoints(first:1000, orderBy:id, where:{dayStart_gte:$since, id_gt:$last}){ "
         "id query_count dayStart subgraphDeployment{ id } } }")
    totals: dict[str, int] = {}
    earliest: int | None = None
    last_id, pages = "", 0
    while pages < 300:  # safety cap; ~30k rows / 1000 ≈ 30 pages typical
        try:
            resp = await client.post(url, json={"query": q, "variables": {"since": str(since), "last": last_id}}, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if "errors" in data:
                raise Exception(f"GraphQL errors: {data['errors']}")
            rows = data["data"]["queryDailyDataPoints"]
        except Exception as e:
            print(f"  QoS subgraph error (page {pages}): {str(e)[:120]}")
            return totals if pages else {}  # empty on first-page failure -> caller may fall back
        if not rows:
            break
        for r in rows:
            dep = (r.get("subgraphDeployment") or {}).get("id")
            if not dep:
                continue
            totals[dep] = totals.get(dep, 0) + int(float(r.get("query_count") or 0))
            ds = int(r.get("dayStart") or 0)
            if ds and (earliest is None or ds < earliest):
                earliest = ds
        last_id = rows[-1]["id"]
        pages += 1
        if len(rows) < 1000:
            break
    # Scale the covered span up to a 30-day estimate (parity with the oracle path;
    # the subgraph only has data since 2026-06-30, so the window may be < 30d).
    span_days = max((now - earliest) / 86400.0, 0.5) if earliest else QOS_SAMPLE_DAYS
    scale = QOS_SAMPLE_DAYS / span_days if span_days else 1.0
    volumes = {dep: int(qc * scale) for dep, qc in totals.items()}
    print(f"  QoS subgraph ({QOS_SUBGRAPH_DEPLOYMENT[:12]}…): {pages} pages, {len(volumes)} deployments "
          f"over ~{span_days:.1f}d (scaled x{scale:.2f} -> 30d estimate)")
    return volumes


async def fetch_qos_volumes(client: httpx.AsyncClient, deployment_hashes: list[str]) -> dict[str, int]:
    """Per-deployment 30-day query volumes. Source selected by QOS_SOURCE:
    'subgraph' | 'oracle' | 'auto' (subgraph-preferred with oracle fallback)."""
    if QOS_SOURCE == "oracle":
        return await _fetch_qos_volumes_oracle(client, deployment_hashes)
    if QOS_SOURCE == "subgraph":
        return await _fetch_qos_volumes_subgraph(client, deployment_hashes)
    # auto: prefer the subgraph (clean + on The Graph), fall back to the oracle
    # feed if it yields nothing (frozen subgraph, gateway hiccup, schema change).
    vols = await _fetch_qos_volumes_subgraph(client, deployment_hashes)
    if vols:
        return vols
    print("  QoS: subgraph returned no data -> falling back to the oracle feed")
    return await _fetch_qos_volumes_oracle(client, deployment_hashes)


async def full_crawl(
    min_updated_at: int = 0,
    fetch_schemas_flag: bool = True,
    max_subgraphs: int | None = None,
) -> dict:
    """Full crawl pipeline."""
    start = time.time()

    async with httpx.AsyncClient(http2=True) as client:
        # Network stats
        print("\n=== Graph Network Stats ===")
        stats_data = await query_subgraph(client, NETWORK_STATS_QUERY)
        stats = stats_data["graphNetwork"]
        print(f"  Total subgraphs: {stats['subgraphCount']}")
        print(f"  Active subgraphs: {stats['activeSubgraphCount']}")

        # Crawl
        print("\n=== Crawling Subgraphs ===")
        raw_subgraphs = await crawl_all_subgraphs(client, min_updated_at)

        if max_subgraphs and len(raw_subgraphs) > max_subgraphs:
            # Sort by signal descending, take top N
            raw_subgraphs.sort(
                key=lambda s: int(s.get("currentSignalledTokens") or "0"),
                reverse=True,
            )
            raw_subgraphs = raw_subgraphs[:max_subgraphs]
            print(f"  Limited to top {max_subgraphs} by signal")

        # Deduplicate deployments
        seen_hashes = set()
        unique_hashes = []
        for sg in raw_subgraphs:
            dep = (sg.get("currentVersion") or {}).get("subgraphDeployment") or {}
            h = dep.get("ipfsHash")
            if h and h not in seen_hashes:
                seen_hashes.add(h)
                unique_hashes.append(h)
        print(f"  Unique deployments: {len(unique_hashes)} (from {len(raw_subgraphs)} subgraphs)")

        # Fetch schemas + contract addresses (both come from the same manifest endpoint)
        schemas: dict[str, str] = {}
        contract_addresses: dict[str, list[dict] | None] = {}
        if fetch_schemas_flag:
            print("\n=== Fetching Schemas + Contract Addresses ===")
            schemas, contract_addresses = await fetch_schemas(client, unique_hashes)
            print(f"  Total schemas: {len(schemas)}, with addresses: {len(contract_addresses)}")

        # Fetch active indexer allocations per deployment
        print("\n=== Fetching Active Allocations ===")
        allocation_counts = await crawl_active_allocations(client)
        served = sum(1 for h in unique_hashes if allocation_counts.get(h, 0) > 0)
        print(f"  Deployments served by ≥1 indexer: {served} / {len(unique_hashes)}")

        # Fetch 30d query volumes. Source is QOS_SOURCE-selectable (see
        # fetch_qos_volumes): a live QoS subgraph, the raw Gateway QoS oracle
        # feed, or 'auto' (subgraph-preferred with automatic oracle fallback).
        print(f"\n=== Fetching Query Volumes (QOS_SOURCE={QOS_SOURCE}) ===")
        query_volumes = await fetch_qos_volumes(client, unique_hashes)
        print(f"  Deployments with volume data: {len(query_volumes)}")
        if query_volumes:
            top = sorted(query_volumes.items(), key=lambda x: x[1], reverse=True)[:5]
            for h, v in top:
                print(f"    {h[:16]}... = {v:,.0f} queries/30d")

    # Flatten
    subgraphs = [flatten_subgraph(sg, schemas, contract_addresses) for sg in raw_subgraphs]

    # Attach query volumes + active allocation counts
    for sg in subgraphs:
        ipfs = sg.get("ipfs_hash")
        if ipfs and ipfs in query_volumes:
            sg["query_volume_30d"] = query_volumes[ipfs]
        if ipfs:
            sg["active_allocation_count"] = allocation_counts.get(ipfs, 0)

    elapsed = time.time() - start
    with_schema = sum(1 for s in subgraphs if s["schema"])
    with_desc = sum(1 for s in subgraphs if s["description"])
    with_cats = sum(1 for s in subgraphs if s["categories"])
    with_vol = sum(1 for s in subgraphs if s.get("query_volume_30d", 0) > 0)

    print(f"\n=== Crawl Complete ({elapsed:.1f}s) ===")
    print(f"  Subgraphs: {len(subgraphs)}")
    print(f"  With schemas: {with_schema}")
    print(f"  With descriptions: {with_desc}")
    print(f"  With categories: {with_cats}")
    print(f"  With 30d query volume: {with_vol}")

    return {
        "crawled_at": datetime.now(timezone.utc).isoformat(),
        "sync_timestamp": int(time.time()),
        "network_stats": stats,
        "subgraphs": subgraphs,
        # Whole-corpus dynamic signals (fetched for ALL deployments every run, even
        # incremental) so the caller can refresh rows outside the updatedAt delta.
        "allocation_counts": allocation_counts,
        "query_volumes": query_volumes,
    }


async def main():
    import argparse
    parser = argparse.ArgumentParser(description="Crawl Graph Network subgraphs")
    parser.add_argument("--max", type=int, default=None, help="Max subgraphs to crawl (None = all)")
    parser.add_argument("--no-schemas", action="store_true", help="Skip schema fetching")
    parser.add_argument("--since", type=int, default=0, help="Only fetch subgraphs updated after this unix timestamp")
    parser.add_argument("--output", type=str, default=str(DATA_DIR / "crawl-raw.json"))
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    data = await full_crawl(
        min_updated_at=args.since,
        fetch_schemas_flag=not args.no_schemas,
        max_subgraphs=args.max,
    )

    # Write with schemas stripped for summary
    output = Path(args.output)
    output.write_text(json.dumps(data, indent=2, default=str))
    print(f"\nWritten to {output} ({output.stat().st_size / 1024 / 1024:.1f} MB)")

    # Write a lite version without schema text
    lite_path = output.with_name("crawl-summary.json")
    lite = {
        **data,
        "subgraphs": [
            {k: v for k, v in sg.items() if k != "schema"}
            | {"entity_count": len(__import__('re').findall(r'type \w+ @entity', sg["schema"] or ""))}
            for sg in data["subgraphs"]
        ],
    }
    lite_path.write_text(json.dumps(lite, indent=2, default=str))
    print(f"Written to {lite_path} ({lite_path.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    asyncio.run(main())
