// The State Engine's worker routes (DESIGN §3.2; M3 Notes *For M4*), with the WORKER token.
//   POST /api/jobs/claim        → 200 ClaimedJob | 204
//   POST /api/jobs/complete     → 200 {job_status} | 409 stale_attempt | 422 invalid_result | 404
//   POST /api/worker/heartbeat  → 204
import {
  ApiError,
  ClaimedJob,
  CompleteResponse,
  sharedConfig,
  type CompleteRequest,
  type Heartbeat,
} from "@bamboo/shared";

export type ClaimOutcome =
  { kind: "job"; job: ClaimedJob } | { kind: "empty" } | { kind: "error"; message: string };

export type CompleteOutcome =
  | { kind: "ok"; jobStatus: CompleteResponse["job_status"] }
  /** 409: the lease expired and the job moved on; drop it. */
  | { kind: "stale" }
  /** 422: the engine refused the result; the attempt is used up. */
  | { kind: "invalid_result"; message: string }
  | { kind: "not_found" }
  /** Network error, timeout, 5xx, 401…: worth retrying. */
  | { kind: "error"; message: string };

export interface Engine {
  claim(): Promise<ClaimOutcome>;
  complete(body: CompleteRequest): Promise<CompleteOutcome>;
  heartbeat(body: Heartbeat): Promise<{ ok: true } | { ok: false; message: string }>;
}

/** The engine's error code and message, if the body is an `ApiError`. */
async function apiErrorOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const e = ApiError.parse(JSON.parse(text));
    return e.message ? `${e.error}: ${e.message}` : e.error;
  } catch {
    return text.slice(0, 200);
  }
}

const httpDetail = (res: Response, detail: string) =>
  `HTTP ${res.status}${detail ? ` ${detail}` : ""}`;

export class EngineClient implements Engine {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = sharedConfig.worker.apiTimeoutSeconds * 1000,
  ) {}

  private post(path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return this.fetchFn(`${this.apiUrl}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async claim(): Promise<ClaimOutcome> {
    let res: Response;
    try {
      res = await this.post("/api/jobs/claim");
    } catch (e) {
      return { kind: "error", message: (e as Error).message };
    }
    if (res.status === 204) return { kind: "empty" };
    if (res.status !== 200)
      return { kind: "error", message: httpDetail(res, await apiErrorOf(res)) };
    const parsed = ClaimedJob.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { kind: "error", message: "claim: response is not a ClaimedJob" };
    return { kind: "job", job: parsed.data };
  }

  async complete(body: CompleteRequest): Promise<CompleteOutcome> {
    let res: Response;
    try {
      res = await this.post("/api/jobs/complete", body);
    } catch (e) {
      return { kind: "error", message: (e as Error).message };
    }
    if (res.status === 200) {
      const parsed = CompleteResponse.safeParse(await res.json().catch(() => null));
      return parsed.success
        ? { kind: "ok", jobStatus: parsed.data.job_status }
        : { kind: "error", message: "complete: response is not a CompleteResponse" };
    }
    const detail = await apiErrorOf(res);
    if (res.status === 409 && detail.startsWith("stale_attempt")) return { kind: "stale" };
    if (res.status === 422) return { kind: "invalid_result", message: detail };
    if (res.status === 404) return { kind: "not_found" };
    return { kind: "error", message: httpDetail(res, detail) };
  }

  async heartbeat(body: Heartbeat): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const res = await this.post("/api/worker/heartbeat", body);
      if (res.status === 204 || res.status === 200) return { ok: true };
      return { ok: false, message: httpDetail(res, await apiErrorOf(res)) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
