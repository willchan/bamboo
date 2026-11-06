// M6 on a real (in-memory) DB: the nudge route and the Stats queries, on synthetic fixture data.
import { card, createTestDb, event, reviewLog, round, setting, type Db } from "@bamboo/db";
import { NudgeResponse } from "@bamboo/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as nudgeGET } from "@/app/api/agent/nudge/route";
import { zonedTime } from "../domain/day";
import { PhraseInput } from "../domain/phrase";
import { State } from "../domain/state";
import { eventRow, newId } from "./db";
import { getNudgeTime, isNudgeEnabled, setNudgeEnabled, takeNudge } from "./nudge";
import { createManualPhrase } from "./phrases";
import { finishRound, gradeCard, startRound, type Clock } from "./review";
import { getStats } from "./stats";

const TZ = "America/Los_Angeles";
const AGENT = "agent-token-for-tests";
const APP = "https://bamboo.example.test";
const MIN = 60_000;
/** June `day`, 2026, `hour`:`min` in Los Angeles. */
const la = (day: number, hour: number, min = 0) => zonedTime(2026, 6, day, hour, TZ) + min * MIN;
const clock = (now: number): Clock => ({ now, timeZone: TZ });

let db: Db;
const holder = globalThis as unknown as { __bambooDb?: Db };

beforeEach(async () => {
  db = await createTestDb();
  holder.__bambooDb = db;
  vi.stubEnv("AGENT_API_TOKEN", AGENT);
  vi.stubEnv("HOUSEHOLD_TZ", TZ);
  vi.stubEnv("APP_URL", APP);
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  holder.__bambooDb = undefined;
  db.$client.close();
});

async function addPhrase(hanzi = "泡打粉", english = "baking powder", now = la(1, 12)) {
  const r = await createManualPhrase(
    db,
    PhraseInput.parse({ kind: "term", hanzi, english, cardTypes: ["say"] }),
    now,
  );
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

/** A finished round started at `start` (no cards: only its times matter here). */
async function finishedRound(start: number, ms = 3 * MIN) {
  await db
    .insert(round)
    .values({ id: newId(), startedAt: start, finishedAt: start + ms, cardIds: [] });
}

const nudge = (token: string | null = AGENT) =>
  nudgeGET(
    new Request("http://localhost/api/agent/nudge", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

describe("GET /api/agent/nudge", () => {
  it("needs the agent token", async () => {
    expect((await nudge(null)).status).toBe(401);
    expect((await nudge("worker-token")).status).toBe(401);
    vi.stubEnv("AGENT_API_TOKEN", "");
    expect((await nudge()).status).toBe(503);
  });

  it("answers null with nothing to do, before 21:00, and once sent", async () => {
    vi.setSystemTime(la(20, 21, 30));
    expect(NudgeResponse.parse(await (await nudge()).json())).toEqual({ text: null });

    await addPhrase();
    vi.setSystemTime(la(20, 20, 30));
    expect(await (await nudge()).json()).toEqual({ text: null });

    vi.setSystemTime(la(20, 21, 0));
    const res = await nudge();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: `📚 1 round · ~1 min · 1 new → ${APP}` });
    const sent = await db.select().from(event).where(eq(event.type, "nudge_sent"));
    expect(sent.map((e) => e.data)).toEqual([{ local_time: "21:00", nudge_at: "21:00" }]);

    // The next poll, and one after midnight (still the same household day), get nothing.
    vi.setSystemTime(la(20, 21, 30));
    expect(await (await nudge()).json()).toEqual({ text: null });
    vi.setSystemTime(la(21, 1, 0));
    expect(await (await nudge()).json()).toEqual({ text: null });
    // The next evening, it's due again.
    vi.setSystemTime(la(21, 21, 0));
    expect((await (await nudge()).json()) as NudgeResponse).toMatchObject({
      text: expect.stringContaining("📚 1 round"),
    });
  });

  it("falls back to the request's origin without APP_URL", async () => {
    vi.stubEnv("APP_URL", "");
    await addPhrase();
    vi.setSystemTime(la(20, 21, 0));
    expect(await (await nudge()).json()).toEqual({
      text: "📚 1 round · ~1 min · 1 new → http://localhost",
    });
  });

  it("stays quiet on a day a round is already done", async () => {
    await addPhrase();
    await addPhrase("毛巾", "towel");
    const id = await startRound(db, clock(la(20, 19)));
    await finishRound(db, id!, clock(la(20, 19, 5)));
    vi.setSystemTime(la(20, 21, 0));
    expect(await (await nudge()).json()).toEqual({ text: null });
    expect(await db.select().from(event).where(eq(event.type, "nudge_sent"))).toEqual([]);
  });

  it("stays quiet when turned off", async () => {
    expect(await isNudgeEnabled(db)).toBe(true);
    await addPhrase();
    await setNudgeEnabled(db, false);
    expect(await isNudgeEnabled(db)).toBe(false);
    vi.setSystemTime(la(20, 22, 0));
    expect(await (await nudge()).json()).toEqual({ text: null });
    await setNudgeEnabled(db, true);
    expect((await (await nudge()).json()) as NudgeResponse).not.toEqual({ text: null });
  });

  it("only one of two overlapping polls gets the text", async () => {
    await addPhrase();
    const c = clock(la(20, 21, 0));
    const both = await Promise.all([takeNudge(db, c, APP), takeNudge(db, c, APP)]);
    expect(both.filter((t) => t !== null)).toHaveLength(1);
    const [row] = await db.select().from(setting).where(eq(setting.key, "nudge_last_sent_day"));
    expect(row!.value).toBe("2026-06-20");
  });

  it("moves to just before his usual time after 5 practice days", async () => {
    await addPhrase();
    for (const d of [14, 15, 16, 17, 18]) await finishedRound(la(d, 19, 40));
    expect(await getNudgeTime(db, clock(la(20, 12)))).toBe("19:25");
    expect(await takeNudge(db, clock(la(20, 19, 20)), APP)).toBeNull();
    expect(await takeNudge(db, clock(la(20, 19, 30)), APP)).not.toBeNull();
  });
});

describe("getStats", () => {
  it("computes the PRD §6 measures from fixture data", async () => {
    const now = la(20, 22);
    const OLD = zonedTime(2026, 5, 20, 20, TZ); // before the 4-week window
    // Rounds: 3 practice days this week (one with two rounds), 1 the week before, 1 too old.
    for (const t of [la(20, 20), la(20, 21), la(18, 20), la(14, 20), la(10, 20), OLD])
      await finishedRound(t);

    // Reviews: two of three Review-state session grades passed; other rows don't count.
    const logs = [
      { rating: 3, stateBefore: State.Review, source: "session" as const },
      { rating: 1, stateBefore: State.Review, source: "session" as const },
      { rating: 4, stateBefore: State.Review, source: "session" as const },
      { rating: 1, stateBefore: State.Learning, source: "session" as const },
      { rating: 1, stateBefore: State.Review, source: "asked_again" as const },
    ];
    await addPhrase();
    await addPhrase("毛巾", "towel");
    const [someCard] = await db.select().from(card);
    for (const l of logs)
      await db.insert(reviewLog).values({
        id: newId(),
        cardId: someCard!.id,
        rating: l.rating,
        source: l.source,
        stateBefore: l.stateBefore,
        roundId: null,
        reviewedAt: la(19, 20),
        durationMs: null,
        fsrsLog: {},
      });

    const ev = (type: string, data: Record<string, unknown>, at = la(19, 20)) =>
      db.insert(event).values(eventRow(type, data, at));
    await ev("phrase_introduced", { phrase_id: "a", kind: "term", usefulness: 4 });
    await ev("phrase_introduced", { phrase_id: "b", kind: "frame", usefulness: 5 });
    await ev("phrase_introduced", { phrase_id: "c", kind: "term", usefulness: null });
    await ev("phrase_dropped", { phrase_id: "d", kind: "term", usefulness: 2, via: "not_useful" });
    await ev("phrase_dropped", { phrase_id: "e", kind: "term", usefulness: 3, via: "remove" });
    await ev("asked_again", { phrase_id: "a", status: "active", import_id: "i" });
    await ev("asked_again", { phrase_id: "f", status: "queued", import_id: "i" });
    await ev("asked_again", { phrase_id: "a", status: "active", import_id: "old" }, OLD);
    await ev("extraction", { items: 8, dropped_not_verbatim: 1 });
    await ev("extraction", { items: 2, dropped_not_verbatim: 0 });
    await ev("worker_heartbeat", { version: "0.0.0" }, la(20, 21, 50));

    const s = await getStats(db, clock(now));
    expect(s.weeks.map((w) => [w.firstDay, w.practiceDays])).toEqual([
      ["2026-06-14", 3],
      ["2026-06-07", 1],
      ["2026-05-31", 0],
      ["2026-05-24", 0],
    ]);
    expect(s.retention).toEqual({ hits: 2, total: 3, rate: 2 / 3 });
    expect(s.askedAgainActive).toBe(1);
    expect(s.notUseful.all).toEqual({ hits: 1, total: 4, rate: 0.25 });
    expect(s.notUseful.byKind.term).toEqual({ hits: 1, total: 3, rate: 1 / 3 });
    expect(s.notUseful.byUsefulness.manual).toEqual({ hits: 0, total: 1, rate: 0 });
    expect(s.extractionDrop).toEqual({ hits: 1, total: 10, rate: 0.1 });
    expect(s.queueSize).toBe(2);
    expect(s.lastHeartbeatAt).toBe(la(20, 21, 50));
  });

  it("is empty-safe", async () => {
    const s = await getStats(db, clock(la(20, 22)));
    expect(s.retention.rate).toBeNull();
    expect(s.notUseful.all.rate).toBeNull();
    expect(s.lastHeartbeatAt).toBeNull();
    expect(s.weeks.every((w) => w.practiceDays === 0)).toBe(true);
  });

  it("counts a real graded round", async () => {
    const id = await addPhrase();
    expect(id).toBeTruthy();
    const r = await startRound(db, clock(la(20, 20)));
    const [cardId] = (await db.select().from(round).where(eq(round.id, r!)))[0]!.cardIds;
    await gradeCard(
      db,
      { roundId: r, cardId: cardId!, grade: 3, source: "session", durationMs: 1000 },
      clock(la(20, 20, 1)),
    );
    await finishRound(db, r!, clock(la(20, 20, 2)));
    const s = await getStats(db, clock(la(20, 22)));
    expect(s.weeks[0]!.practiceDays).toBe(1);
    expect(s.notUseful.all).toEqual({ hits: 0, total: 1, rate: 0 });
  });
});
