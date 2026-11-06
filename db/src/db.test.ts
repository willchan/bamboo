import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "./client";
import { databaseUrlFromEnv, DEFAULT_DATABASE_URL, vercelMigrateProblem } from "./env";
import { card, phrase, setting } from "./schema/index";

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

describe("phrase and card tables", () => {
  let db: Db | undefined;
  afterEach(() => db?.$client.close());

  const phraseRow = (id: string, hanziKey: string) => ({
    id,
    status: "queued" as const,
    kind: "term" as const,
    hanzi: hanziKey,
    hanziKey,
    english: "x",
    pinyin: [] as [string, string | null][],
    baseScore: 1,
    source: "manual" as const,
    lastAskedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });

  it("round-trip JSON columns with defaults", async () => {
    db = await createTestDb();
    await db.insert(phrase).values(phraseRow("p1", "泡打粉"));
    const [p] = await db.select().from(phrase);
    expect(p).toMatchObject({ examples: [], tags: [], flags: [], pinned: false, askedCount: 1 });
  });

  it("enforce a unique hanzi_key and one card per phrase and type", async () => {
    db = await createTestDb();
    await db.insert(phrase).values(phraseRow("p1", "泡打粉"));
    await expect(db.insert(phrase).values(phraseRow("p2", "泡打粉"))).rejects.toThrow();
    const c = { phraseId: "p1", type: "say" as const, due: 1, createdAt: 1 };
    await db.insert(card).values({ id: "c1", ...c });
    await expect(db.insert(card).values({ id: "c2", ...c })).rejects.toThrow();
    await expect(
      db.insert(card).values({ id: "c3", ...c, phraseId: "missing", type: "listen" }),
    ).rejects.toThrow();
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
