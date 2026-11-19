// Test doubles (not shipped behaviour): a fake State Engine that speaks the M3 worker routes as a
// `fetch` function, a fake Ollama, and a fake clock. Used by the *.test.ts files only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClaimRequest,
  CompleteRequest,
  ExtractTurnResult,
  Heartbeat,
  PinyinJobResult,
  type ClaimedJob,
  type ExtractTurnInput,
  type PinyinJobInput,
} from "@bamboo/shared";
import { PROMPTS_DIR } from "./prompt";

const FIXTURES = join(PROMPTS_DIR, "..", "tests", "fixtures");

export const ollamaFixtures = JSON.parse(readFileSync(join(FIXTURES, "ollama.json"), "utf8")) as {
  tags: unknown;
  chat_valid: { message: { content: string } };
  chat_invalid_english_too_long: { message: { content: string } };
  chat_not_json: { message: { content: string } };
};

export const fixtureTurns = (
  JSON.parse(readFileSync(join(FIXTURES, "turns.json"), "utf8")) as {
    turns: (ExtractTurnInput & { expect_kind: string })[];
  }
).turns.map((t): ExtractTurnInput => ({
  turn_id: t.turn_id,
  conversation_title: t.conversation_title,
  user_text: t.user_text,
  reply_text: t.reply_text,
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type FakeJob = {
  job_id: string;
  status: "queued" | "running" | "done" | "failed";
  attempt: number;
  /** A re-run (§4.6.1): the only extract_turn jobs a `reextract_only` claim gets. */
  reextract?: boolean;
} & ({ type: "extract_turn"; input: ExtractTurnInput } | { type: "pinyin"; input: PinyinJobInput });

/** The engine's job routes with M3's rules: attempts counted here, max 3, 409 on a stale attempt. */
export class FakeEngine {
  readonly token = "test-worker-token";
  readonly jobs: FakeJob[] = [];
  readonly heartbeats: Heartbeat[] = [];
  readonly completes: CompleteRequest[] = [];
  readonly calls: string[] = [];
  /** The `types` each claim asked for (undefined: no body). */
  readonly claimTypes: (string[] | undefined)[] = [];
  /** Whether each claim asked for `reextract_only`. */
  readonly claimReextractOnly: boolean[] = [];
  /** The next N `complete` calls fail on the network (before reaching the "server"). */
  networkFailCompletes = 0;
  /** The next N `done` results get 422 invalid_result whatever they hold. */
  refuseResults = 0;
  /** The next N `claim` calls get a 500. */
  serverErrorClaims = 0;
  /** Called on each claim with the claimed job (e.g. to stop the worker mid-job). */
  onClaim?: (job: ClaimedJob) => void;

  add(input: ExtractTurnInput, jobId = `job-${this.jobs.length + 1}`, reextract = false): void {
    this.jobs.push({
      job_id: jobId,
      type: "extract_turn",
      input,
      status: "queued",
      attempt: 0,
      reextract,
    });
  }

  addPinyin(input: PinyinJobInput, jobId = `pinyin-${this.jobs.length + 1}`): void {
    this.jobs.push({ job_id: jobId, type: "pinyin", input, status: "queued", attempt: 0 });
  }

  /** Make the job's lease expire and someone else claim it (its attempt moves on). */
  expireAndReclaim(jobId: string): void {
    const j = this.jobs.find((x) => x.job_id === jobId)!;
    j.attempt += 1;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.calls.push(url.pathname);
    if (init?.method !== "POST") return json(405, { error: "invalid_body" });
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== `Bearer ${this.token}`) return json(401, { error: "unauthorized" });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;

    if (url.pathname === "/api/worker/heartbeat") {
      this.heartbeats.push(Heartbeat.parse(body));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/jobs/claim") {
      if (this.serverErrorClaims > 0) {
        this.serverErrorClaims -= 1;
        return json(500, { error: "conflict", message: "boom" });
      }
      const parsed = body === undefined ? undefined : ClaimRequest.parse(body);
      const types = parsed?.types;
      const only = parsed?.reextract_only ?? false;
      this.claimTypes.push(types);
      this.claimReextractOnly.push(only);
      const allowed = types ?? ["extract_turn"];
      const j = this.jobs.find(
        (x) =>
          x.status === "queued" &&
          allowed.includes(x.type) &&
          !(only && x.type === "extract_turn" && !x.reextract),
      );
      if (!j) return new Response(null, { status: 204 });
      j.status = "running";
      j.attempt += 1;
      const claimed = {
        job_id: j.job_id,
        type: j.type,
        attempt: j.attempt,
        lease_expires_at: Date.now() + 600_000,
        input: j.input,
      } as ClaimedJob;
      this.onClaim?.(claimed);
      return json(200, claimed);
    }
    if (url.pathname === "/api/jobs/complete") {
      if (this.networkFailCompletes > 0) {
        this.networkFailCompletes -= 1;
        throw new TypeError("fetch failed");
      }
      const req = CompleteRequest.parse(body);
      this.completes.push(req);
      const j = this.jobs.find((x) => x.job_id === req.job_id);
      if (!j) return json(404, { error: "not_found" });
      if (j.status !== "running" || j.attempt !== req.attempt) {
        return json(409, { error: "stale_attempt" });
      }
      const retryOrFail = () => (j.status = j.attempt >= 3 ? "failed" : "queued");
      if (req.status === "done") {
        const refuse = this.refuseResults > 0;
        if (refuse) this.refuseResults -= 1;
        const schema = j.type === "pinyin" ? PinyinJobResult : ExtractTurnResult;
        if (refuse || !schema.safeParse(req.result).success) {
          retryOrFail();
          return json(422, { error: "invalid_result", message: `job is now ${j.status}` });
        }
        j.status = "done";
      } else {
        retryOrFail();
      }
      return json(200, { job_status: j.status === "running" ? "queued" : j.status });
    }
    return json(404, { error: "not_found" });
  };
}

/** A fake Ollama: `/api/tags` lists `pulled`; `/api/chat` answers from `replies` in order. */
export class FakeOllama {
  pulled = ["qwen3.5:9b"];
  down = false;
  replies: string[] = [];
  readonly chatBodies: { messages: { role: string; content: string }[]; [k: string]: unknown }[] =
    [];

  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const path = new URL(String(input)).pathname;
    if (path === "/api/tags") {
      return json(200, { models: this.pulled.map((name) => ({ name, model: name })) });
    }
    if (path === "/api/chat") {
      const body = JSON.parse(String(init?.body));
      this.chatBodies.push(body);
      const content = this.replies.shift();
      if (content === undefined) return json(500, { error: "no more fake replies" });
      return json(200, { model: body.model, message: { role: "assistant", content }, done: true });
    }
    return json(404, { error: "not found" });
  };
}

/**
 * A fake Gemini generateContent endpoint. `replies` are served in order: a string is the reply's
 * JSON text; a number is an HTTP error status (429 per-minute unless `daily`), `"network"` throws.
 */
export type GeminiReply =
  | string
  | number
  | "network"
  | { status: 429; daily: true }
  /** Any status with Google's error body as given (e.g. a 400 with a message). */
  | { status: number; error: Record<string, unknown> };

export class FakeGemini {
  readonly key = "fake-gemini-key-0000";
  replies: GeminiReply[] = [];
  readonly bodies: { body: Record<string, unknown>; url: string; headers: Headers }[] = [];

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    this.bodies.push({ body: JSON.parse(String(init?.body)), url, headers });
    if (headers.get("x-goog-api-key") !== this.key) {
      return json(400, { error: { code: 400, status: "INVALID_ARGUMENT" } });
    }
    const r = this.replies.shift();
    if (r === undefined) return json(500, { error: { code: 500, status: "INTERNAL" } });
    if (r === "network") throw new TypeError("fetch failed");
    if (typeof r === "object" && "error" in r) return json(r.status, { error: r.error });
    if (typeof r === "object") {
      return json(429, {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
            },
          ],
        },
      });
    }
    if (r === 429) {
      return json(429, {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }],
            },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" },
          ],
        },
      });
    }
    if (typeof r === "number") return json(r, { error: { code: r, status: "UNAVAILABLE" } });
    return json(200, {
      candidates: [{ content: { role: "model", parts: [{ text: r }] }, finishReason: "STOP" }],
    });
  };
}

/** A clock that only moves when the worker sleeps (or a chat call "takes" time). */
export class FakeClock {
  t = 1_800_000_000_000;
  slept: number[] = [];
  /** Called after each sleep, e.g. to stop the worker once the queue is drained. */
  afterSleep?: (ms: number) => void;
  now = () => this.t;
  sleep = async (ms: number, signal: AbortSignal) => {
    if (signal.aborted) return;
    this.slept.push(ms);
    this.t += ms;
    this.afterSleep?.(ms);
  };
}
