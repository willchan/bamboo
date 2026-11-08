import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentTiming,
  instrumentClient,
  serverTimingHeader,
  statusOfError,
  timed,
  timedRoute,
  timingSink,
  type TimingLine,
} from "./timing";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in libSQL client: each call takes `ms`. */
function fakeClient(ms = 2) {
  const calls: string[] = [];
  return {
    calls,
    execute: async (sql: string) => (calls.push(sql), await sleep(ms), { rows: [] }),
    batch: async (stmts: string[]) => (calls.push(...stmts), await sleep(ms), []),
  };
}

let lines: TimingLine[];
const original = timingSink.log;
beforeEach(() => {
  lines = [];
  timingSink.log = (l) => lines.push(l);
});
afterEach(() => {
  timingSink.log = original;
});

describe("instrumentClient", () => {
  it("counts calls, sequential round trips and db time inside a measured request", async () => {
    const c = instrumentClient(fakeClient());
    await timed("page /", async () => {
      await c.execute("a");
      await Promise.all([c.execute("b"), c.batch(["c", "d"])]);
      await c.execute("e");
      const t = currentTiming()!;
      expect(t.dbQueries).toBe(4);
      expect(t.dbSerial).toBe(3);
      expect(t.dbMs).toBeGreaterThan(0);
    });
    expect(c.calls).toEqual(["a", "b", "c", "d", "e"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: "timing",
      route: "page /",
      status: 200,
      db_queries: 4,
      db_serial: 3,
    });
    // Fixed fields only: nothing from the request or the data.
    expect(Object.keys(lines[0]!).sort()).toEqual(
      ["db_ms", "db_queries", "db_serial", "msg", "route", "status", "total_ms"].sort(),
    );
  });

  it("is a pass-through outside a request, and wraps a client once", async () => {
    const c = instrumentClient(instrumentClient(fakeClient()));
    await c.execute("x");
    expect(currentTiming()).toBeUndefined();
    await timed("action grade", async () => {
      await c.execute("y");
    });
    expect(lines[0]!.db_queries).toBe(1);
  });

  it("keeps concurrent requests apart", async () => {
    const c = instrumentClient(fakeClient());
    await Promise.all([
      timed("a", async () => {
        await c.execute("1");
        await c.execute("2");
      }),
      timed("b", () => c.execute("3")),
    ]);
    const byRoute = Object.fromEntries(lines.map((l) => [l.route, l.db_queries]));
    expect(byRoute).toEqual({ a: 2, b: 1 });
  });
});

describe("timed", () => {
  const nextError = (digest: string) => Object.assign(new Error(digest), { digest });

  it("logs redirects and not-found with their status, and rethrows", async () => {
    await expect(
      timed("action start", () => Promise.reject(nextError("NEXT_REDIRECT;push;/review/x;303;"))),
    ).rejects.toThrow();
    await expect(
      timed("page /review", () => Promise.reject(nextError("NEXT_HTTP_ERROR_FALLBACK;404"))),
    ).rejects.toThrow();
    await expect(timed("page /x", () => Promise.reject(new Error("boom")))).rejects.toThrow();
    expect(lines.map((l) => l.status)).toEqual([303, 404, 500]);
  });

  it("doesn't log Next's own render bailouts", async () => {
    await expect(
      timed("page /", () => Promise.reject(nextError("DYNAMIC_SERVER_USAGE"))),
    ).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it("maps statuses", () => {
    expect(statusOfError(nextError("NEXT_REDIRECT;replace;/;"))).toBe(307);
    expect(statusOfError(nextError("NEXT_HTTP_ERROR_FALLBACK;"))).toBe(404);
    expect(statusOfError(null)).toBe(500);
  });
});

describe("timedRoute", () => {
  it("adds Server-Timing and logs the response status", async () => {
    const c = instrumentClient(fakeClient());
    const handler = timedRoute("POST /api/jobs/claim", async () => {
      await c.execute("q");
      return Response.json({ ok: true }, { status: 201 });
    });
    const res = await handler();
    expect(res.status).toBe(201);
    expect(res.headers.get("Server-Timing")).toMatch(
      /^total;dur=[\d.]+, db;dur=[\d.]+;desc="1 queries"$/,
    );
    expect(lines[0]).toMatchObject({ route: "POST /api/jobs/claim", status: 201, db_queries: 1 });
  });

  it("copies a response whose headers are immutable", async () => {
    const res = await timedRoute("GET /r", async () =>
      Response.redirect("https://example.test/", 302),
    )();
    expect(res.status).toBe(302);
    expect(res.headers.get("Server-Timing")).toContain("db;dur=0");
  });

  it("logs a 500 when the handler throws", async () => {
    await expect(timedRoute("GET /x", () => Promise.reject(new Error("boom")))()).rejects.toThrow();
    expect(lines[0]!.status).toBe(500);
  });

  it("formats the header", () => {
    const t = { route: "r", startedAt: 0, dbMs: 3.14159, dbQueries: 2, dbSerial: 1, inFlight: 0 };
    expect(serverTimingHeader(t, 12.345)).toBe('total;dur=12.3, db;dur=3.1;desc="2 queries"');
  });
});
