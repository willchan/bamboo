import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "./client";
import { databaseUrlFromEnv, DEFAULT_DATABASE_URL, vercelMigrateProblem } from "./env";
import { setting } from "./schema/index";

describe("migrations", () => {
  let db: Db | undefined;
  afterEach(() => db?.$client.close());

  it("create the setting table, which round-trips a value", async () => {
    db = await createTestDb();
    await db.insert(setting).values({ key: "nudge_enabled", value: "true" });
    await db
      .insert(setting)
      .values({ key: "nudge_enabled", value: "false" })
      .onConflictDoUpdate({ target: setting.key, set: { value: "false" } });
    const rows = await db.select().from(setting).where(eq(setting.key, "nudge_enabled"));
    expect(rows).toEqual([{ key: "nudge_enabled", value: "false" }]);
  });
});

describe("databaseUrlFromEnv", () => {
  it("defaults to db/dev.db as an absolute file URL", () => {
    expect(databaseUrlFromEnv({})).toBe(DEFAULT_DATABASE_URL);
    expect(DEFAULT_DATABASE_URL).toMatch(/^file:\/.*\/db\/dev\.db$/);
  });

  it("uses TURSO_DATABASE_URL when set", () => {
    expect(databaseUrlFromEnv({ TURSO_DATABASE_URL: "libsql://x.turso.io" })).toBe(
      "libsql://x.turso.io",
    );
  });
});

describe("vercelMigrateProblem", () => {
  it("allows anything off Vercel", () => {
    expect(vercelMigrateProblem({})).toBeNull();
  });

  it("refuses a missing or local database on Vercel", () => {
    expect(vercelMigrateProblem({ VERCEL: "1" })).toMatch(/TURSO_DATABASE_URL/);
    expect(vercelMigrateProblem({ VERCEL: "1", TURSO_DATABASE_URL: "file:db/dev.db" })).toMatch(
      /TURSO_DATABASE_URL/,
    );
  });

  it("needs a token on Vercel", () => {
    const env = { VERCEL: "1", TURSO_DATABASE_URL: "libsql://bamboo-x.turso.io" };
    expect(vercelMigrateProblem(env)).toMatch(/TURSO_AUTH_TOKEN/);
    expect(vercelMigrateProblem({ ...env, TURSO_AUTH_TOKEN: "t" })).toBeNull();
  });
});
