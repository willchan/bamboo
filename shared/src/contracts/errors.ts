// Every machine route answers errors with this body and one of these codes (DESIGN §3.2).
import { z } from "zod";

export const API_ERROR_CODES = [
  /** 400: the body isn't JSON or doesn't match the contract (`issues` says where). */
  "invalid_body",
  /** 401: missing or wrong bearer token for this route. */
  "unauthorized",
  /** 404: unknown import or job id. */
  "not_found",
  /** 409: `complete` with an attempt that is no longer the job's current lease. */
  "stale_attempt",
  /** 409: a chunk for an import whose last chunk already arrived. */
  "import_closed",
  /** 409: a concurrent import inserted the same turn; retry the call. */
  "conflict",
  /** 413: the body is over `sharedConfig.imports.maxBodyBytes`. */
  "too_large",
  /** 422: `complete` with a result that fails `ExtractTurnResult` (counted as a failed attempt). */
  "invalid_result",
  /** 503: the route's token isn't configured on the server. */
  "not_configured",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiError = z.object({
  error: z.enum(API_ERROR_CODES),
  message: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
