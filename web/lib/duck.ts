// DuckDB-over-parquet backend for the /amp chat.
//
// AMP_PARQUET_GLOB is REQUIRED — module init throws if unset, so a Vercel deploy
// without the env var fails loudly at import time rather than silently leaking
// a developer's local filesystem layout.
//
// Future Regime B (R2/S3): a second env-driven mode where the glob is
// "s3://bucket/path/[0-9]*.parquet" plus AWS_* / S3_ENDPOINT env vars would
// just work via httpfs. Intentionally NOT wired up yet — Phase 2 is local only.
//
// The instance is cached at module scope so warm Vercel invocations re-use
// the in-memory DuckDB plus its loaded httpfs extension and object cache.

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

// Allowlist of glob-path prefixes. Rejects file://, /etc/, ../, etc.
const ALLOWED_GLOB_PREFIXES = [
  "/Volumes/",
  "/Users/",
  "s3://",
  "https://",
  "r2://",
];

function resolveParquetGlob(): string {
  const raw = process.env.AMP_PARQUET_GLOB;
  if (!raw || !raw.trim()) {
    throw new Error(
      "AMP_PARQUET_GLOB is required but not set. " +
        "Configure it to a parquet glob starting with one of: " +
        ALLOWED_GLOB_PREFIXES.join(", "),
    );
  }
  const glob = raw.trim();
  if (!ALLOWED_GLOB_PREFIXES.some((p) => glob.startsWith(p))) {
    throw new Error(
      `AMP_PARQUET_GLOB has disallowed prefix. Must start with one of: ${ALLOWED_GLOB_PREFIXES.join(", ")}`,
    );
  }
  return glob;
}

export const AMP_PARQUET_GLOB = resolveParquetGlob();

const DEFAULT_ROW_LIMIT = 500;
const DEFAULT_TIMEOUT_MS = 9_000;

// SQL statements that mutate state or touch the filesystem are rejected up
// front. Only read-only analytics queries are allowed. Match on whole words to
// avoid blocking innocent column names like "created_at".
const FORBIDDEN_KEYWORDS = [
  "DROP",
  "DELETE",
  "INSERT",
  "UPDATE",
  "CREATE",
  "ALTER",
  "ATTACH",
  "DETACH",
  "COPY",
  "EXPORT",
  "IMPORT",
  "PRAGMA",
  "INSTALL",
  "LOAD",
  "SET",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "CALL",
  "VACUUM",
];

function isUnsafe(sql: string): string | null {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) return "empty SQL";
  // Only allow statements that *start* with SELECT, WITH, or EXPLAIN.
  if (!/^\s*(SELECT|WITH|EXPLAIN)\b/i.test(trimmed)) {
    return "Only SELECT / WITH / EXPLAIN statements are allowed.";
  }
  // No semicolons allowed mid-string — prevents stacking a second statement.
  if (trimmed.includes(";")) {
    return "Multiple statements are not allowed.";
  }
  // Word-boundary check against forbidden keywords.
  const upper = trimmed.toUpperCase();
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(upper)) {
      return `Disallowed keyword: ${kw}`;
    }
  }
  return null;
}

let instancePromise: Promise<DuckDBInstance> | null = null;
let initPromise: Promise<DuckDBConnection> | null = null;

async function getInstance(): Promise<DuckDBInstance> {
  if (!instancePromise) {
    instancePromise = DuckDBInstance.create(":memory:", {
      // Keep the default thread count; Vercel's small footprint means
      // DuckDB picks something reasonable. Override here if needed.
    });
  }
  return instancePromise;
}

async function getConnection(): Promise<DuckDBConnection> {
  if (!initPromise) {
    initPromise = (async () => {
      const instance = await getInstance();
      const conn = await instance.connect();
      // httpfs is needed for s3://, but installing it locally is cheap and
      // future-proofs Regime B. enable_object_cache speeds up repeated
      // reads of the same parquet footer.
      try {
        await conn.run("INSTALL httpfs");
      } catch {
        // ignore — extension may already be installed
      }
      try {
        await conn.run("LOAD httpfs");
      } catch {
        // ignore — extension may already be loaded
      }
      try {
        await conn.run("SET enable_object_cache=true");
      } catch {
        // ignore — older DuckDB versions might not have this knob
      }
      return conn;
    })();
  }
  return initPromise;
}

// Convert BigInt / decimal-ish values inside row objects to strings so the
// result survives JSON.stringify. DuckDB returns BigInts for UBIGINT, and
// Decimal-shaped objects for DECIMAL(38,0). Dates are returned as Date
// instances — turn those into ISO strings for stable wire format.
function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    // DuckDB Decimal128 / similar shape: { value: bigint, scale: number, width: number }
    const v = value as Record<string, unknown>;
    if (typeof v.value === "bigint" && typeof v.scale === "number") {
      const raw = v.value as bigint;
      const scale = v.scale as number;
      if (scale === 0) return raw.toString();
      const s = raw.toString();
      const neg = s.startsWith("-");
      const digits = neg ? s.slice(1) : s;
      const padded = digits.padStart(scale + 1, "0");
      const cut = padded.length - scale;
      const out = padded.slice(0, cut) + "." + padded.slice(cut);
      return (neg ? "-" : "") + out;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = jsonSafe(v[k]);
    return out;
  }
  return value;
}

export interface RunSqlResult {
  rows: Record<string, unknown>[];
  error?: string;
  ms: number;
  truncated?: boolean;
}

// Map a raw DuckDB error message to a short generic category for client display.
// The full error is logged to server console.error in the caller. We classify on
// known DuckDB prefixes (Binder, Catalog, Parser, IO, Conversion, Out of Memory)
// and fall back to "query rejected: error" for anything else.
function sanitizeDuckError(raw: string): string {
  const m = /^([A-Z][A-Za-z ]+? Error)\b/.exec(raw);
  if (m) {
    return `query rejected: ${m[1].toLowerCase()}`;
  }
  return "query rejected: error";
}

export interface RunSqlOptions {
  rowLimit?: number;
  timeoutMs?: number;
}

export async function runSql(
  sql: string,
  options: RunSqlOptions = {},
): Promise<RunSqlResult> {
  const t0 = Date.now();
  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const unsafe = isUnsafe(sql);
  if (unsafe) {
    return { rows: [], error: unsafe, ms: Date.now() - t0 };
  }

  let conn: DuckDBConnection;
  try {
    conn = await getConnection();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[duck] init failed:", msg);
    return { rows: [], error: "query rejected: init failed", ms: Date.now() - t0 };
  }

  const cleanedSql = sql.trim().replace(/;+\s*$/, "");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RunSqlResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        rows: [],
        error: `Query timed out after ${timeoutMs}ms`,
        ms: Date.now() - t0,
      });
    }, timeoutMs);
  });

  const query: Promise<RunSqlResult> = (async () => {
    try {
      const reader = await conn.runAndReadAll(cleanedSql);
      const rawRows = reader.getRowObjects() as Record<string, unknown>[];
      const truncated = rawRows.length > rowLimit;
      const limited = truncated ? rawRows.slice(0, rowLimit) : rawRows;
      const safe = limited.map((r) => jsonSafe(r) as Record<string, unknown>);
      return {
        rows: safe,
        ms: Date.now() - t0,
        truncated: truncated || undefined,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[duck] query failed:", msg, "\nSQL:", cleanedSql);
      return { rows: [], error: sanitizeDuckError(msg), ms: Date.now() - t0 };
    }
  })();

  try {
    return await Promise.race([query, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
