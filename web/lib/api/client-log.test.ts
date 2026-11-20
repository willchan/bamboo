// POST /api/client-log (DESIGN §8.5): signed-in only, fixed fields only, rate-limited.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/client-log/route";
import { config } from "../config";
import { clientLogSink, resetClientLogLimit } from "./client-log";

const user = vi.hoisted(() => ({ current: null as { email: string } | null }));
vi.mock("@/lib/auth/current", () => ({ getCurrentUser: () => Promise.resolve(user.current) }));

const entry = {
  where: "save",
  kind: "stale",
  name: "UnrecognizedActionError",
  build: "dpl_1",
  page: "/review",
  attempts: 1,
  online: true,
};
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/client-log", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

let lines: unknown[];
const original = clientLogSink.log;
beforeEach(() => {
  lines = [];
  clientLogSink.log = (l) => void lines.push(l);
  user.current = { email: "will@example.com" };
  resetClientLogLimit();
});
afterEach(() => {
  clientLogSink.log = original;
});

describe("POST /api/client-log", () => {
  it("logs one line of fixed fields", async () => {
    expect((await post(entry)).status).toBe(204);
    expect(lines).toEqual([{ msg: "client_error", ...entry }]);
  });

  it("refuses the signed-out, bad JSON and free text", async () => {
    user.current = null;
    expect((await post(entry)).status).toBe(401);
    user.current = { email: "will@example.com" };
    expect((await post("{")).status).toBe(400);
    expect((await post({ ...entry, message: "辅食" })).status).toBe(400);
    expect(lines).toEqual([]);
  });

  it("drops lines past the per-minute limit", async () => {
    for (let i = 0; i < config.client.logPerMinute; i++) await post(entry);
    expect((await post(entry)).status).toBe(429);
    expect(lines).toHaveLength(config.client.logPerMinute);
  });
});
