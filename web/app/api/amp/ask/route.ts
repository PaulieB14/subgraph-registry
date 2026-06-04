import Anthropic from "@anthropic-ai/sdk";
import { AMP_PARQUET_GLOB, runSql } from "@/lib/duck";
import { SYSTEM_PROMPT } from "@/lib/ampSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sonnet is fast enough that interactive chat feels responsive; Opus is overkill
// for SQL translation. Override via AMP_MODEL env if you want to A/B.
const MODEL = process.env.AMP_MODEL || "claude-sonnet-4-6";

// Hard wall-clock budget for the whole request. Vercel's hobby limit is 10s;
// give ourselves a small headroom by stopping at 9s.
const TOTAL_BUDGET_MS = 9_000;
const MAX_TURNS = 6;

interface AskRequest {
  question: string;
}

interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface TraceStep {
  sql: string;
  ms: number;
  rows?: number;
  error?: string;
}

// The model writes "FROM settlements"; we rewrite it to a read_parquet call
// pointing at the configured glob. Case-insensitive, also handles "from   settlements".
//
// A naive regex replace would also munge "FROM settlements" appearing inside
// SQL comments or string literals. Walk the SQL with a tiny state machine that
// skips line-comments (-- … \n), block-comments (/* … */), and single/double
// quoted strings (respecting SQL '' / "" escapes). Only substitute occurrences
// found in code state. Whitespace and case in the original SQL are preserved.
function rewriteSettlements(sql: string, glob: string): string {
  const replacement = `FROM read_parquet('${glob.replace(/'/g, "''")}')`;
  const pattern = /^FROM\s+settlements\b/i;
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    // Block comment /* ... */
    if (c === "/" && n === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // Line comment -- ... \n
    if (c === "-" && n === "-") {
      const nl = sql.indexOf("\n", i + 2);
      const stop = nl === -1 ? sql.length : nl;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // Quoted string ' ... ' or " ... " (with doubled-quote escape)
    if (c === "'" || c === '"') {
      const q = c;
      out += c;
      i++;
      while (i < sql.length) {
        if (sql[i] === q && sql[i + 1] === q) {
          out += q + q;
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Code state: only substitute at word boundaries.
    const isBoundary = i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]);
    if (isBoundary) {
      const m = pattern.exec(sql.slice(i));
      if (m) {
        out += replacement;
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY missing on the server. Set it in .env.local for `npm run dev`." },
      { status: 500 },
    );
  }

  let body: AskRequest;
  try {
    body = (await req.json()) as AskRequest;
  } catch {
    return Response.json({ error: "Body must be JSON: { question: string }" }, { status: 400 });
  }
  const question = (body.question || "").trim();
  if (!question) {
    return Response.json({ error: "question is required" }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });

  const tools: Anthropic.Tool[] = [
    {
      name: "run_sql",
      description:
        "Execute a single read-only SQL statement against the settlements parquet dataset " +
        "via DuckDB. Use one statement per call, write 'FROM settlements', and include " +
        "LIMIT 500 unless the user explicitly asks for more. Returns rows as JSON.",
      input_schema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description:
              "A single SELECT / WITH / EXPLAIN statement, no trailing semicolon. " +
              "Use 'FROM settlements' as the table.",
          },
        },
        required: ["sql"],
      },
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];

  const trace: TraceStep[] = [];
  let answerText = "";
  const t0 = Date.now();
  const budgetLeft = () => TOTAL_BUDGET_MS - (Date.now() - t0);

  for (let i = 0; i < MAX_TURNS; i++) {
    if (budgetLeft() <= 500) break;

    let resp: Anthropic.Message;
    try {
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: `Anthropic error: ${msg}` }, { status: 502 });
    }

    if (resp.stop_reason !== "tool_use") {
      answerText = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      break;
    }

    // Tool turn: run every tool_use block in this assistant message.
    messages.push({ role: "assistant", content: resp.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const use = block as ToolUse;
      if (use.name !== "run_sql") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: `Unknown tool: ${use.name}`,
        });
        continue;
      }
      const sql = String((use.input as { sql?: unknown }).sql || "").trim();
      const rewritten = rewriteSettlements(sql, AMP_PARQUET_GLOB);
      // Tight per-call timeout so a single bad query can't eat the whole budget.
      const perCallTimeout = Math.max(1500, Math.min(8000, budgetLeft() - 500));
      const result = await runSql(rewritten, { timeoutMs: perCallTimeout });

      const step: TraceStep = { sql, ms: result.ms };
      if (result.error) step.error = result.error;
      else step.rows = result.rows.length;
      trace.push(step);

      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        is_error: !!result.error,
        content: result.error
          ? `ERROR: ${result.error}`
          : JSON.stringify(result.rows),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Synthesis fallback: if the loop exited without an assistant text turn,
  // do one final tool-less call summarizing the trace into an answer.
  if (!answerText && budgetLeft() > 500) {
    try {
      const summary = await client.messages.create({
        model: MODEL,
        max_tokens: 600,
        system:
          "You're being asked to answer a user's question given a partial " +
          "transcript of SQL calls and their results. Even if no single " +
          "call gave the full answer, write the best plain-English answer " +
          "you can from what's known, and clearly state what's unknown.",
        messages: [
          {
            role: "user",
            content:
              `Original question: ${question}\n\n` +
              `SQL trace so far:\n` +
              trace
                .map(
                  (t, i) =>
                    `[${i + 1}] ${t.sql}\n  → ${
                      t.error ? "ERROR: " + t.error : `${t.rows} rows`
                    }`,
                )
                .join("\n") +
              `\n\nAnswer the question concisely.`,
          },
        ],
      });
      answerText = summary.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    } catch {
      // fall through with empty answer
    }
  }

  // Log the configured glob server-side for debugging — never echo it to clients.
  console.info("[amp/ask]", {
    question_chars: question.length,
    trace_steps: trace.length,
    total_ms: Date.now() - t0,
    parquet_path: AMP_PARQUET_GLOB,
  });

  return Response.json({
    answer: answerText || "(no answer produced)",
    trace,
    model: MODEL,
    total_ms: Date.now() - t0,
  });
}
