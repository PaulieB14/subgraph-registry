// Dune API client — server-side only. Cached 60s via fetch revalidate.
// API key lives in DUNE_API_KEY env (set on Vercel).

const DUNE_BASE = "https://api.dune.com/api/v1";
export const REVALIDATE_SECONDS = 60;

// The 14 query IDs maintained by .github/workflows/refresh-x402-dune.yml
export const QUERIES = {
  LIFETIME_TOTALS: 7507068,
  TRENDS: 7507075,
  DAILY: 7507076,
  CUMULATIVE: 7507077,
  TOP_PAYERS: 7507078,
  CONCENTRATION: 7507079,
  NEW_PAYERS: 7507080,
  RECENT_PAYMENTS: 7507081,
  ACTIVITY_HEATMAP: 7507082,
  HOURS_SINCE: 7507083,
  WALLET_TYPE: 7507130,
  KNOWN_AGENTS: 7507131,
  INTER_ARRIVAL: 7507132,
  ACTIVE_DAYS: 7507133,
} as const;

export type DuneRow = Record<string, unknown>;

interface DuneResultsResponse {
  execution_id?: string;
  query_id?: number;
  state?: string;
  result?: {
    rows?: DuneRow[];
    metadata?: { row_count?: number };
  };
  // Some endpoints return rows at top level
  rows?: DuneRow[];
}

export async function fetchQueryRows<T = DuneRow>(queryId: number): Promise<T[]> {
  const key = process.env.DUNE_API_KEY;
  if (!key) {
    // Surface clearly during local dev; in prod Vercel env should always be set.
    console.warn(`[dune] DUNE_API_KEY not set; returning empty rows for query ${queryId}`);
    return [];
  }
  const url = `${DUNE_BASE}/query/${queryId}/results?limit=10000`;
  try {
    const res = await fetch(url, {
      headers: { "X-Dune-API-Key": key },
      next: { revalidate: REVALIDATE_SECONDS, tags: [`dune:${queryId}`] },
    });
    if (!res.ok) {
      console.warn(`[dune] query ${queryId} HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as DuneResultsResponse;
    const rows = json.result?.rows ?? json.rows ?? [];
    return rows as T[];
  } catch (e) {
    console.warn(`[dune] query ${queryId} fetch failed:`, e);
    return [];
  }
}

// Helper for numeric fields that might come back as string or number
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
