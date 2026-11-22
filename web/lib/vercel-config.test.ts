// web/vercel.json (DESIGN §8.2): the daily job is a Vercel Schedule, not a legacy Cron Job.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MACHINE_ROUTES } from "./smoke";

const vercel = JSON.parse(readFileSync(join(import.meta.dirname, "..", "vercel.json"), "utf8")) as {
  regions?: string[];
  ignoreCommand?: string;
  crons?: unknown;
  schedules?: Record<string, { schedule: string; path?: string; requestMethod?: string }>;
};

describe("vercel.json", () => {
  it("runs functions in pdx1, next to the Turso database in aws-us-west-2 (DESIGN §8.2)", () => {
    // Every page and action makes several DB round trips; across the country each costs ~70 ms.
    expect(vercel.regions).toEqual(["pdx1"]);
  });

  // Exit 0 skips the build. Every preview kept ~38 MB of Function Storage and nothing used them.
  const skips = (env: Record<string, string>) =>
    spawnSync("sh", ["-c", vercel.ignoreCommand ?? "exit 1"], {
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    }).status === 0;

  it("builds main, even when VERCEL_ENV isn't production at the ignore step (§10 #108)", () => {
    // Regression: `[ "$VERCEL_ENV" != production ]` alone skipped every main push after #105.
    expect(skips({ VERCEL_GIT_COMMIT_REF: "main" })).toBe(false);
    expect(skips({ VERCEL_GIT_COMMIT_REF: "main", VERCEL_ENV: "preview" })).toBe(false);
    expect(skips({ VERCEL_ENV: "production" })).toBe(false);
  });

  it("skips preview builds of other branches (DESIGN §8.2, §10 #105)", () => {
    expect(skips({ VERCEL_GIT_COMMIT_REF: "some-branch", VERCEL_ENV: "preview" })).toBe(true);
    expect(skips({ VERCEL_GIT_COMMIT_REF: "some-branch" })).toBe(true);
  });

  it("schedules GET /api/cron/daily at 11:17 UTC", () => {
    expect(vercel.schedules?.daily).toEqual({
      schedule: "17 11 * * *",
      path: "/api/cron/daily",
      // Schedules POST by default; the route (like the old Cron Job) takes GET.
      requestMethod: "GET",
    });
  });

  it("has no legacy crons left (both would run the job twice)", () => {
    expect(vercel.crons).toBeUndefined();
  });

  it("every scheduled path is a machine route that smoke checks for its token", () => {
    const smoked = new Set(MACHINE_ROUTES.map(([m, p]) => `${m} ${p}`));
    for (const s of Object.values(vercel.schedules ?? {}))
      expect(smoked).toContain(`${s.requestMethod ?? "POST"} ${s.path}`);
  });
});
