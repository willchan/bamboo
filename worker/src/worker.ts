// The claim loop (DESIGN §5.3, §5.5.2, §8.3): concurrency 1. Heartbeat at startup and every 10
// min; claim only while something can run the job; run it; report it. The engine owns attempts
// and leases, so a job is never retried here beyond the model's one repair turn.
//
// Since H4, extraction runs on Gemini (rate-limited to the free tier) and falls back to Ollama
// when Gemini is unreachable or keeps failing; a used-up daily quota stops claims until the reset
// instead (no fallback for quota). `pinyin` jobs need Gemini and are only claimed while it's
// usable. Every result goes through the name filter before it's posted. `stop()` (SIGTERM) lets
// the current job finish and be reported, then `run()` returns.
import {
  sharedConfig,
  type ClaimedExtractJob,
  type ClaimedJob,
  type ClaimedPinyinJob,
  type CompleteRequest,
  type JobType,
} from "@bamboo/shared";
import type { CompleteOutcome, Engine } from "./api";
import { extractTurn, type ChatModel, type Extraction } from "./extract";
import { GeminiError } from "./gemini";
import type { Log } from "./log";
import { filterNames, type DenyList } from "./names";
import { runPinyinJob, type PinyinPrompts } from "./pinyin-job";
import type { Prompt } from "./prompt";

const W = sharedConfig.worker;

/** What the worker needs from Gemini (`GeminiClient`). */
export interface GeminiModel extends ChatModel {
  readonly model: string;
  /** When the daily quota resets, if it's used up now; else null. */
  quotaResetAt(): number | null;
}

export interface WorkerDeps {
  engine: Engine;
  ollama: ChatModel & { hasModel(): Promise<boolean> };
  /** Null when `BAMBOO_GEMINI_API_KEY_FREE` isn't set: Ollama only, no pinyin jobs. */
  gemini: GeminiModel | null;
  prompt: Prompt;
  pinyinPrompts: PinyinPrompts;
  deny: DenyList;
  /** The Ollama model. */
  model: string;
  pollIntervalMs: number;
  version: string;
  sha: string | null;
  log: Log;
  now?: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

export interface JobReport {
  jobId: string;
  type: JobType;
  attempt: number;
  /** What the worker sent. */
  status: "done" | "failed";
  /** The model that ran it (Gemini's, or Ollama's on fallback). */
  model: string;
  items: number;
  repaired: boolean;
  droppedName: number;
  latencyMs: number;
  /** What the engine said. */
  outcome: CompleteOutcome["kind"];
  jobStatus?: string;
}

export class Worker {
  private readonly stopper = new AbortController();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private modelOk = false;
  private lastProblem = "";
  /** Gemini rests until then after failing (it sends jobs to Ollama meanwhile). */
  private geminiDownUntil = 0;
  private lastGeminiState = "";
  /** Jobs finished by this process (for logs and tests). */
  readonly reports: JobReport[] = [];

  constructor(private readonly d: WorkerDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? abortableSleep;
  }

  get stopping(): boolean {
    return this.stopper.signal.aborted;
  }

  /** Finish the current job (if any), then return from `run()`. */
  stop(): void {
    if (!this.stopping) this.d.log("stopping: finishing the current job first");
    this.stopper.abort();
  }

  /** Gemini can take a request now: a key, not resting, quota left. */
  geminiOk(): boolean {
    const g = this.d.gemini;
    return !!g && this.now() >= this.geminiDownUntil && g.quotaResetAt() === null;
  }

  /** The job types this worker can run now (empty: claim nothing). */
  claimTypes(): JobType[] {
    const g = this.d.gemini;
    // A used-up quota waits for the reset: no Ollama for quota (DESIGN §5.5.2).
    if (g && g.quotaResetAt() !== null) return [];
    if (this.geminiOk()) return ["extract_turn", "pinyin"];
    return this.modelOk ? ["extract_turn"] : [];
  }

  private logGeminiState(): void {
    const g = this.d.gemini;
    let state: string;
    if (!g) state = "gemini off: BAMBOO_GEMINI_API_KEY_FREE is not set; extracting on ollama only";
    else {
      const reset = g.quotaResetAt();
      if (reset !== null)
        state = `gemini: daily quota used up; not claiming until ${new Date(reset).toISOString()}`;
      else if (this.now() < this.geminiDownUntil)
        state = `gemini resting until ${new Date(this.geminiDownUntil).toISOString()}; extracting on ollama`;
      else state = `gemini ok: ${g.model}`;
    }
    if (state !== this.lastGeminiState) this.d.log(state);
    this.lastGeminiState = state;
  }

  async run(): Promise<void> {
    const { log, model, pollIntervalMs } = this.d;
    log(
      `started: gemini ${this.d.gemini?.model ?? "off"}, fallback ${model}, prompt ${this.d.prompt.version}, poll ${pollIntervalMs / 1000}s`,
    );
    if (this.d.deny.loaded) {
      log(`name filter: ${this.d.deny.count} name(s) from ${this.d.deny.path}`);
      if (this.d.deny.tooOpen)
        log(`warning: ${this.d.deny.path} is readable by others; run chmod 600 on it`);
    } else {
      log(`warning: no name deny-list at ${this.d.deny.path}; names are not filtered`);
    }
    await this.checkModel();
    await this.heartbeat();
    let nextHeartbeat = this.now() + W.heartbeatMinutes * 60_000;
    let backoff = pollIntervalMs;

    while (!this.stopping) {
      if (this.now() >= nextHeartbeat) {
        await this.checkModel();
        await this.heartbeat();
        nextHeartbeat = this.now() + W.heartbeatMinutes * 60_000;
      }
      this.logGeminiState();
      const types = this.claimTypes();
      if (types.length === 0) {
        await this.sleep(W.modelRecheckSeconds * 1000, this.stopper.signal);
        if (!this.stopping) await this.checkModel();
        continue;
      }

      const claim = await this.d.engine.claim(types);
      if (claim.kind === "error") {
        log(`claim failed: ${claim.message}; retrying in ${Math.round(backoff / 1000)}s`);
        await this.sleep(backoff, this.stopper.signal);
        backoff = Math.min(backoff * 2, W.maxBackoffSeconds * 1000);
        continue;
      }
      backoff = pollIntervalMs;
      if (claim.kind === "empty") {
        await this.sleep(pollIntervalMs, this.stopper.signal);
        continue;
      }
      // Not interrupted by stop(): the job is finished and reported first.
      await this.process(claim.job);
    }
    log("stopped");
  }

  /** Run one claimed job and report it. Public for tests. */
  async process(job: ClaimedJob): Promise<JobReport> {
    return job.type === "pinyin" ? this.processPinyin(job) : this.processExtract(job);
  }

  /** Gemini failed in a way that isn't quota: rest it, so jobs go to Ollama for a while. */
  private restGemini(why: string): void {
    this.geminiDownUntil = this.now() + W.gemini.downMinutes * 60_000;
    this.d.log(`${why}; gemini rests ${W.gemini.downMinutes} min`);
  }

  private async processExtract(job: ClaimedExtractJob): Promise<JobReport> {
    const { prompt, gemini } = this.d;
    let x: Extraction | null = null;
    let model = this.d.model;
    let latency = 0;
    let quota: string | null = null;

    if (gemini && this.geminiOk()) {
      const g = await extractTurn(gemini, prompt, job.input, this.now, {
        maxReplyChars: Infinity,
        keepPinyin: true,
      });
      latency += g.latencyMs;
      if (g.ok) {
        x = g;
        model = gemini.model;
      } else if (g.modelError instanceof GeminiError && g.modelError.kind === "quota") {
        quota = g.error;
        model = gemini.model;
      } else {
        const why = g.modelError ? g.error : "gemini: invalid output after the repair turn";
        if (g.modelError) this.restGemini(why);
        this.d.log(`job ${job.job_id}: ${why.split("\n")[0]}; falling back to ollama`);
      }
    }
    if (!x && quota === null) {
      if (this.modelOk) {
        x = await extractTurn(this.d.ollama, prompt, job.input, this.now, { keepPinyin: false });
        latency += x.latencyMs;
        if (!x.ok && x.modelError) this.modelOk = false;
      } else {
        x = {
          ok: false,
          error: "no model available (gemini failed, ollama down)",
          repaired: false,
          latencyMs: 0,
        };
      }
    }
    const extraction: Extraction = x ?? {
      ok: false,
      error: quota ?? "gemini: daily quota used up",
      repaired: false,
      latencyMs: latency,
    };

    let droppedName = 0;
    const base = {
      job_id: job.job_id,
      attempt: job.attempt,
      model,
      prompt_version: prompt.version,
      latency_ms: latency,
      repaired: extraction.repaired,
    };
    let body: CompleteRequest;
    if (extraction.ok) {
      const f = filterNames(extraction.result, this.d.deny);
      droppedName = f.dropped;
      body = { ...base, status: "done", result: f.result, dropped_name: droppedName };
    } else {
      body = { ...base, status: "failed", error: extraction.error.slice(0, 2000) };
    }
    const items = body.status === "done" ? (body.result as { items: unknown[] }).items.length : 0;
    return this.report(job, body, {
      items,
      droppedName,
      latency,
      what: extraction.ok ? null : extraction.error,
    });
  }

  private async processPinyin(job: ClaimedPinyinJob): Promise<JobReport> {
    const gemini = this.d.gemini;
    const base = { job_id: job.job_id, attempt: job.attempt, model: gemini?.model ?? null };
    let body: CompleteRequest;
    let latency = 0;
    if (!gemini || !this.geminiOk()) {
      body = { ...base, status: "failed", error: "gemini unavailable" };
    } else {
      const r = await runPinyinJob(gemini, this.d.pinyinPrompts, job.input, this.now);
      latency = r.latencyMs;
      if (r.ok) {
        body = {
          ...base,
          status: "done",
          prompt_version: r.promptVersion,
          latency_ms: latency,
          repaired: r.repaired,
          result: r.result,
        };
      } else {
        if (r.modelError instanceof GeminiError && r.modelError.kind !== "quota")
          this.restGemini(r.error);
        body = { ...base, status: "failed", latency_ms: latency, error: r.error.slice(0, 2000) };
      }
    }
    return this.report(job, body, {
      items: 0,
      droppedName: 0,
      latency,
      what: body.status === "failed" ? body.error : null,
    });
  }

  private async report(
    job: ClaimedJob,
    body: CompleteRequest,
    x: { items: number; droppedName: number; latency: number; what: string | null },
  ): Promise<JobReport> {
    const outcome = await this.completeWithRetry(body);
    const report: JobReport = {
      jobId: job.job_id,
      type: job.type,
      attempt: job.attempt,
      status: body.status,
      model: body.model ?? "none",
      items: x.items,
      repaired: !!body.repaired,
      droppedName: x.droppedName,
      latencyMs: x.latency,
      outcome: outcome.kind,
      jobStatus: outcome.kind === "ok" ? outcome.jobStatus : undefined,
    };
    this.reports.push(report);

    const what =
      x.what === null
        ? job.type === "pinyin"
          ? `done (${body.prompt_version})`
          : `done, ${report.items} item(s)${report.repaired ? ", repaired" : ""}${x.droppedName ? `, ${x.droppedName} name match(es) dropped` : ""}`
        : `failed (${x.what.split("\n")[0]})`;
    const engine =
      outcome.kind === "ok"
        ? `job ${outcome.jobStatus}`
        : outcome.kind === "stale"
          ? "stale attempt, dropped"
          : outcome.kind === "invalid_result"
            ? `engine refused the result (${outcome.message})`
            : outcome.kind === "not_found"
              ? "job not found, dropped"
              : `not reported (${outcome.message}); the lease will expire`;
    this.d.log(
      `${job.type} ${job.job_id} attempt ${job.attempt} on ${report.model}: ${what} in ${(x.latency / 1000).toFixed(1)}s → ${engine}`,
    );
    return report;
  }

  /** `complete`, retried on network/5xx errors only (409/422/404 are answers, not errors). */
  private async completeWithRetry(body: CompleteRequest): Promise<CompleteOutcome> {
    let outcome = await this.d.engine.complete(body);
    for (const s of W.completeRetrySeconds) {
      if (outcome.kind !== "error") break;
      this.d.log(`complete ${body.job_id} failed: ${outcome.message}; retrying in ${s}s`);
      // A plain timer: stop() must not cut the retries short (the result would be lost).
      await this.sleep(s * 1000, new AbortController().signal);
      outcome = await this.d.engine.complete(body);
    }
    return outcome;
  }

  private async checkModel(): Promise<void> {
    const was = this.modelOk;
    let reason = "";
    try {
      this.modelOk = await this.d.ollama.hasModel();
      if (!this.modelOk)
        reason = `model ${this.d.model} is not pulled (ollama pull ${this.d.model})`;
    } catch (e) {
      this.modelOk = false;
      reason = `ollama unreachable: ${(e as Error).message}`;
    }
    if (this.modelOk && !was) this.d.log(`ollama ok: ${this.d.model} is pulled`);
    // Log a problem when it starts or changes, not on every re-check.
    if (!this.modelOk && reason !== this.lastProblem) this.d.log(`not claiming: ${reason}`);
    this.lastProblem = reason;
  }

  private async heartbeat(): Promise<void> {
    const geminiOk = this.geminiOk();
    const r = await this.d.engine.heartbeat({
      version: this.d.version,
      sha: this.d.sha,
      model: this.d.model,
      ollama_ok: this.modelOk,
      gemini_model: this.d.gemini?.model ?? null,
      gemini_ok: geminiOk,
    });
    this.d.log(
      r.ok
        ? `heartbeat ok (gemini_ok=${geminiOk}, ollama_ok=${this.modelOk})`
        : `heartbeat failed: ${r.message}`,
    );
  }
}
