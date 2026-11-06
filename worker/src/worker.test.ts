import { sharedConfig } from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { EngineClient } from "./api";
import { OllamaClient } from "./ollama";
import { loadPrompt } from "./prompt";
import { FakeClock, FakeEngine, FakeOllama, fixtureTurns, ollamaFixtures as F } from "./test-fakes";
import { Worker, abortableSleep } from "./worker";

const VALID = F.chat_valid.message.content;
const INVALID = F.chat_invalid_english_too_long.message.content;
const POLL = 15_000;
const W = sharedConfig.worker;

/** A worker on the fakes. It stops by itself after `idlePolls` empty polls in a row. */
function setup(opts: { idlePolls?: number } = {}) {
  const engine = new FakeEngine();
  const ollama = new FakeOllama();
  const clock = new FakeClock();
  const lines: string[] = [];
  const worker = new Worker({
    engine: new EngineClient("https://bamboo.test", engine.token, engine.fetch),
    ollama: new OllamaClient("http://ollama.test", "qwen3.5:9b", ollama.fetch),
    prompt: loadPrompt(),
    model: "qwen3.5:9b",
    pollIntervalMs: POLL,
    version: "0.1.0",
    sha: "abc123",
    log: (l) => lines.push(l),
    now: clock.now,
    sleep: clock.sleep,
  });
  let idle = 0;
  const idlePolls = opts.idlePolls ?? 1;
  clock.afterSleep = (ms) => {
    idle = ms === POLL ? idle + 1 : 0;
    if (idle >= idlePolls) worker.stop();
  };
  return { engine, ollama, clock, worker, lines };
}

describe("claim loop (fake engine with M3's rules)", () => {
  it("heartbeats at startup, works the queue in order, echoes attempt/model/prompt_version", async () => {
    const { engine, ollama, worker, clock } = setup();
    engine.add(fixtureTurns[0]!);
    engine.add(fixtureTurns[1]!);
    ollama.replies = [VALID, INVALID, VALID];
    await worker.run();

    expect(engine.heartbeats).toEqual([
      { version: "0.1.0", sha: "abc123", model: "qwen3.5:9b", ollama_ok: true },
    ]);
    expect(engine.calls[0]).toBe("/api/worker/heartbeat");
    expect(engine.completes.map((c) => [c.job_id, c.attempt, c.status, c.repaired])).toEqual([
      ["job-1", 1, "done", false],
      ["job-2", 1, "done", true],
    ]);
    for (const c of engine.completes) {
      expect(c).toMatchObject({ model: "qwen3.5:9b", prompt_version: "extract_turn.v1" });
      expect(c.latency_ms).toBeGreaterThanOrEqual(0);
    }
    expect(engine.jobs.map((j) => j.status)).toEqual(["done", "done"]);
    // No sleep between jobs; one poll interval once the queue was empty.
    expect(clock.slept).toEqual([POLL]);
    expect(worker.reports.map((r) => r.jobStatus)).toEqual(["done", "done"]);
  });

  it("reports an attempt that fails twice as failed; the engine requeues it until attempt 3", async () => {
    const { engine, ollama, worker } = setup();
    engine.add(fixtureTurns[0]!);
    ollama.replies = Array(6).fill(INVALID);
    await worker.run();
    expect(engine.completes.map((c) => [c.attempt, c.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "failed"],
    ]);
    expect(engine.completes[0]).toMatchObject({ repaired: true });
    expect(engine.completes[0]!.status === "failed" && engine.completes[0]!.error).toMatch(
      /invalid output after the repair turn/u,
    );
    expect(worker.reports.map((r) => r.jobStatus)).toEqual(["queued", "queued", "failed"]);
    expect(engine.jobs[0]!.status).toBe("failed");
  });

  it("drops a job on 409 stale_attempt and claims the next", async () => {
    const { engine, ollama, worker, lines } = setup();
    engine.add(fixtureTurns[0]!);
    engine.add(fixtureTurns[1]!);
    ollama.replies = [VALID, VALID];
    engine.onClaim = (job) => {
      if (job.job_id === "job-1") engine.expireAndReclaim("job-1");
    };
    await worker.run();
    expect(worker.reports.map((r) => [r.jobId, r.outcome])).toEqual([
      ["job-1", "stale"],
      ["job-2", "ok"],
    ]);
    expect(lines.some((l) => l.includes("job-1") && l.includes("stale attempt, dropped"))).toBe(
      true,
    );
  });

  it("logs a 422 invalid_result and moves on (the engine counted the attempt)", async () => {
    const { engine, ollama, worker, lines } = setup();
    engine.add(fixtureTurns[0]!);
    ollama.replies = [VALID, VALID];
    // The shared contract makes this rare (e.g. an engine with a newer contract), so the fake
    // engine refuses the first result on purpose.
    engine.refuseResults = 1;
    await worker.run();
    expect(worker.reports.map((r) => [r.attempt, r.outcome, r.jobStatus])).toEqual([
      [1, "invalid_result", undefined],
      [2, "ok", "done"],
    ]);
    expect(lines.some((l) => l.includes("engine refused the result"))).toBe(true);
  });

  it("retries complete on network errors, then reports", async () => {
    const { engine, ollama, worker, clock } = setup();
    engine.add(fixtureTurns[0]!);
    ollama.replies = [VALID];
    engine.networkFailCompletes = 2;
    await worker.run();
    expect(worker.reports[0]).toMatchObject({ outcome: "ok", jobStatus: "done" });
    expect(clock.slept.slice(0, 2)).toEqual([
      W.completeRetrySeconds[0] * 1000,
      W.completeRetrySeconds[1] * 1000,
    ]);
  });

  it("doesn't claim while the model isn't pulled; heartbeat says ollama_ok false", async () => {
    const { engine, ollama, worker, clock, lines } = setup();
    ollama.pulled = ["qwen3.5:4b"];
    engine.add(fixtureTurns[0]!);
    ollama.replies = [VALID];
    let rechecks = 0;
    clock.afterSleep = (ms) => {
      if (ms === W.modelRecheckSeconds * 1000 && ++rechecks === 3) ollama.pulled.push("qwen3.5:9b");
      if (ms === POLL) worker.stop();
    };
    await worker.run();
    expect(engine.heartbeats[0]!.ollama_ok).toBe(false);
    // The three re-checks happened before the first claim.
    const firstClaim = engine.calls.indexOf("/api/jobs/claim");
    expect(firstClaim).toBe(1);
    expect(rechecks).toBe(3);
    expect(engine.jobs[0]!.status).toBe("done");
    // The problem is logged once, not on every re-check.
    expect(lines.filter((l) => l.startsWith("not claiming")).length).toBe(1);
    expect(lines.some((l) => l.startsWith("ollama ok"))).toBe(true);
  });

  it("stops claiming after Ollama goes down mid-job", async () => {
    const { engine, ollama, worker, clock } = setup();
    engine.add(fixtureTurns[0]!);
    engine.add(fixtureTurns[1]!);
    engine.onClaim = () => {
      ollama.down = true;
    };
    clock.afterSleep = () => worker.stop();
    await worker.run();
    expect(engine.completes).toHaveLength(1);
    expect(engine.completes[0]).toMatchObject({ status: "failed" });
    expect(engine.jobs[1]!.status).toBe("queued");
    expect(clock.slept).toEqual([W.modelRecheckSeconds * 1000]);
  });

  it("backs off on claim errors, doubling up to the cap", async () => {
    const { engine, worker, clock } = setup();
    engine.serverErrorClaims = 3;
    clock.afterSleep = () => {
      if (clock.slept.length === 4) worker.stop();
    };
    await worker.run();
    expect(clock.slept).toEqual([POLL, POLL * 2, POLL * 4, POLL]);
  });

  it("heartbeats every 10 minutes while idle", async () => {
    const perBeat = (W.heartbeatMinutes * 60_000) / POLL;
    const { engine, worker } = setup({ idlePolls: perBeat * 2 + 1 });
    await worker.run();
    expect(engine.heartbeats).toHaveLength(3);
  });

  it("SIGTERM (stop) mid-job: the job finishes and is reported, then the loop exits", async () => {
    const { engine, ollama, worker } = setup({ idlePolls: 99 });
    engine.add(fixtureTurns[0]!);
    engine.add(fixtureTurns[1]!);
    ollama.replies = [VALID, VALID];
    engine.onClaim = () => worker.stop();
    await worker.run();
    expect(engine.completes).toHaveLength(1);
    expect(engine.completes[0]).toMatchObject({ job_id: "job-1", status: "done" });
    expect(engine.calls.filter((c) => c === "/api/jobs/claim")).toHaveLength(1);
    expect(engine.jobs[1]!.status).toBe("queued");
  });
});

describe("abortableSleep", () => {
  it("resolves early on abort", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = abortableSleep(60_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
    await abortableSleep(60_000, ac.signal);
  });
});
