// Ollama's HTTP API for the tutor evaluation: which models are pulled and loaded, a warm-up load,
// one plain-text chat answer with its timings, and an unload (`keep_alive: 0`).
import { sharedConfig } from "@bamboo/shared";

const E = sharedConfig.tutorEval;
const P = sharedConfig.worker.modelParams;

export type Fetch = typeof fetch;

export class OllamaError extends Error {
  override name = "OllamaError";
}

export interface ChatTimings {
  text: string;
  /** Ollama's own counters (nanoseconds), when present. */
  evalCount: number | null;
  evalDurationNs: number | null;
}

export const tokensPerSec = (evalCount: number | null, evalDurationNs: number | null) =>
  evalCount && evalDurationNs ? Math.round((evalCount / (evalDurationNs / 1e9)) * 10) / 10 : null;

const withTag = (m: string) => (m.includes(":") ? m : `${m}:latest`);

export class TutorOllama {
  constructor(
    readonly url: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly opts: {
      think?: boolean;
      answerTimeoutMs?: number;
      loadTimeoutMs?: number;
    } = {},
  ) {}

  private async call(method: string, path: string, body: unknown, timeoutMs: number) {
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
    return (await res.json()) as Record<string, unknown>;
  }

  private async names(path: string): Promise<Set<string>> {
    const body = (await this.call("GET", path, undefined, 10_000)) as {
      models?: { name?: string; model?: string }[];
    };
    const out = new Set<string>();
    for (const m of body.models ?? []) {
      if (m.name) out.add(m.name);
      if (m.model) out.add(m.model);
    }
    return out;
  }

  /** Of `models`, those not pulled. */
  async missing(models: readonly string[]): Promise<string[]> {
    const pulled = await this.names("/api/tags");
    return models.filter((m) => !pulled.has(withTag(m)));
  }

  /** Models in memory now (`/api/ps`). */
  async loaded(): Promise<Set<string>> {
    return this.names("/api/ps");
  }

  /**
   * The host's `num_ctx` for this model (`worker.modelParams`): the request that loads a model
   * sets its context for every later caller, OpenClaw's replies included (DESIGN §1.2).
   */
  private options(model: string) {
    return { num_ctx: (P[model] ?? P.default!).numCtx };
  }

  /** Load `model` (an empty generate), so answers are timed without the load. */
  async load(model: string): Promise<void> {
    await this.call(
      "POST",
      "/api/generate",
      { model, prompt: "", stream: false, keep_alive: E.keepAlive, options: this.options(model) },
      this.opts.loadTimeoutMs ?? E.loadTimeoutSeconds * 1000,
    );
  }

  async unload(model: string): Promise<void> {
    await this.call("POST", "/api/generate", { model, keep_alive: 0 }, 60_000);
  }

  async answer(model: string, system: string, question: string): Promise<ChatTimings> {
    const body = await this.call(
      "POST",
      "/api/chat",
      {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: question },
        ],
        stream: false,
        think: this.opts.think ?? E.think,
        keep_alive: E.keepAlive,
        options: this.options(model),
      },
      this.opts.answerTimeoutMs ?? E.answerTimeoutSeconds * 1000,
    );
    const content = (body.message as { content?: unknown } | undefined)?.content;
    if (typeof content !== "string") throw new OllamaError("chat reply has no message content");
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      text: content,
      evalCount: num(body.eval_count),
      evalDurationNs: num(body.eval_duration),
    };
  }
}
