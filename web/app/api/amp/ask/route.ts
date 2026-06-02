import Anthropic from "@anthropic-ai/sdk";
import { AMP_URL, runSql } from "@/lib/amp";
import { SYSTEM_PROMPT } from "@/lib/ampSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sonnet is fast enough that interactive chat feels responsive; Opus is overkill
// for SQL translation. Override via AMP_MODEL env if you want to A/B.
const MODEL = process.env.AMP_MODEL || "claude-sonnet-4-6";

interface AskRequest {
  question: string;
}

interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
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
        "Execute a single SQL statement against ampd's :1603/ endpoint. " +
        "Returns the rows as JSON. Use one statement per call, LIMIT 200.",
      input_schema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "A single SQL statement, no trailing semicolon." },
        },
        required: ["sql"],
      },
    },
  ];

  // Multi-turn tool-use loop. Cap iterations so we never spin.
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];

  const trace: { sql?: string; rows?: number; error?: string; ms?: number }[] = [];
  const turnTimings: { turn: number; llm_ms: number }[] = [];
  let answerText = "";
  const t0 = Date.now();

  for (let i = 0; i < 6; i++) {
    let resp: Anthropic.Message;
    const tLLM = Date.now();
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
    turnTimings.push({ turn: i + 1, llm_ms: Date.now() - tLLM });

    if (resp.stop_reason !== "tool_use") {
      // Final assistant message. Pull text blocks.
      answerText = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      break;
    }

    // The model wants to call a tool. Process every tool_use block in this turn,
    // append a tool_result for each, and loop.
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
      const tSQL = Date.now();
      const result = await runSql(sql);
      trace.push({
        sql,
        rows: result.error ? undefined : result.rows.length,
        error: result.error,
        ms: Date.now() - tSQL,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        is_error: !!result.error,
        content: result.error
          ? `ERROR: ${result.error}`
          : JSON.stringify(result.rows.slice(0, 200)),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // If we hit the turn cap without a final answer, fall back to a
  // synthesis pass that's allowed to write text only (no tools), with the
  // SQL traces summarized as context. Keeps the user from seeing
  // "(no answer produced)" when the model just ran out of room.
  if (!answerText) {
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

  return Response.json({
    answer: answerText || "(no answer produced)",
    trace,
    amp_url: AMP_URL,
    model: MODEL,
    total_ms: Date.now() - t0,
    turn_timings: turnTimings,
  });
}
