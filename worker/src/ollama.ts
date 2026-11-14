// The Ollama client (DESIGN §1.2, §5.3): the model check (`GET /api/tags`) and `extract_turn`
// through `POST /api/chat` with `format` set to the result's JSON schema, plus one repair turn.
import {
  ExtractTurnResult,
  ModelExtractTurnResult,
  sharedConfig,
  type ExtractTurnInput,
} from "@bamboo/shared";
import { z } from "zod";
import { repairMessage, userMessage, type Prompt } from "./prompt";

const O = sharedConfig.worker.ollama;
const P = sharedConfig.worker.modelParams;

/** The `num_ctx` and `keep_alive` the host uses for this model (config `modelParams`). */
export const modelParams = (model: string) => P[model] ?? P.default!;

/**
 * The JSON schema Ollama constrains the reply to (`ModelExtractTurnResult`): no `addressee`,
 * `note` required, tags only from the fixed list.
 */
export const RESULT_SCHEMA = z.toJSONSchema(ModelExtractTurnResult);

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Ollama itself failed (down, HTTP error, timeout, unknown model), not the model's output. */
export class OllamaError extends Error {}

export class OllamaClient {
  constructor(
    readonly url: string,
    readonly model: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = sharedConfig.worker.ollamaTimeoutSeconds * 1000,
  ) {}

  /** True if `model` is pulled. Throws OllamaError if Ollama doesn't answer. */
  async hasModel(): Promise<boolean> {
    const res = await this.call("GET", "/api/tags", undefined, 10_000);
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    const want = this.model.includes(":") ? this.model : `${this.model}:latest`;
    return (body.models ?? []).some((m) => m.name === want || m.model === want);
  }

  /** One non-streaming chat call; returns the assistant message's content. */
  async chat(messages: ChatMessage[]): Promise<string> {
    const res = await this.call("POST", "/api/chat", {
      model: this.model,
      messages,
      stream: false,
      format: RESULT_SCHEMA,
      think: O.think,
      keep_alive: modelParams(this.model).keepAlive,
      options: { temperature: O.temperature, num_ctx: modelParams(this.model).numCtx },
    });
    const body = (await res.json()) as { message?: { content?: unknown } };
    const content = body.message?.content;
    if (typeof content !== "string") throw new OllamaError("chat reply has no message content");
    return content;
  }

  private async call(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs) {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.url}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new OllamaError(`${method} ${path}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new OllamaError(`${method} ${path}: HTTP ${res.status} ${text}`.trim());
    }
    return res;
  }
}

export type Extraction =
  | { ok: true; result: ExtractTurnResult; repaired: boolean; latencyMs: number }
  | { ok: false; error: string; repaired: boolean; latencyMs: number; ollamaDown: boolean };

/** The model's reply checked against the contract: the result, or the errors for a repair turn. */
export function checkReply(
  content: string,
): { ok: true; result: ExtractTurnResult } | { ok: false; errors: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (e) {
    return { ok: false, errors: `- not valid JSON (${(e as Error).message})` };
  }
  const parsed = ExtractTurnResult.safeParse(json);
  if (parsed.success) return { ok: true, result: parsed.data };
  const lines = parsed.error.issues
    .slice(0, 10)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
  if (parsed.error.issues.length > 10) lines.push(`- … ${parsed.error.issues.length - 10} more`);
  return { ok: false, errors: lines.join("\n") };
}

export interface ChatModel {
  chat(messages: ChatMessage[]): Promise<string>;
}

/**
 * Run one `extract_turn` attempt: the prompt, and on invalid output one repair turn (the bad reply
 * plus the validation errors). A second invalid reply fails the attempt; the engine decides
 * whether the job is retried (DESIGN §5.3).
 */
export async function extractTurn(
  ollama: ChatModel,
  prompt: Prompt,
  input: ExtractTurnInput,
  now: () => number = Date.now,
): Promise<Extraction> {
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: userMessage(prompt, input) },
  ];
  let repaired = false;
  try {
    const first = await ollama.chat(messages);
    const c1 = checkReply(first);
    if (c1.ok) return { ok: true, result: c1.result, repaired, latencyMs: elapsed() };

    repaired = true;
    messages.push(
      { role: "assistant", content: first },
      { role: "user", content: repairMessage(prompt, c1.errors) },
    );
    const c2 = checkReply(await ollama.chat(messages));
    if (c2.ok) return { ok: true, result: c2.result, repaired, latencyMs: elapsed() };
    return {
      ok: false,
      error: `invalid output after the repair turn:\n${c2.errors}`,
      repaired,
      latencyMs: elapsed(),
      ollamaDown: false,
    };
  } catch (e) {
    return {
      ok: false,
      error: `ollama: ${(e as Error).message}`,
      repaired,
      latencyMs: elapsed(),
      ollamaDown: e instanceof OllamaError,
    };
  }
}
