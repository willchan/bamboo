// The Gemini client (DESIGN §5.5.2, §5.5.7): `models/{model}:generateContent` with JSON output
// constrained to a schema, the free-tier key in the `x-goog-api-key` header (never in the URL,
// which can show up in error messages), and the rate limiter in front of every request. A request
// carries only the prompt and what the job gives it (one turn, or one phrase): DESIGN §5.5.8.
//
// Errors are classified for the worker: a per-minute 429 is waited out here; a used-up daily
// quota is `quota` (the worker waits for the reset, no fallback); network errors, timeouts and
// 5xx are retried, then `unavailable`; any other 4xx (a bad key, a schema Gemini refuses) is
// `rejected`. Both of those send the job to Ollama. Messages hold only statuses, never the key,
// the request or the reply.
import { servableSchema, sharedConfig } from "@bamboo/shared";
import type { ChatMessage } from "./ollama";
import { RateLimiter } from "./rate-limit";

const G = sharedConfig.worker.gemini;

export type GeminiErrorKind = "quota" | "unavailable" | "rejected";

export class GeminiError extends Error {
  constructor(
    readonly kind: GeminiErrorKind,
    message: string,
    /** For `quota`: when the daily quota resets. */
    readonly resetAt?: number,
  ) {
    super(message);
  }
}

export interface GeminiOptions {
  apiUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * A JSON schema as Gemini takes it: the strict one (zod's output) without `$schema` and the limits
 * Gemini can't serve (`servableSchema`, H7: "too many states for serving"). Every Gemini request
 * goes through here, so no schema can reach Gemini with them; the caps are enforced on the reply
 * instead (`trimToCaps`, then the strict contract).
 */
export function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return servableSchema(schema);
}

interface GoogleError {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: {
      "@type"?: string;
      retryDelay?: string;
      reason?: string;
      violations?: { quotaId?: string; quotaMetric?: string }[];
      fieldViolations?: { field?: string; description?: string }[];
    }[];
  };
}

/** The longest error detail kept for logs and the job's error. */
const MAX_DETAIL_CHARS = 400;
/** A run this long that also appears in the request means the message quotes it. */
const QUOTE_WINDOW = 24;

/**
 * Google's own words about a refused request (message, ErrorInfo reason, field violations), for
 * the logs (H7). They describe request fields, not the turn, but as a guard: non-ASCII runs (the
 * turn's Chinese) become `…`, the key is masked, and a message that quotes the request's text is
 * withheld. Never the request or the reply (DESIGN §5.5.8).
 */
export function errorDetail(
  err: GoogleError["error"] | undefined,
  requestText: string,
  apiKey: string,
): string {
  if (!err) return "";
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  for (const d of err.details ?? []) {
    if (d.reason) parts.push(`reason ${d.reason}`);
    for (const v of d.fieldViolations ?? [])
      parts.push(`field ${v.field ?? "?"}${v.description ? `: ${v.description}` : ""}`);
  }
  let text = parts.join("; ");
  if (apiKey.length >= 8) text = text.split(apiKey).join("[key]");
  text = text
    .replace(/[^\x20-\x7e]+/gu, "…")
    .replace(/\s+/gu, " ")
    .trim();
  for (let i = 0; i + QUOTE_WINDOW <= text.length; i++) {
    if (requestText.includes(text.slice(i, i + QUOTE_WINDOW))) {
      text = "(message withheld: it quotes the request)";
      break;
    }
  }
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

/** `"37s"` / `"1.5s"` → ms. */
const parseDelay = (d: string | undefined): number | null => {
  const m = d ? /^(\d+(?:\.\d+)?)s$/u.exec(d) : null;
  return m ? Math.round(Number(m[1]) * 1000) : null;
};

export class GeminiClient {
  readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  /** generateContent requests sent by this process (H7's counts), retries included. */
  requests = 0;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    readonly limiter: RateLimiter,
    o: GeminiOptions = {},
  ) {
    this.apiUrl = (o.apiUrl ?? G.apiUrl).replace(/\/+$/u, "");
    this.timeoutMs = o.timeoutMs ?? G.timeoutSeconds * 1000;
    this.fetchFn = o.fetchFn ?? fetch;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.log ?? (() => {});
  }

  /** When the daily quota resets, if it's used up; else null. */
  quotaResetAt(): number | null {
    return this.limiter.quotaResetAt();
  }

  /**
   * One generateContent call (after the limiter), returning the reply's text (the JSON). The
   * system message becomes `systemInstruction`; assistant turns are the model's.
   */
  async chat(messages: ChatMessage[], schema: Record<string, unknown>): Promise<string> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content);
    const body = {
      ...(system.length ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}),
      contents: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      generationConfig: {
        temperature: G.temperature,
        responseMimeType: "application/json",
        responseJsonSchema: geminiSchema(schema),
      },
    };

    // The request's own text, so an error message that quotes it is withheld (errorDetail).
    const requestText = messages.map((m) => m.content).join("\n");
    let failures = 0;
    let rateRetries = 0;
    let backoff = G.backoffSeconds * 1000;
    for (;;) {
      const resetAt = this.limiter.quotaResetAt();
      if (resetAt !== null) {
        throw new GeminiError("quota", "gemini: daily quota used up", resetAt);
      }
      const wait = this.limiter.waitMs();
      if (wait > 0) {
        this.log(`gemini: at ${this.limiterLabel()}; waiting ${Math.ceil(wait / 1000)}s`);
        await this.sleep(wait);
        continue;
      }
      this.limiter.record();
      this.requests += 1;

      let res: Response;
      try {
        res = await this.fetchFn(`${this.apiUrl}/models/${this.model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        const what = (e as Error).name === "TimeoutError" ? "timed out" : "network error";
        failures += 1;
        if (failures >= G.failuresBeforeFallback)
          throw new GeminiError("unavailable", `gemini: ${what}`);
        this.log(`gemini: ${what}; retrying in ${G.retryPauseSeconds}s`);
        await this.sleep(G.retryPauseSeconds * 1000);
        continue;
      }

      if (res.ok) {
        const json = (await res.json().catch(() => null)) as {
          candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
          promptFeedback?: { blockReason?: string };
        } | null;
        const cand = json?.candidates?.[0];
        const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        if (!text) {
          const why = json?.promptFeedback?.blockReason ?? cand?.finishReason ?? "no content";
          throw new GeminiError("rejected", `gemini: reply had no text (${why})`);
        }
        return text;
      }

      const err = ((await res.json().catch(() => null)) as GoogleError | null)?.error;
      const label = `HTTP ${res.status}${err?.status ? ` ${err.status}` : ""}`;
      if (res.status === 429) {
        const daily = (err?.details ?? []).some((d) =>
          (d.violations ?? []).some((v) =>
            /PerDay/iu.test(`${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`),
          ),
        );
        if (daily) {
          const at = this.limiter.exhaust();
          throw new GeminiError("quota", `gemini: daily quota used up (${label})`, at);
        }
        rateRetries += 1;
        if (rateRetries > G.maxRateLimitRetries) {
          throw new GeminiError("unavailable", `gemini: still rate limited (${label})`);
        }
        const hinted = parseDelay(err?.details?.find((d) => d.retryDelay)?.retryDelay);
        const delay = Math.min(hinted ?? backoff, sharedConfig.worker.maxBackoffSeconds * 1000);
        backoff = Math.min(backoff * 2, sharedConfig.worker.maxBackoffSeconds * 1000);
        this.log(`gemini: rate limited (${label}); backing off ${Math.ceil(delay / 1000)}s`);
        await this.sleep(delay);
        continue;
      }
      if (res.status >= 500) {
        failures += 1;
        if (failures >= G.failuresBeforeFallback)
          throw new GeminiError("unavailable", `gemini: ${label}`);
        this.log(`gemini: ${label}; retrying in ${G.retryPauseSeconds}s`);
        await this.sleep(G.retryPauseSeconds * 1000);
        continue;
      }
      const detail = errorDetail(err, requestText, this.apiKey);
      throw new GeminiError("rejected", `gemini: ${label}${detail ? ` (${detail})` : ""}`);
    }
  }

  private limiterLabel(): string {
    return `the per-minute limit (${this.limiter.today} request(s) today)`;
  }
}
