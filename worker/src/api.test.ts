import { describe, expect, it } from "vitest";
import { EngineClient } from "./api";
import { FakeEngine, fixtureTurns } from "./test-fakes";

const URL_ = "https://bamboo.test";

function fixed(status: number, body?: unknown): typeof fetch {
  return async () =>
    body === undefined
      ? new Response(null, { status })
      : new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

const done = { job_id: "j", attempt: 1, status: "done" as const, result: {} };

describe("EngineClient", () => {
  it("claims with the bearer token: 200 → job, 204 → empty", async () => {
    const engine = new FakeEngine();
    engine.add(fixtureTurns[0]!);
    const c = new EngineClient(URL_, engine.token, engine.fetch);
    const first = await c.claim();
    expect(first.kind).toBe("job");
    expect(first.kind === "job" && first.job.attempt).toBe(1);
    expect((await c.claim()).kind).toBe("empty");
    const wrong = new EngineClient(URL_, "agent-token", engine.fetch);
    expect(await wrong.claim()).toEqual({ kind: "error", message: "HTTP 401 unauthorized" });
  });

  it("treats a malformed claim or a network error as an error", async () => {
    expect((await new EngineClient(URL_, "t", fixed(200, { job_id: 1 })).claim()).kind).toBe(
      "error",
    );
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await new EngineClient(URL_, "t", down).claim()).toEqual({
      kind: "error",
      message: "fetch failed",
    });
  });

  it("maps complete's answers: 200, 409 stale_attempt, 422, 404, 5xx", async () => {
    const c = (f: typeof fetch) => new EngineClient(URL_, "t", f).complete(done);
    expect(await c(fixed(200, { job_status: "done" }))).toEqual({ kind: "ok", jobStatus: "done" });
    expect(await c(fixed(409, { error: "stale_attempt" }))).toEqual({ kind: "stale" });
    expect(await c(fixed(422, { error: "invalid_result", message: "job is now queued" }))).toEqual({
      kind: "invalid_result",
      message: "invalid_result: job is now queued",
    });
    expect(await c(fixed(404, { error: "not_found" }))).toEqual({ kind: "not_found" });
    expect(await c(fixed(502, "<html>bad gateway</html>"))).toEqual({
      kind: "error",
      message: "HTTP 502 <html>bad gateway</html>",
    });
    // A 409 that isn't stale_attempt is an error worth retrying, not a dropped job.
    expect((await c(fixed(409, { error: "conflict" }))).kind).toBe("error");
    expect((await c(fixed(200, { nope: 1 }))).kind).toBe("error");
  });

  it("heartbeat: 204 is ok, anything else is reported", async () => {
    const engine = new FakeEngine();
    const hb = { version: "0.1.0", sha: "abc", model: "qwen3.5:9b", ollama_ok: true };
    expect(await new EngineClient(URL_, engine.token, engine.fetch).heartbeat(hb)).toEqual({
      ok: true,
    });
    expect(engine.heartbeats).toEqual([hb]);
    expect(
      await new EngineClient(URL_, "t", fixed(503, { error: "not_configured" })).heartbeat(hb),
    ).toEqual({ ok: false, message: "HTTP 503 not_configured" });
  });
});
