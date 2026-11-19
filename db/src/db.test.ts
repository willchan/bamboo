import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, MIGRATIONS_FOLDER, type Db } from "./client";
import { databaseUrlFromEnv, DEFAULT_DATABASE_URL, vercelMigrateProblem } from "./env";
import { card, event, phrase, reviewLog, setting } from "./schema/index";

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

// H2b (DESIGN §10 #77): 0006 retires frame phrases. The test DB is already migrated, so the rows
// go in first and the migration's SQL is run again over them, as the Vercel build runs it on prod.
describe("0006_retire_frames", () => {
  let db: Db | undefined;
  afterEach(() => db?.$client.close());

  const statements = readFileSync(join(MIGRATIONS_FOLDER, "0006_retire_frames.sql"), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  const retire = async (d: Db) => {
    for (const sql of statements) await d.$client.execute(sql);
  };
  const row = (id: string, kind: "term" | "frame", status: "queued" | "active" | "dropped") => ({
    id,
    status,
    kind,
    hanzi: id,
    hanziKey: id,
    english: "x",
    pinyin: [] as [string, string | null][],
    baseScore: 1,
    source: "import" as const,
    pinned: kind === "frame" && status === "queued",
    pinnedAt: kind === "frame" && status === "queued" ? 5 : null,
    lastAskedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });

  it("drops every frame (rows, cards and review_log kept), logs phrase_retired, once", async () => {
    db = await createTestDb();
    await db
      .insert(phrase)
      .values([
        row("frameActive", "frame", "active"),
        row("frameQueued", "frame", "queued"),
        row("frameDropped", "frame", "dropped"),
        row("term", "term", "active"),
      ]);
    await db.insert(card).values(
      ["frameActive", "term"].map((p) => ({
        id: `c-${p}`,
        phraseId: p,
        type: "say" as const,
        due: 1,
        createdAt: 1,
      })),
    );
    await db.insert(reviewLog).values({
      id: "r1",
      cardId: "c-frameActive",
      rating: 3,
      source: "session",
      stateBefore: 0,
      reviewedAt: 2,
      fsrsLog: {},
    });

    await retire(db);
    const byId = new Map((await db.select().from(phrase)).map((p) => [p.id, p]));
    expect(byId.size).toBe(4);
    for (const id of ["frameActive", "frameQueued"]) {
      expect(byId.get(id)).toMatchObject({
        status: "dropped",
        kind: "frame",
        pinned: false,
        pinnedAt: null,
      });
      expect(byId.get(id)!.droppedAt).toBeGreaterThan(1);
    }
    expect(byId.get("frameDropped")).toMatchObject({
      status: "dropped",
      droppedAt: null,
      updatedAt: 1,
    });
    expect(byId.get("term")).toMatchObject({ status: "active", updatedAt: 1 });
    expect(await db.select().from(card)).toHaveLength(2);
    expect(await db.select().from(reviewLog)).toHaveLength(1);

    const retired = await db.select().from(event).where(eq(event.type, "phrase_retired"));
    expect(
      retired
        .map((e) => e.data)
        .sort((a, b) => String(a.phrase_id).localeCompare(String(b.phrase_id))),
    ).toEqual([
      { phrase_id: "frameActive", reason: "frame", status_before: "active" },
      { phrase_id: "frameQueued", reason: "frame", status_before: "queued" },
    ]);

    // Running it again changes nothing.
    await retire(db);
    expect(await db.select().from(event).where(eq(event.type, "phrase_retired"))).toHaveLength(2);
  });
});
