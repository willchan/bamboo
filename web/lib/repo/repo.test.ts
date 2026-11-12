import { card, createTestDb, event, phrase, reviewLog, round, type Db } from "@bamboo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { PhraseInput, type PhraseInputRaw } from "../domain/phrase";
import { frequencyPoints } from "../domain/queue";
import {
  allTags,
  createManualPhrase,
  dropPhrase,
  getPhrase,
  listPhrases,
  listQueue,
  phraseRows,
  pinPhrase,
  restorePhrase,
  updatePhrase,
} from "./phrases";
import {
  finishRound,
  getRound,
  getToday,
  gradeCard,
  markNotUseful,
  startRound,
  type Clock,
} from "./review";

const T0 = new Date("2026-06-02T03:00:00Z").getTime(); // 20:00 PDT
const clock = (now = T0): Clock => ({ now, timeZone: "America/Los_Angeles" });
const MIN = 60_000;

const input = (o: Partial<PhraseInputRaw> = {}) =>
  PhraseInput.parse({
    kind: "term",
    hanzi: "泡打粉",
    english: "baking powder",
    cardTypes: ["say"],
    ...o,
  });

/** Distinct one-character phrases, for tests that need many. */
const HANZI = Array.from("一二三四五六七八九十百千");

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.$client.close());

async function add(o: Partial<PhraseInputRaw> = {}, now = T0) {
  const r = await createManualPhrase(db, input(o), now);
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

describe("phrases", () => {
  it("creates a manual phrase queued and pinned, with computed pinyin and cards", async () => {
    const id = await add({ cardTypes: ["say", "listen"], tags: ["Food", " food ", ""] });
    const p = await getPhrase(db, id);
    expect(p).toMatchObject({
      status: "queued",
      pinned: true,
      pinnedAt: T0,
      source: "manual",
      hanziKey: "泡打粉",
      tags: ["food"],
      pinyin: [
        ["泡", "pào"],
        ["打", "dǎ"],
        ["粉", "fěn"],
      ],
      pinyinOverride: null,
      // term 1, plus how common 泡打粉 is (tags no longer score by themselves)
      baseScore: 1 + frequencyPoints({ kind: "term", tags: ["food"], hanziKey: "泡打粉" }),
    });
    expect(p!.cards.map((c) => [c.type, c.state, c.due])).toEqual([
      ["say", 0, T0],
      ["listen", 0, T0],
    ]);
  });

  it("refuses a duplicate by hanzi key", async () => {
    const id = await add();
    const again = await createManualPhrase(db, input({ hanzi: " 泡打粉。" }), T0);
    expect(again).toEqual({ ok: false, error: "duplicate", existingId: id });
  });

  it("stores pinyin overrides from the editor", async () => {
    const id = await add({ kind: "sentence", hanzi: "我得走", pinyinEdits: ["", "de2", ""] });
    expect((await getPhrase(db, id))!.pinyinOverride).toEqual([
      ["我", null],
      ["得", "dé"],
      ["走", null],
    ]);
  });

  it("keeps examples for terms only", async () => {
    const examples = [{ hanzi: "放一勺泡打粉", english: "add a spoon of baking powder" }];
    const term = await add({ examples });
    expect((await getPhrase(db, term))!.examples).toEqual([{ ...examples[0], turn_id: null }]);
    const sentence = await add({ kind: "sentence", hanzi: "放一勺泡打粉吧", examples });
    expect((await getPhrase(db, sentence))!.examples).toEqual([]);
  });

  it("edits: recomputes pinyin, keeps or drops the override, toggles card types", async () => {
    const id = await add({ kind: "sentence", hanzi: "我得走", pinyinEdits: ["", "de2", ""] });
    const same = await updatePhrase(db, id, input({ kind: "sentence", hanzi: "我得走" }), T0 + 1);
    expect(same).toEqual({ ok: true, id, overrideDropped: false });
    expect((await getPhrase(db, id))!.pinyinOverride).not.toBeNull();

    const changed = await updatePhrase(
      db,
      id,
      input({ kind: "sentence", hanzi: "我得走了", cardTypes: ["listen"] }),
      T0 + 2,
    );
    expect(changed).toEqual({ ok: true, id, overrideDropped: true });
    const p = (await getPhrase(db, id))!;
    expect(p.pinyinOverride).toBeNull();
    expect(p.hanziKey).toBe("我得走了");
    expect(p.cards.map((c) => [c.type, c.suspendedAt])).toEqual([
      ["say", T0 + 2],
      ["listen", null],
    ]);

    await updatePhrase(
      db,
      id,
      input({ kind: "sentence", hanzi: "我得走了", cardTypes: ["say"] }),
      T0 + 3,
    );
    const q = (await getPhrase(db, id))!;
    expect(q.cards.map((c) => [c.type, c.suspendedAt])).toEqual([
      ["say", null],
      ["listen", T0 + 3],
    ]);
  });

  it("refuses an edit that collides with another phrase, and unknown ids", async () => {
    const a = await add({ hanzi: "米粉" });
    const b = await add({ hanzi: "面粉" });
    expect(await updatePhrase(db, b, input({ hanzi: "米粉" }), T0)).toEqual({
      ok: false,
      error: "duplicate",
      existingId: a,
    });
    expect(await updatePhrase(db, "nope", input(), T0)).toEqual({ ok: false, error: "not_found" });
  });

  it("drops (logging phrase_dropped), restores, and lists", async () => {
    const id = await add({ tags: ["groceries"] });
    const other = await add({ hanzi: "高压锅", english: "pressure cooker", heardAs: "gaoyaguo" });
    expect(await dropPhrase(db, id, T0 + 5, "remove")).toBe(true);
    expect(await dropPhrase(db, id, T0 + 6, "remove")).toBe(false);
    const events = await db.select().from(event).where(eq(event.type, "phrase_dropped"));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ phrase_id: id, kind: "term", via: "remove" });

    expect((await listPhrases(db)).map((p) => p.id)).toEqual([other]);
    expect((await listPhrases(db, { status: "dropped" })).map((p) => p.id)).toEqual([id]);
    expect((await listPhrases(db, { q: "gaoya" })).map((p) => p.id)).toEqual([other]);
    expect((await listPhrases(db, { q: "压锅" })).map((p) => p.id)).toEqual([other]);
    expect((await listPhrases(db, { q: "cooker" })).map((p) => p.id)).toEqual([other]);
    expect((await listPhrases(db, { q: "guō" })).map((p) => p.id)).toEqual([other]);
    expect(await listPhrases(db, { tag: "groceries" })).toEqual([]);
    expect(await allTags(db)).toEqual(["groceries"]);

    expect(await restorePhrase(db, id, T0 + 7)).toBe(true);
    expect((await getPhrase(db, id))!.status).toBe("queued");
    expect(await restorePhrase(db, id, T0 + 8)).toBe(false);
  });

  it("lists the queue in order; Move to top pins", async () => {
    const rows = phraseRows(
      {
        status: "queued",
        kind: "frame",
        hanzi: "您是说…吗？",
        english: "Do you mean…?",
        source: "import",
      },
      ["say"],
      T0,
    );
    await db.insert(phrase).values(rows.phrase);
    await db.insert(card).values(rows.cards);
    const manual = await add({}, T0 - 1000);
    expect((await listQueue(db, T0)).map((p) => p.id)).toEqual([manual, rows.phrase.id]);
    expect(await pinPhrase(db, rows.phrase.id, T0 + 1)).toBe(true);
    expect((await listQueue(db, T0 + 1)).map((p) => [p.id, p.rank])).toEqual([
      [rows.phrase.id, 1],
      [manual, 2],
    ]);
  });
});

describe("rounds", () => {
  it("runs the e2e flow: add → start → Good → done for today", async () => {
    expect((await getToday(db, clock())).status).toEqual({ kind: "done", another: null });
    expect(await startRound(db, clock())).toBeNull();

    const id = await add();
    const today = await getToday(db, clock());
    expect(today.status).toMatchObject({ kind: "start", workload: { due: 0, newAvailable: 1 } });
    expect(today.queueSize).toBe(1);

    const roundId = (await startRound(db, clock()))!;
    const view = (await getRound(db, roundId, clock()))!;
    expect(view.total).toBe(1);
    expect(view.cards).toHaveLength(1);
    const c = view.cards[0]!;
    expect(c).toMatchObject({
      phraseId: id,
      type: "say",
      firstSight: true,
      english: "baking powder",
    });
    expect(c.intervals[1]).toBe("1m");
    expect(c.intervals[3]).toBe("10m");

    const graded = (await gradeCard(
      db,
      { roundId, cardId: c.cardId, grade: 3, source: "session", durationMs: 4200 },
      clock(T0 + MIN),
    ))!;
    expect(graded.dueInMs).toBe(10 * MIN);

    const p = (await getPhrase(db, id))!;
    expect(p.status).toBe("active");
    expect(p.introducedAt).toBe(T0 + MIN);
    const logs = await db.select().from(reviewLog);
    expect(logs).toMatchObject([
      { rating: 3, source: "session", stateBefore: 0, roundId, durationMs: 4200 },
    ]);
    const introduced = await db.select().from(event).where(eq(event.type, "phrase_introduced"));
    expect(introduced[0]!.data).toMatchObject({ phrase_id: id, rank: 1, kind: "term" });

    // The graded card has left the round; a reload resumes with nothing left.
    expect((await getRound(db, roundId, clock(T0 + MIN)))!.cards).toEqual([]);

    const after = (await finishRound(db, roundId, clock(T0 + 2 * MIN)))!;
    // The learning step (10 m) is within learn-ahead, so another round is on offer.
    expect(after.status).toMatchObject({ kind: "done", another: { due: 1 } });
    const r = (await db.select().from(round))[0]!;
    expect(r).toMatchObject({ finishedAt: T0 + 2 * MIN, cards: 1 });
    // Idempotent.
    await finishRound(db, roundId, clock(T0 + 3 * MIN));
    expect(await db.select().from(event).where(eq(event.type, "round_finished"))).toHaveLength(1);
    expect(await finishRound(db, "nope", clock())).toBeNull();
    expect(await getRound(db, "nope", clock())).toBeNull();
  });

  it("a retried grade (same reviewId) is saved once", async () => {
    await add();
    const roundId = (await startRound(db, clock()))!;
    const c = (await getRound(db, roundId, clock()))!.cards[0]!;
    const g = {
      roundId,
      cardId: c.cardId,
      grade: 3 as const,
      source: "session" as const,
      durationMs: 1,
      reviewId: "client-review-1",
    };
    const first = (await gradeCard(db, g, clock(T0 + MIN)))!;
    const retry = (await gradeCard(db, g, clock(T0 + MIN + 500)))!;
    const logs = await db.select().from(reviewLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.id).toBe("client-review-1");
    expect((await db.select().from(round))[0]!.cards).toBe(1);
    expect(retry.intervals).toEqual(first.intervals);
    expect(retry.dueInMs).toBe(first.dueInMs - 500);
  });

  it("buries the sibling once one card of a phrase is shown", async () => {
    const id = await add({ cardTypes: ["say", "listen"] });
    const roundId = (await startRound(db, clock()))!;
    const view = (await getRound(db, roundId, clock()))!;
    expect(view.cards).toHaveLength(1); // one card per phrase
    await gradeCard(
      db,
      {
        roundId,
        cardId: view.cards[0]!.cardId,
        grade: 4,
        source: "already_know",
        durationMs: null,
      },
      clock(),
    );
    const p = (await getPhrase(db, id))!;
    const other = p.cards.find((c) => c.id !== view.cards[0]!.cardId)!;
    expect(other.buriedUntil).toBe(new Date("2026-06-02T11:00:00Z").getTime());
    expect(await db.select().from(event).where(eq(event.type, "already_know"))).toHaveLength(1);
    await finishRound(db, roundId, clock());
    // Easy → review far out; sibling buried; nothing else: done.
    expect((await getToday(db, clock(T0 + MIN))).status).toEqual({ kind: "done", another: null });
    // Tomorrow the sibling is a new card of an active phrase.
    const tomorrow = await getToday(db, clock(T0 + 24 * 60 * MIN));
    expect(tomorrow.status).toMatchObject({ kind: "start", workload: { newAvailable: 1 } });
  });

  it("Not useful drops the phrase and skips it", async () => {
    const id = await add();
    const keep = await add({ hanzi: "高压锅", english: "pressure cooker" }, T0 + 1);
    const roundId = (await startRound(db, clock()))!;
    const view = (await getRound(db, roundId, clock()))!;
    expect(view.cards.map((c) => c.phraseId)).toEqual([keep, id]);
    const target = view.cards.find((c) => c.phraseId === id)!;
    expect(await markNotUseful(db, target.cardId, clock())).toBe(true);
    expect((await getPhrase(db, id))!.status).toBe("dropped");
    const dropped = await db.select().from(event).where(eq(event.type, "phrase_dropped"));
    expect(dropped[0]!.data).toMatchObject({ phrase_id: id, via: "not_useful" });
    // Gone from the round, and grading it is refused.
    expect((await getRound(db, roundId, clock()))!.cards.map((c) => c.phraseId)).toEqual([keep]);
    expect(
      await gradeCard(
        db,
        { roundId, cardId: target.cardId, grade: 3, source: "session", durationMs: null },
        clock(),
      ),
    ).toBeNull();
    // Not useful doesn't count toward the new cap: the whole cap is still allowed today.
    for (const h of ["米粉", "面粉", "奶粉", "米饭", "面条"]) await add({ hanzi: h });
    const today = await getToday(db, clock());
    expect(today.status).toMatchObject({
      workload: { newAvailable: config.session.newPerDay },
    });
  });

  it("refuses Not useful on a card that has been reviewed", async () => {
    await add();
    const roundId = (await startRound(db, clock()))!;
    const c = (await getRound(db, roundId, clock()))!.cards[0]!;
    await gradeCard(
      db,
      { roundId, cardId: c.cardId, grade: 1, source: "session", durationMs: null },
      clock(),
    );
    expect(await markNotUseful(db, c.cardId, clock())).toBe(false);
    expect(await markNotUseful(db, "nope", clock())).toBe(false);
  });

  it("caps new cards across rounds at newPerDay", async () => {
    const cap = config.session.newPerDay;
    for (let i = 0; i < cap + 2; i++) await add({ hanzi: HANZI[i] });
    const first = (await startRound(db, clock()))!;
    const cards = (await getRound(db, first, clock()))!.cards;
    expect(cards).toHaveLength(cap);
    for (const c of cards.slice(0, cap - 1)) {
      await gradeCard(
        db,
        { roundId: first, cardId: c.cardId, grade: 4, source: "session", durationMs: null },
        clock(),
      );
    }
    await finishRound(db, first, clock());
    const second = (await startRound(db, clock(T0 + MIN)))!;
    expect((await getRound(db, second, clock(T0 + MIN)))!.cards).toHaveLength(1);
  });

  it("Learn more: offered once the cap is used, its round adds extra new cards", async () => {
    const { newPerDay: cap, extraNewBatch: extra } = config.session;
    // The cap, one Learn-more batch, and one phrase left over.
    for (let i = 0; i < cap + extra + 1; i++) await add({ hanzi: HANZI[i] });
    const gradeAll = async (roundId: string, now: number) => {
      for (const c of (await getRound(db, roundId, clock(now)))!.cards) {
        await gradeCard(
          db,
          { roundId, cardId: c.cardId, grade: 4, source: "session", durationMs: null },
          clock(now),
        );
      }
      return (await finishRound(db, roundId, clock(now)))!;
    };
    expect((await getToday(db, clock())).learnMore).toBe(0); // the cap has room
    // Even when asked, a round with room under the cap is a normal one.
    const first = (await startRound(db, clock(), { learnMore: true }))!;
    expect((await getRound(db, first, clock()))!.cards).toHaveLength(cap);
    const after = await gradeAll(first, T0 + MIN);
    expect(after.status).toEqual({ kind: "done", another: null });
    expect(after.learnMore).toBe(extra);
    // Without asking, nothing new today.
    expect(await startRound(db, clock(T0 + 2 * MIN))).toBeNull();
    const more = (await startRound(db, clock(T0 + 2 * MIN), { learnMore: true }))!;
    expect((await getRound(db, more, clock(T0 + 2 * MIN)))!.cards).toHaveLength(extra);
    await gradeAll(more, T0 + 3 * MIN);
    // One phrase left: offered again, for what's waiting.
    expect((await getToday(db, clock(T0 + 4 * MIN))).learnMore).toBe(1);
    // A new day: back to the normal cap, no Learn more while it has room.
    const tomorrow = await getToday(db, clock(T0 + 24 * 60 * MIN));
    expect(tomorrow.learnMore).toBe(0);
  });

  it("returns null when grading an unknown card", async () => {
    expect(
      await gradeCard(
        db,
        { roundId: null, cardId: "x", grade: 3, source: "session", durationMs: null },
        clock(),
      ),
    ).toBeNull();
  });

  it("leaves suspended cards out", async () => {
    const id = await add({ cardTypes: ["say", "listen"] });
    await updatePhrase(db, id, input({ cardTypes: ["listen"] }), T0);
    const roundId = (await startRound(db, clock()))!;
    const v = (await getRound(db, roundId, clock()))!;
    expect(v.cards.map((c) => c.type)).toEqual(["listen"]);
    const rows = await db.select().from(card).where(eq(card.phraseId, id));
    expect(rows).toHaveLength(2);
  });
});
