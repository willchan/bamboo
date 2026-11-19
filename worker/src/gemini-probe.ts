// A Gemini probe on synthetic input only (H7): four single requests that tell a bad key from a
// schema Gemini refuses. `gemini-probe-main.ts` runs it on the Mac:
//   pnpm --filter @bamboo/worker gemini-probe -- --gemini-key=paid
// Each request carries a prompt and synthetic text from worker/tests/fixtures (never a real turn);
// the output is each request's outcome (ok, or Google's status and error detail), never a reply.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractTurnInput } from "@bamboo/shared";
import { z } from "zod";
import { RESULT_SCHEMA } from "./extract";
import type { ChatModel } from "./extract";
import { GeminiError } from "./gemini";
import { ReadingReply, RefereeReply } from "./pinyin-job";
import { PROMPTS_DIR, fill, userMessage, type Prompt } from "./prompt";

/** The first synthetic fixture turn. */
export function syntheticTurn(): ExtractTurnInput {
  const f = JSON.parse(
    readFileSync(join(PROMPTS_DIR, "..", "tests", "fixtures", "turns.json"), "utf8"),
  ) as { turns: ExtractTurnInput[] };
  const t = f.turns[0]!;
  return {
    turn_id: t.turn_id,
    conversation_title: t.conversation_title,
    user_text: t.user_text,
    reply_text: t.reply_text,
  };
}

export interface ProbeOutcome {
  name: string;
  ok: boolean;
  /** "ok (N chars of JSON)" or the client's error (status and Google's sanitized detail). */
  outcome: string;
  kind?: string;
}

export interface ProbePrompts {
  extract: Prompt;
  reading: Prompt;
  referee: Prompt;
}

/**
 * Four requests, in order: a tiny schema (key and endpoint), then the pinyin reading, referee and
 * extraction schemas exactly as the worker sends them (through `geminiSchema`). Run it after every
 * `make mac-update` that changes a schema: Google's "too many states for serving" only shows up
 * on a real request (H7).
 */
export async function runProbe(model: ChatModel, prompts: ProbePrompts): Promise<ProbeOutcome[]> {
  const turn = syntheticTurn();
  const extractMessages = [
    { role: "system" as const, content: prompts.extract.system },
    { role: "user" as const, content: userMessage(prompts.extract, turn) },
  ];
  const values = { hanzi: "我得走了。", context: "我得走了，明天见。" };
  const requests: { name: string; messages: typeof extractMessages; schema: unknown }[] = [
    {
      name: "minimal",
      messages: [{ role: "user", content: 'Reply with the JSON {"ok": true}.' }],
      schema: z.toJSONSchema(z.object({ ok: z.boolean() })),
    },
    {
      name: "pinyin_reading",
      messages: [
        { role: "system", content: prompts.reading.system },
        { role: "user", content: fill(prompts.reading.user, values) },
      ],
      schema: z.toJSONSchema(ReadingReply),
    },
    {
      name: "pinyin_referee",
      messages: [
        { role: "system", content: prompts.referee.system },
        {
          role: "user",
          content: fill(prompts.referee.user, { ...values, disputes: "1: 得 → dé | děi | de" }),
        },
      ],
      schema: z.toJSONSchema(RefereeReply),
    },
    { name: "extract_turn", messages: extractMessages, schema: RESULT_SCHEMA },
  ];
  const out: ProbeOutcome[] = [];
  for (const r of requests) {
    try {
      const text = await model.chat(r.messages, r.schema as Record<string, unknown>);
      out.push({ name: r.name, ok: true, outcome: `ok (${text.length} chars of JSON)` });
    } catch (e) {
      out.push({
        name: r.name,
        ok: false,
        outcome: (e as Error).message,
        kind: e instanceof GeminiError ? e.kind : undefined,
      });
      // A used-up quota answers nothing more today.
      if (e instanceof GeminiError && e.kind === "quota") break;
    }
  }
  return out;
}
