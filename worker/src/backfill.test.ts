// H7's backfill command: arguments, the agent token, counts and the estimate. Fake tokens only.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentClient,
  estimate,
  parseBackfillArgs,
  readAgentToken,
  reextractBody,
  workerSums,
} from "./backfill";
import { ConfigError } from "./config";
import type { JobReport } from "./worker";

describe("parseBackfillArgs", () => {
  it("takes one mode and requires the paid key", () => {
    expect(parseBackfillArgs(["--", "--gemini-key=paid", "--limit", "10"])).toEqual({
      mode: { kind: "limit", limit: 10 },
      key: "paid",
    });
    expect(parseBackfillArgs(["--limit=3", "--gemini-key", "paid"]).mode).toEqual({
      kind: "limit",
      limit: 3,
    });
    expect(parseBackfillArgs(["--all", "--gemini-key=paid"]).mode).toEqual({ kind: "all" });
    expect(parseBackfillArgs(["--count", "--gemini-key=paid"]).mode).toEqual({ kind: "count" });
  });

  it.each([
    [["--limit", "10"]],
    [["--limit", "10", "--gemini-key=free"]],
    [["--gemini-key=paid"]],
    [["--all", "--count", "--gemini-key=paid"]],
    [["--limit", "0", "--gemini-key=paid"]],
    [["--limit", "x", "--gemini-key=paid"]],
    [["--limit", "1001", "--gemini-key=paid"]],
    [["--all", "--nope", "--gemini-key=paid"]],
  ])("refuses %j", (argv) => {
    expect(() => parseBackfillArgs(argv)).toThrow(ConfigError);
  });

  it("maps modes to the re-run request", () => {
    expect(reextractBody({ kind: "count" })).toBeNull();
    expect(reextractBody({ kind: "all" })).toEqual({ all: true });
    expect(reextractBody({ kind: "limit", limit: 10 })).toEqual({ all: true, limit: 10 });
  });
});

describe("readAgentToken", () => {
  const file = (text: string) => {
    const p = join(mkdtempSync(join(tmpdir(), "bamboo-backfill-")), "agent.env");
    writeFileSync(p, text, { mode: 0o600 });
    return p;
  };
  it("reads the environment first, then agent.env", () => {
    const p = file("BAMBOO_AGENT_API_TOKEN=fake-file-token\n");
    expect(readAgentToken({ BAMBOO_AGENT_API_TOKEN: "fake-env-token" }, p)).toBe("fake-env-token");
    expect(readAgentToken({}, p)).toBe("fake-file-token");
  });
  it("is a config error when missing, naming the variable only", () => {
    expect(() => readAgentToken({}, file("OTHER=1\n"))).toThrow(/BAMBOO_AGENT_API_TOKEN/u);
    expect(() => readAgentToken({}, "/nonexistent/agent.env")).toThrow(ConfigError);
  });
});

describe("AgentClient", () => {
  it("calls the agent routes with the agent token and parses the answers", async () => {
    const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    const report = {
      since: 5,
      newest_prompt: "extract_turn.v4",
      turns: {
        stored: 3,
        on_newest_prompt: 1,
        reread_on_newest_prompt: 1,
        remaining: 2,
        no_finished_job: 0,
        latest_on_fallback: 0,
        open_reextract: 0,
        reply_at_cap: 1,
        reply_max_chars: 12000,
      },
      run: {
        turns: 1,
        failed: 0,
        items_per_turn: [2],
        items: 2,
        kept: 1,
        sentence_promoted: 0,
        dropped: { dropped_over_cap: 1 },
        phrases_created: 1,
        phrases_refreshed: 0,
        phrases_dropped: 0,
        phrases_reported: 0,
        pinyin_jobs_queued: 0,
        pinyin_misaligned: 0,
        pinyin_disagreements: 0,
        pinyin_jobs_done: 0,
        pinyin_jobs_failed: 0,
        referee_calls: 0,
        models: { "gemini-test": 1 },
      },
      phrases_reported_open: 0,
      review: { review_log_rows: 4, reviewed_cards: 2 },
    };
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const url = new URL(String(input));
      const out = url.pathname === "/api/agent/backfill" ? report : { queued: 2, open: 2 };
      return new Response(JSON.stringify(out), { status: 200 });
    };
    const a = new AgentClient("https://bamboo.test", "fake-agent", fetchFn);
    expect(await a.report(5)).toEqual(report);
    expect(await a.reextract({ all: true, limit: 10 })).toEqual({ queued: 2, open: 2 });
    expect(calls).toEqual([
      {
        url: "https://bamboo.test/api/agent/backfill?since=5",
        method: "GET",
        auth: "Bearer fake-agent",
        body: undefined,
      },
      {
        url: "https://bamboo.test/api/agent/reextract",
        method: "POST",
        auth: "Bearer fake-agent",
        body: { all: true, limit: 10 },
      },
    ]);
  });

  it("throws on an HTTP error, with the status only", async () => {
    const a = new AgentClient(
      "https://bamboo.test",
      "fake-agent",
      async () => new Response("nope", { status: 401 }),
    );
    await expect(a.report()).rejects.toThrow("/api/agent/backfill?since=0: HTTP 401");
  });
});

const rep = (o: Partial<JobReport>): JobReport => ({
  jobId: "j",
  type: "extract_turn",
  attempt: 1,
  status: "done",
  model: "gemini-test",
  promptVersion: "extract_turn.v4",
  items: 3,
  repaired: false,
  droppedName: 0,
  latencyMs: 1000,
  outcome: "ok",
  ...o,
});

describe("workerSums and estimate", () => {
  const reports = [
    rep({}),
    rep({ model: "qwen3.8:27b" }),
    rep({ status: "failed" }),
    rep({ type: "pinyin", promptVersion: "pinyin_reading.v1+pinyin_referee.v1" }),
    rep({ type: "pinyin", promptVersion: "pinyin_reading.v1" }),
    rep({ type: "pinyin", status: "failed", promptVersion: null }),
  ];

  it("sums this process's jobs", () => {
    expect(workerSums(reports, "gemini-test", 6, 90_000)).toEqual({
      reruns_done: 2,
      reruns_failed: 1,
      reruns_on_ollama: 1,
      pinyin_done: 2,
      pinyin_failed: 1,
      referee_calls: 1,
      gemini_requests: 6,
      minutes: 1.5,
    });
  });

  it("estimates the full run from this run's rates and the paid limits", () => {
    const sums = workerSums(reports, "gemini-test", 6, 90_000);
    // 3 requests/turn × 100 turns; pace 0.75 min/turn → 75 min beats 300/60 = 5 min.
    expect(estimate(sums, 100, { requestsPerMinute: 60, requestsPerDay: 2000 })).toEqual({
      remaining_turns: 100,
      requests_per_turn: 3,
      requests: 300,
      minutes: 75,
      days: 1,
    });
    // A tight per-minute limit sets the pace; a small per-day one takes days.
    expect(estimate(sums, 100, { requestsPerMinute: 2, requestsPerDay: 100 })).toMatchObject({
      minutes: 150,
      days: 3,
    });
  });

  it("is unknown when no turn was read", () => {
    expect(
      estimate(workerSums([], "gemini-test", 0, 0), 137, {
        requestsPerMinute: 60,
        requestsPerDay: 2000,
      }),
    ).toEqual({
      remaining_turns: 137,
      requests_per_turn: null,
      requests: null,
      minutes: null,
      days: null,
    });
  });
});
