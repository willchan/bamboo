// The claim loop (DESIGN §5.3, §8.3): concurrency 1. Heartbeat at startup and every 10 min; claim
// only while the model is pulled; run the job; report it. The engine owns attempts and leases, so
// a job is never retried here beyond the extractor's one repair turn. `stop()` (SIGTERM) lets the
// current job finish and be reported, then `run()` returns.
import { sharedConfig, type ClaimedJob, type CompleteRequest } from "@bamboo/shared";
import type { CompleteOutcome, Engine } from "./api";
import type { Log } from "./log";
import { extractTurn, type ChatModel } from "./ollama";
import type { Prompt } from "./prompt";

const W = sharedConfig.worker;

export interface WorkerDeps {
  engine: Engine;
  ollama: ChatModel & { hasModel(): Promise<boolean> };
  prompt: Prompt;
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
  attempt: number;
  /** What the worker sent. */
  status: "done" | "failed";
  items: number;
  repaired: boolean;
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

  async run(): Promise<void> {
    const { log, model, pollIntervalMs } = this.d;
    log(`started: model ${model}, prompt ${this.d.prompt.version}, poll ${pollIntervalMs / 1000}s`);
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
      if (!this.modelOk) {
        await this.sleep(W.modelRecheckSeconds * 1000, this.stopper.signal);
        if (!this.stopping) await this.checkModel();
        continue;
      }

      const claim = await this.d.engine.claim();
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
    const { log, prompt, model } = this.d;
    const x = await extractTurn(this.d.ollama, prompt, job.input, this.now);
    const base = {
      job_id: job.job_id,
      attempt: job.attempt,
      model,
      prompt_version: prompt.version,
      latency_ms: x.latencyMs,
      repaired: x.repaired,
    };
    const body: CompleteRequest = x.ok
      ? { ...base, status: "done", result: x.result }
      : { ...base, status: "failed", error: x.error.slice(0, 2000) };
    if (!x.ok && x.ollamaDown) this.modelOk = false;

    const outcome = await this.completeWithRetry(body);
    const report: JobReport = {
      jobId: job.job_id,
      attempt: job.attempt,
      status: body.status,
      items: x.ok ? x.result.items.length : 0,
      repaired: x.repaired,
      latencyMs: x.latencyMs,
      outcome: outcome.kind,
      jobStatus: outcome.kind === "ok" ? outcome.jobStatus : undefined,
    };
    this.reports.push(report);

    const what = x.ok
      ? `done, ${report.items} item(s)${x.repaired ? ", repaired" : ""}`
      : `failed (${x.error.split("\n")[0]})`;
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
    log(
      `job ${job.job_id} attempt ${job.attempt}: ${what} in ${(x.latencyMs / 1000).toFixed(1)}s → ${engine}`,
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
    const r = await this.d.engine.heartbeat({
      version: this.d.version,
      sha: this.d.sha,
      model: this.d.model,
      ollama_ok: this.modelOk,
    });
    this.d.log(
      r.ok ? `heartbeat ok (ollama_ok=${this.modelOk})` : `heartbeat failed: ${r.message}`,
    );
  }
}
