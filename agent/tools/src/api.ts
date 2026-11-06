// The engine's agent routes (DESIGN §3.2), with the AGENT token. bamboo-tools never touches the
// database: everything goes through here.
import {
  ApiError,
  ImportResponse,
  KnownResponse,
  NotificationsResponse,
  NudgeResponse,
  sharedConfig,
  type ImportRequest,
} from "@bamboo/shared";
import type { z } from "zod";

const cfg = sharedConfig.tools;

export class ApiCallError extends Error {
  override name = "ApiCallError";
  constructor(
    readonly status: number,
    /** The `ApiError.error` code, or `http_<status>` / `network` when there's no body. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export interface ApiOptions {
  baseUrl: string;
  token: string;
  /** Where the token came from (never its value), named in a 401's message. */
  tokenSource?: string | null;
  fetch?: Fetch;
  retries?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Api {
  private readonly fetch: Fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: ApiOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.retries = opts.retries ?? cfg.apiRetries;
    this.retryDelayMs = opts.retryDelayMs ?? cfg.apiRetryDelayMs;
  }

  /**
   * One call, retried on network errors, 5xx and 409 `conflict` (a concurrent import inserted
   * the same turn). Imports carry an `Idempotency-Key`, so retrying a POST is safe.
   */
  async call<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: S | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<z.output<S> | null> {
    let lastError: ApiCallError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * attempt);
      let res: Response;
      try {
        res = await this.fetch(`${this.opts.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.requestTimeoutMs),
        });
      } catch (e) {
        lastError = new ApiCallError(0, "network", `${method} ${path}: ${(e as Error).message}`);
        continue;
      }
      if (res.ok) {
        if (res.status === 204 || schema === null) return null;
        return schema.parse(await res.json()) as z.output<S>;
      }
      const err = ApiError.safeParse(await res.json().catch(() => null));
      const code = err.success ? err.data.error : `http_${res.status}`;
      const detail = err.success && err.data.message ? ` (${err.data.message})` : "";
      const source =
        res.status === 401 && this.opts.tokenSource
          ? `; token from ${this.opts.tokenSource}, which doesn't match the engine's AGENT_API_TOKEN`
          : "";
      lastError = new ApiCallError(
        res.status,
        code,
        `${method} ${path}: ${res.status} ${code}${detail}${source}`,
      );
      if (!(res.status >= 500 || code === "conflict")) break;
    }
    throw lastError!;
  }

  async known(turnKeys: string[]): Promise<string[]> {
    const res = await this.call("POST", "/api/imports/known", KnownResponse, {
      turn_keys: turnKeys,
    });
    return res!.unknown;
  }

  async importChunk(body: ImportRequest, idempotencyKey: string | null): Promise<ImportResponse> {
    const headers: Record<string, string> = idempotencyKey
      ? { "idempotency-key": idempotencyKey }
      : {};
    return (await this.call("POST", "/api/imports", ImportResponse, body, headers))!;
  }

  async notifications() {
    return (await this.call("GET", "/api/agent/notifications", NotificationsResponse))!
      .notifications;
  }

  async markNotified(importId: string): Promise<void> {
    await this.call("POST", `/api/imports/${encodeURIComponent(importId)}/notified`, null, {});
  }

  async nudge(): Promise<string | null> {
    return (await this.call("GET", "/api/agent/nudge", NudgeResponse))!.text;
  }
}
