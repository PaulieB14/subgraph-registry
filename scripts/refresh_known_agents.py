#!/usr/bin/env python3
"""Rebuild query 7507131 ('Identified agent payers') with a fresh
wallet → agent-identity directory pulled from public agent registries.

Sources (in priority order, dedupe by wallet):
  1. Local seed — operator wallets (Paul's own, GA's outbound, etc.)
  2. graphadvocate.com/bazaar/active — active x402 services with
     pay_to + erc8004_agent.owner + name/ens
  3. 8004scan.io /api/v1/public/agents — every registered ERC-8004
     agent + owner_address + name (paginated through all results)

The directory becomes a SQL `VALUES (...)` block injected into the
query. As long as new agents register publicly, the directory grows
automatically — the dashboard table fills in named matches without any
SQL edit.

Output: writes SQL to OUTPUT_PATH (default /tmp/known_agents_directory.sql)
and prints a one-line summary. The caller (workflow or shell) then runs:
  dune query update 7507131 --sql "$(cat $OUTPUT_PATH)"

Usage:
  python scripts/refresh_known_agents.py
  OUTPUT_PATH=/tmp/x.sql python scripts/refresh_known_agents.py
"""

from __future__ import annotations
import json
import os
import sys
import urllib.request
import urllib.error
from typing import Iterable

QUERY_ID = 7507131
GATEWAY_PAYTO = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB"
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

OPERATOR_SEED = [
    # (wallet, name, source)
    ("0xe121e3a8611e1f44f7cc52892ee1117fddc8f734", "Paul (graphadvocate.eth operator)", "operator"),
    ("0x575267eed09c338fae5716a486a7b58a5749a292", "Graph Advocate outbound wallet", "operator"),
    ("0x0ff5a6ecef783bba35463ec2f8403b9b5e9e7c86", "Graph Advocate x402 inbound", "operator"),
]


def fetch_json(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "x402-graph-dune-refresh/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def from_bazaar() -> list[tuple[str, str, str]]:
    """Pull active x402 services from GA's bazaar proxy."""
    try:
        d = fetch_json("https://graphadvocate.com/bazaar/active")
    except Exception as e:
        print(f"  bazaar fetch failed: {e}", file=sys.stderr)
        return []
    rows = []
    for it in d.get("results") or []:
        pay_to = (it.get("pay_to") or "").lower()
        resource = it.get("resource") or ""
        e8 = it.get("erc8004_agent") or {}
        name = e8.get("name") or e8.get("ens") or _hostname(resource) or "?"
        if pay_to and pay_to.startswith("0x"):
            rows.append((pay_to, str(name), "bazaar"))
        owner = (e8.get("owner") or "").lower()
        if owner and owner.startswith("0x") and owner != pay_to:
            agent_id = e8.get("agent_id")
            rows.append((owner, f"ERC-8004 #{agent_id}" if agent_id else str(name), "erc8004"))
    return rows


def from_8004scan(max_pages: int = 10) -> list[tuple[str, str, str]]:
    rows = []
    for page in range(max_pages):
        offset = page * 100
        try:
            d = fetch_json(
                f"https://8004scan.io/api/v1/public/agents?limit=100&offset={offset}"
            )
        except Exception as e:
            print(f"  8004scan page {page} failed: {e}", file=sys.stderr)
            break
        items = d.get("data") or []
        if not items:
            break
        for a in items:
            wallet = (a.get("owner_address") or "").lower()
            if not (wallet and wallet.startswith("0x")):
                continue
            name = a.get("name") or ""
            # Skip pure placeholder names — they convey no identity beyond the wallet.
            if not name or name.startswith("Agent #"):
                ens = a.get("owner_ens")
                if not ens:
                    continue
                name = ens
            rows.append((wallet, str(name), "8004scan"))
        meta = d.get("meta") or {}
        pag = meta.get("pagination") or {}
        if not pag.get("hasMore"):
            break
    return rows


def _hostname(url: str) -> str | None:
    try:
        from urllib.parse import urlparse
        h = urlparse(url).hostname
        return h.replace("www.", "") if h else None
    except Exception:
        return None


def dedupe(rows: Iterable[tuple[str, str, str]]) -> list[tuple[str, str, str]]:
    """Keep first occurrence per wallet (source order is priority)."""
    seen: dict[str, tuple[str, str, str]] = {}
    for wallet, name, source in rows:
        wallet_l = wallet.lower()
        if wallet_l in seen:
            continue
        # Escape single quotes in name for SQL.
        name_clean = name.replace("'", "''")
        seen[wallet_l] = (wallet_l, name_clean, source)
    return list(seen.values())


SQL_TEMPLATE = """-- Payers to The Graph's x402 gateway with a confirmed identity in
-- 8004scan, the x402 Bazaar, or a manually seeded operator list.
-- This SQL is regenerated daily by scripts/refresh_known_agents.py;
-- do not hand-edit the VALUES block — edit the script's OPERATOR_SEED
-- or extend its sources instead.
--
-- Directory size: {count} wallets ({sources})
-- Regenerated: {regenerated}
WITH payers AS (
  SELECT
    "from"          AS payer,
    COUNT(*)        AS payments,
    MAX(block_time) AS last_seen
  FROM tokens_base.transfers
  WHERE contract_address = {usdc}
    AND "to" = {gateway}
  GROUP BY 1
),
known_agents (wallet, agent_name, source) AS (
  VALUES
{values}
)
SELECT
  ka.agent_name AS agent,
  p.payer       AS wallet,
  p.payments,
  p.last_seen,
  ka.source     AS registry
FROM payers p
INNER JOIN known_agents ka
  ON LOWER(CAST(ka.wallet AS varchar)) = LOWER(CAST(p.payer AS varchar))
ORDER BY p.payments DESC
"""


def build_sql(rows: list[tuple[str, str, str]]) -> str:
    from datetime import datetime, timezone
    values_lines = []
    for wallet, name, source in rows:
        values_lines.append(f"    ({wallet}, '{name}', '{source}')")
    values_sql = ",\n".join(values_lines)
    by_source: dict[str, int] = {}
    for _, _, src in rows:
        by_source[src] = by_source.get(src, 0) + 1
    src_summary = ", ".join(f"{c} {s}" for s, c in sorted(by_source.items()))
    return SQL_TEMPLATE.format(
        count=len(rows),
        sources=src_summary,
        regenerated=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        usdc=USDC_BASE,
        gateway=GATEWAY_PAYTO,
        values=values_sql,
    )


def main() -> None:
    print("Refreshing known-agent directory…")
    print("[1] Operator seed:", len(OPERATOR_SEED), "entries")
    print("[2] Bazaar /active fetch…")
    bazaar_rows = from_bazaar()
    print(f"    → {len(bazaar_rows)} rows")
    print("[3] 8004scan /agents fetch…")
    scan_rows = from_8004scan()
    print(f"    → {len(scan_rows)} rows")

    deduped = dedupe(OPERATOR_SEED + bazaar_rows + scan_rows)
    print(f"[4] Deduped union: {len(deduped)} wallets")

    sql = build_sql(deduped)
    output_path = os.environ.get("OUTPUT_PATH", "/tmp/known_agents_directory.sql")
    with open(output_path, "w") as f:
        f.write(sql)
    print(f"[5] SQL written to {output_path} ({len(sql)} chars)")
    print(f"[6] Caller: dune query update {QUERY_ID} --sql \"$(cat {output_path})\"")


if __name__ == "__main__":
    main()
