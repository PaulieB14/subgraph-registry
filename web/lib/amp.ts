// Tiny client for ampd's SQL endpoint (:1603/).
// Single env var: AMP_SQL_URL (defaults to local for dev).
// The day ampd moves to a public host, flip the env var — no code changes.

export const AMP_URL = process.env.AMP_SQL_URL || "http://localhost:1603";

export interface AmpQueryResult {
  rows: Record<string, unknown>[];
  error?: string;
}

export async function runSql(sql: string, timeoutMs = 90_000): Promise<AmpQueryResult> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${AMP_URL}/`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: sql,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { rows: [], error: `ampd HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    const text = await res.text();
    // ampd returns one JSON object per row, newline-separated (JSON-lines)
    const rows: Record<string, unknown>[] = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === "object" && "error_code" in obj) {
          return { rows: [], error: String((obj as Record<string, unknown>).error_message ?? t) };
        }
        rows.push(obj);
      } catch {
        // Single-row JSON or non-line output — try whole-text parse once
        try {
          const obj = JSON.parse(text);
          if (Array.isArray(obj)) return { rows: obj };
          return { rows: [obj] };
        } catch {
          return { rows: [], error: `Non-JSON response: ${text.slice(0, 300)}` };
        }
      }
    }
    return { rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("aborted")) return { rows: [], error: `Query timed out after ${timeoutMs}ms` };
    return { rows: [], error: `ampd unreachable: ${msg}` };
  } finally {
    clearTimeout(tid);
  }
}
