// `replies` / `nudge` error handling under OpenClaw command automations (DESIGN §5.1
// *Automation errors*). Fakes only: a fake engine and a fake clock.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedConfig, type Notification } from "@bamboo/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiCallError } from "./api";
import { AUTOMATION_MESSAGES, isTransient, logPath, statePath } from "./automation";
import { NO_REPLY, run, type Deps } from "./cli";
import { FakeEngine } from "./fake-engine.test-util";

const cfg = sharedConfig.tools.automation;
const T0 = Date.parse("2026-01-05T10:50:00Z");
const MIN = 60_000;

let engine: FakeEngine;
let home: string;
let now: number;
/** When set, every request fails this way before reaching the engine. */
let down: (() => Promise<Response>) | null;

function deps(extraEnv: Record<string, string> = {}): Deps {
  return {
    env: {
      HOME: home,
      TZ: "UTC",
      BAMBOO_API_URL: "https://bamboo.test",
      BAMBOO_AGENT_API_TOKEN: engine.token,
      ...extraEnv,
    },
    readShare: async () => ({ title: null, turns: [] }),
    readPdf: async () => ({ title: null, turns: [] }),
    readText: () => "",
    fetch: (async (input: string | URL | Request, init?: RequestInit) =>
      down ? down() : engine.fetch(input, init)) as typeof fetch,
    retryDelayMs: 0,
    now: () => new Date(now),
  };
}

const fetchFailed = async (): Promise<Response> => {
  throw new TypeError("fetch failed");
};

/** Run `cmd` at `T0 + minutes`. */
const at = (minutes: number, cmd = "replies", d = deps()) => {
  now = T0 + minutes * MIN;
  return run([cmd], d);
};

beforeEach(() => {
  engine = new FakeEngine();
  home = mkdtempSync(join(tmpdir(), "bamboo-automation-"));
  mkdirSync(join(home, ".config", "bamboo"), { recursive: true });
  down = null;
  now = T0;
});

const quiet = { code: 0, out: NO_REPLY };

describe("transient errors", () => {
  it("post nothing, never write stderr, and go to the local log", async () => {
    down = fetchFailed;
    const r = await at(0);
    expect(r).toEqual(quiet);
    const log = readFileSync(logPath(deps().env), "utf8");
    expect(log).toContain("replies transient");
    expect(log).toContain("GET /api/agent/notifications: fetch failed");
  });

  it.each([
    ["500", 500],
    ["502", 502],
    ["503", 503],
    ["429", 429],
  ])("an engine %s is transient", async (_, status) => {
    engine.failNext = { status, error: "busy", count: 99 };
    expect(await at(0, "nudge")).toEqual(quiet);
  });

  it("alerts once after the threshold, then stays quiet, then says it's back", async () => {
    down = fetchFailed;
    for (let m = 0; m < cfg.outageAlertMinutes; m += 5) expect(await at(m)).toEqual(quiet);
    const alert = await at(cfg.outageAlertMinutes);
    expect(alert).toEqual({ code: 0, out: AUTOMATION_MESSAGES.outage("10:50") });
    expect(alert.out).toBe(
      "⚠️ Bamboo can't reach its server from the Mac (since 10:50). I'll keep trying.",
    );
    // Hours more of failures, from either command: nothing more.
    for (let m = cfg.outageAlertMinutes + 5; m < 240; m += 5) expect(await at(m)).toEqual(quiet);
    expect(await at(242, "nudge")).toEqual(quiet);

    down = null;
    expect(await at(245)).toEqual({ code: 0, out: AUTOMATION_MESSAGES.recovered });
    expect(await at(250)).toEqual(quiet);
    expect(JSON.parse(readFileSync(statePath(deps().env), "utf8")).outage).toBeNull();
  });

  it("a blip that clears before the threshold never posts, not even a recovery", async () => {
    down = fetchFailed;
    expect(await at(0)).toEqual(quiet);
    expect(await at(5)).toEqual(quiet);
    down = null;
    expect(await at(10)).toEqual(quiet);
    // A later blip starts a fresh outage clock.
    down = fetchFailed;
    expect(await at(20)).toEqual(quiet);
    expect(await at(20 + cfg.outageAlertMinutes - 5)).toEqual(quiet);
  });

  it("a long gap with no runs (the Mac was off) starts a new outage", async () => {
    down = fetchFailed;
    expect(await at(0)).toEqual(quiet);
    expect(await at(cfg.outageResetMinutes + 10)).toEqual(quiet);
  });

  it("the recovery line follows a real reply", async () => {
    down = fetchFailed;
    await at(0);
    expect((await at(cfg.outageAlertMinutes)).out).toContain("can't reach");
    down = null;
    const note: Notification = {
      import_id: "i1",
      kind: "link",
      discord_channel_id: "1",
      discord_message_id: "900",
      summary: "✅ 1 new question → 2 phrases queued.",
    };
    engine.notifications = [note];
    expect((await at(60)).out).toBe(
      `[[reply_to:900]] ${note.summary}\n\n${AUTOMATION_MESSAGES.recovered}`,
    );
  });

  it("an unreadable state file is treated as empty", async () => {
    writeFileSync(statePath(deps().env), "{not json");
    down = fetchFailed;
    expect(await at(0)).toEqual(quiet);
  });
});

describe("non-transient errors", () => {
  it("a 401 is reported once (stdout, exit 1), then quiet while it repeats", async () => {
    const d = deps({ BAMBOO_AGENT_API_TOKEN: "wrong" });
    const first = await at(0, "replies", d);
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/^⚠️ bamboo-tools replies: GET \/api\/agent\/notifications: 401/u);
    expect(first).not.toHaveProperty("err");
    expect(await at(5, "replies", d)).toEqual(quiet);
    expect(await at(500, "replies", d)).toEqual(quiet);
    // Each command reports its own.
    expect((await at(505, "nudge", d)).code).toBe(1);
  });

  it("a different error is reported again", async () => {
    engine.nudgeStatus = 404;
    expect((await at(0, "nudge")).code).toBe(1);
    expect(await at(5, "nudge")).toEqual(quiet);
    engine.nudgeStatus = 403;
    const r = await at(10, "nudge");
    expect(r.code).toBe(1);
    expect(r.out).toContain("403");
  });

  it("success clears it, so the same error later is reported again", async () => {
    const bad = deps({ BAMBOO_AGENT_API_TOKEN: "wrong" });
    expect((await at(0, "replies", bad)).code).toBe(1);
    expect(await at(5)).toEqual(quiet);
    expect((await at(10, "replies", bad)).code).toBe(1);
  });

  it("a response that breaks the contract is reported, not hidden", async () => {
    const d = deps();
    d.fetch = (async () =>
      new Response(JSON.stringify({ text: 42 }), { status: 200 })) as typeof fetch;
    const r = await at(0, "nudge", d);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bamboo-tools nudge:");
  });

  it("missing settings are reported once", async () => {
    const d = deps({ BAMBOO_API_URL: "" });
    const r = await at(0, "nudge", d);
    expect(r.code).toBe(1);
    expect(r.out).toContain("BAMBOO_API_URL is not set");
    expect(await at(5, "nudge", d)).toEqual(quiet);
  });
});

describe("isTransient", () => {
  it("classifies engine and network errors", () => {
    expect(isTransient(new ApiCallError(0, "network", "x"))).toBe(true);
    expect(isTransient(new ApiCallError(503, "http_503", "x"))).toBe(true);
    expect(isTransient(new ApiCallError(429, "rate_limited", "x"))).toBe(true);
    expect(isTransient(new ApiCallError(401, "unauthorized", "x"))).toBe(false);
    expect(isTransient(new ApiCallError(403, "forbidden", "x"))).toBe(false);
    expect(isTransient(new ApiCallError(404, "not_found", "x"))).toBe(false);
    expect(isTransient(new TypeError("terminated"))).toBe(true);
    expect(isTransient(Object.assign(new Error("read"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransient(new Error("x", { cause: { code: "ETIMEDOUT" } }))).toBe(true);
    expect(isTransient(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isTransient(new Error("Unexpected token"))).toBe(false);
    expect(isTransient("nope")).toBe(false);
  });
});
