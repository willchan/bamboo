// Machine routes (DESIGN §3.1–3.2): bearer-token auth per scope, JSON bodies checked against the
// shared contracts, and one error shape (`ApiError`) everywhere.
import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiError, ApiErrorCode } from "@bamboo/shared";
import type { z } from "zod";
import type { Env } from "../auth/allowlist";

/** Which token a route takes. Each token opens only its own routes. */
export type TokenScope = "agent" | "worker" | "cron";

export const TOKEN_ENV: Record<TokenScope, string> = {
  agent: "AGENT_API_TOKEN",
  worker: "WORKER_API_TOKEN",
  cron: "CRON_SECRET",
};

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison (hashing first makes the lengths equal). */
export const tokensEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export function apiError(
  status: number,
  error: ApiErrorCode,
  extra: Omit<ApiError, "error"> = {},
): Response {
  return Response.json({ error, ...extra } satisfies ApiError, { status });
}

/**
 * Null when the request carries this scope's bearer token; otherwise the error response (401, or
 * 503 when the server has no token configured for the scope, so a missing env var never opens
 * a route).
 */
export function checkBearer(req: Request, scope: TokenScope, env: Env = process.env) {
  const expected = env[TOKEN_ENV[scope]];
  if (!expected) return apiError(503, "not_configured", { message: `${TOKEN_ENV[scope]} unset` });
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/iu.exec(header.trim());
  if (!m || !tokensEqual(m[1]!, expected)) return apiError(401, "unauthorized");
  return null;
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Read and validate a JSON body; 413 above `maxBytes`, 400 on bad JSON or a contract mismatch. */
export async function readBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  maxBytes?: number,
): Promise<Parsed<z.output<S>>> {
  const text = await req.text();
  if (maxBytes !== undefined && Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, response: apiError(413, "too_large") };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, response: apiError(400, "invalid_body", { message: "not JSON" }) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      response: apiError(400, "invalid_body", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }),
    };
  }
  return { ok: true, data: parsed.data };
}
