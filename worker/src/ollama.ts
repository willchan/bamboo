// The Ollama client (DESIGN §1.2, §5.3): the model check (`GET /api/tags`) and chat calls through
// `POST /api/chat` with `format` set to the reply's JSON schema. Since H4 it is the fallback
// extractor (DESIGN §5.5.2), with the same extract_turn prompt (v4 and later) and schema as Gemini.
import { sharedConfig } from "@bamboo/shared";
import { RESULT_SCHEMA } from "./extract";

const O = sharedConfig.worker.ollama;
const P = sharedConfig.worker.modelParams;

/** The `num_ctx` and `keep_alive` the host uses for this model (config `modelParams`). */
export const modelParams = (model: string) => P[model] ?? P.default!;

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
  async chat(
    messages: ChatMessage[],
    schema: Record<string, unknown> = RESULT_SCHEMA,
  ): Promise<string> {
    const res = await this.call("POST", "/api/chat", {
      model: this.model,
      messages,
      stream: false,
      format: schema,
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
