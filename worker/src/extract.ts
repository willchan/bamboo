// One `extract_turn` attempt (DESIGN §5.3, §5.5.2) on any chat model (Gemini, or the Ollama
// fallback): the v4 prompt, the reply constrained to `ModelExtractTurnResultV4`, one repair turn on
// invalid output. The model's shape is then turned into the API's `ExtractTurnResult`.
import {
  ExtractTurnResult,
  ModelExtractTurnResultV4,
  trimArrays,
  trimToCaps,
  trimmedTotal,
  type ExtractItem,
  type ExtractTurnInput,
} from "@bamboo/shared";
import { z } from "zod";
import type { ChatMessage } from "./ollama";
import { repairMessage, userMessage, type Prompt } from "./prompt";

/**
 * The strict JSON schema: Ollama's `format` as is; Gemini's `responseJsonSchema` without the
 * limits it can't serve (`geminiSchema`, H7).
 */
export const RESULT_SCHEMA = z.toJSONSchema(ModelExtractTurnResultV4) as Record<string, unknown>;

export interface ChatModel {
  chat(messages: ChatMessage[], schema: Record<string, unknown>): Promise<string>;
}

/**
 * The model's v4 reply as the API's contract: examples (with `example` = the first, for the
 * engine's older path), the breakdown's `summary` as a term's `meaning` or a sentence's `note`,
 * and Gemini's pinyin, unless `keepPinyin` is off (the Ollama fallback carries none, §5.5.2).
 */
export function fromModelV4(
  r: ModelExtractTurnResultV4,
  opts: { keepPinyin: boolean },
): ExtractTurnResult {
  return {
    turn_kind: r.turn_kind,
    items: r.items.map((i): ExtractItem => {
      const examples = i.kind === "term" ? i.examples : [];
      return {
        kind: i.kind,
        hanzi: i.hanzi,
        english: i.english,
        note: i.note,
        heard_as: i.heard_as,
        example: examples[0] ?? null,
        examples,
        usefulness: i.usefulness,
        tags: i.tags,
        breakdown: i.breakdown
          ? i.kind === "term"
            ? { parts: i.breakdown.parts, meaning: i.breakdown.summary }
            : { parts: i.breakdown.parts, note: i.breakdown.summary }
          : null,
        pinyin: opts.keepPinyin && i.pinyin.length ? i.pinyin : null,
      };
    }),
  };
}

/** Zod issues as `path: message` lines, never values (DESIGN §5.3). */
export function issueLines(error: z.ZodError): string {
  const lines = error.issues
    .slice(0, 10)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
  if (error.issues.length > 10) lines.push(`- … ${error.issues.length - 10} more`);
  return lines.join("\n");
}

/** Parse a JSON reply against `schema`: the value, or the errors for a repair turn. */
export function parseReply<S extends z.ZodType>(
  content: string,
  schema: S,
  /** Cut top-level arrays to this many entries first (`trimArrays`; pinyin replies, H7). */
  maxEntries?: number,
): { ok: true; value: z.output<S> } | { ok: false; errors: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (e) {
    return { ok: false, errors: `- not valid JSON (${(e as Error).message})` };
  }
  const parsed = schema.safeParse(maxEntries === undefined ? json : trimArrays(json, maxEntries));
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: issueLines(parsed.error) };
}

/**
 * The model's reply cut to the caps Gemini's schema can't enforce (`trimToCaps`, H7), checked
 * against the strict v4 schema, then as the API's contract. `trimmed` counts what was cut.
 */
export function checkReply(
  content: string,
  opts: { keepPinyin: boolean } = { keepPinyin: true },
): { ok: true; result: ExtractTurnResult; trimmed: number } | { ok: false; errors: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (e) {
    return { ok: false, errors: `- not valid JSON (${(e as Error).message})` };
  }
  const t = trimToCaps(json);
  const r = ModelExtractTurnResultV4.safeParse(t.value);
  if (!r.success) return { ok: false, errors: issueLines(r.error) };
  const out = ExtractTurnResult.safeParse(fromModelV4(r.data, opts));
  return out.success
    ? { ok: true, result: out.data, trimmed: trimmedTotal(t.trimmed) }
    : { ok: false, errors: issueLines(out.error) };
}

/**
 * Ask a model for a JSON object of `schema`, with one repair turn on invalid output. Model errors
 * (the client threw) come back as `modelError`, for the caller to classify.
 */
export async function askJson<T>(
  model: ChatModel,
  messages: ChatMessage[],
  jsonSchema: Record<string, unknown>,
  check: (content: string) => { ok: true; value: T } | { ok: false; errors: string },
  repair: (errors: string) => string,
): Promise<
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; repaired: boolean; error: string; modelError?: Error }
> {
  let repaired = false;
  try {
    const first = await model.chat(messages, jsonSchema);
    const c1 = check(first);
    if (c1.ok) return { ok: true, value: c1.value, repaired };
    repaired = true;
    const again = [
      ...messages,
      { role: "assistant" as const, content: first },
      { role: "user" as const, content: repair(c1.errors) },
    ];
    const c2 = check(await model.chat(again, jsonSchema));
    if (c2.ok) return { ok: true, value: c2.value, repaired };
    return { ok: false, repaired, error: `invalid output after the repair turn:\n${c2.errors}` };
  } catch (e) {
    return { ok: false, repaired, error: (e as Error).message, modelError: e as Error };
  }
}

export type Extraction =
  | {
      ok: true;
      result: ExtractTurnResult;
      repaired: boolean;
      latencyMs: number;
      /** Items, examples, tags, breakdowns or ratings cut to the caps (`trimToCaps`). */
      trimmed: number;
    }
  | { ok: false; error: string; repaired: boolean; latencyMs: number; modelError?: Error };

export interface ExtractOptions {
  /** Cut the reply to this many characters (Ollama's context, §10 #40); Gemini gets it whole. */
  maxReplyChars?: number;
  /** Keep the model's pinyin (Gemini) or drop it (the Ollama fallback). */
  keepPinyin?: boolean;
}

/**
 * Run one `extract_turn` attempt: the prompt, and on invalid output one repair turn (the bad reply
 * plus the validation errors). A second invalid reply fails the attempt; the engine decides
 * whether the job is retried (DESIGN §5.3).
 */
export async function extractTurn(
  model: ChatModel,
  prompt: Prompt,
  input: ExtractTurnInput,
  now: () => number = Date.now,
  opts: ExtractOptions = {},
): Promise<Extraction> {
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const keepPinyin = opts.keepPinyin ?? true;
  const r = await askJson(
    model,
    [
      { role: "system", content: prompt.system },
      { role: "user", content: userMessage(prompt, input, opts.maxReplyChars) },
    ],
    RESULT_SCHEMA,
    (c) => {
      const x = checkReply(c, { keepPinyin });
      return x.ok ? { ok: true, value: x } : x;
    },
    (errors) => repairMessage(prompt, errors),
  );
  return r.ok
    ? {
        ok: true,
        result: r.value.result,
        trimmed: r.value.trimmed,
        repaired: r.repaired,
        latencyMs: elapsed(),
      }
    : {
        ok: false,
        error: r.error,
        repaired: r.repaired,
        latencyMs: elapsed(),
        modelError: r.modelError,
      };
}
