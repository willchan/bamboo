// Will's report: with only a few cards, several rounds in one evening, everything rated Good, one
// card (a decode phrase with a "heard as") kept coming first. This replays that evening against
// the real scheduler and records what happens (DESIGN §4.4, §10 #57).
import { card, createTestDb, phrase, type Db } from "@bamboo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { State } from "../domain/fsrs";
import { PhraseInput } from "../domain/phrase";
import { createManualPhrase } from "./phrases";
import { finishRound, getRound, getToday, gradeCard, startRound, type Clock } from "./review";

const T0 = new Date("2026-06-02T03:00:00Z").getTime(); // 20:00 PDT
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const clock = (now: number): Clock => ({ now, timeZone: "America/Los_Angeles" });

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.$client.close());

/** A queued (not pinned) phrase with the given score, as extraction would leave it. */
async function queued(hanzi: string, english: string, baseScore: number, decode = false) {
  const r = await createManualPhrase(
    db,
    PhraseInput.parse({
      kind: "term",
      hanzi,
      english,
      heardAs: decode ? "synthetic heard-as" : undefined,
      cardTypes: [decode ? "listen" : "say"],
    }),
    T0 - DAY,
  );
  if (!r.ok) throw new Error(r.error);
  await db
    .update(phrase)
    .set({ pinned: false, pinnedAt: null, baseScore, turnKind: decode ? "decode" : "say" })
    .where(eq(phrase.id, r.id));
}

/** One round started at `now`, every card rated Good ~10 s apart. Its order, by English. */
async function roundAllGood(now: number): Promise<string[] | null> {
  const id = await startRound(db, clock(now));
  if (!id) return null;
  const cards = (await getRound(db, id, clock(now)))!.cards;
  for (const [k, c] of cards.entries()) {
    await gradeCard(
      db,
      { roundId: id, cardId: c.cardId, grade: 3, source: "session", durationMs: 5000 },
      clock(now + (k + 1) * 10_000),
    );
  }
  await finishRound(db, id, clock(now + (cards.length + 1) * 10_000));
  return cards.map((c) => c.english);
}

it("replays an evening of all-Good rounds a few minutes apart", async () => {
  // Decode + heard-as ranks highest (term 1 + decode 3 + heard-as 2).
  await queued("泡打粉", "decode", 6, true);
  await queued("喝水", "water", 4);
  await queued("吃饭", "eat", 3);

  // Round 1: three new cards (newPerDay), in queue order, so the decode phrase leads.
  expect(await roundAllGood(T0)).toEqual(["decode", "water", "eat"]);
  // Good on a new card is the 10-minute learning step, not "done for tonight".
  for (const c of await db.select().from(card)) {
    expect(c.state).toBe(State.Learning);
    expect(c.due - T0).toBeLessThan(11 * MIN);
  }
  // Today offers another round right away: 10 m is inside the 20 m learn-ahead.
  expect((await getToday(db, clock(T0 + 2 * MIN))).status).toMatchObject({
    kind: "done",
    another: { due: 3 },
  });

  // Round 2, minutes later: the same three cards, now learning cards. Ordered by due alone, the
  // decode card (graded first in round 1) would lead again; the per-round order mixes them.
  const second = await roundAllGood(T0 + 5 * MIN);
  expect([...second!].sort()).toEqual(["decode", "eat", "water"]);
  // (At this start time the seeded order happens to put another card first.)
  expect(second![0]).not.toBe("decode");

  // Good on the last learning step graduates: next due in weeks (FSRS-7, 0.85 retention).
  for (const c of await db.select().from(card)) {
    expect(c.state).toBe(State.Review);
    expect(c.due - T0).toBeGreaterThan(7 * DAY);
  }
  // Nothing more tonight: no third round, so no card can lead it.
  expect(await roundAllGood(T0 + 15 * MIN)).toBeNull();
  expect((await getToday(db, clock(T0 + 15 * MIN))).status).toEqual({
    kind: "done",
    another: null,
  });
});

/** One round started at `now`, every card rated `grade` ~10 s apart. Cards shown, by English. */
async function roundAll(now: number, grade: 1 | 2 | 3 | 4): Promise<string[] | null> {
  const id = await startRound(db, clock(now));
  if (!id) return null;
  const cards = (await getRound(db, id, clock(now)))!.cards;
  for (const [k, c] of cards.entries()) {
    await gradeCard(
      db,
      { roundId: id, cardId: c.cardId, grade, source: "session", durationMs: 5000 },
      clock(now + (k + 1) * 10_000),
    );
  }
  await finishRound(db, id, clock(now + (cards.length + 1) * 10_000));
  return cards.map((c) => c.english);
}

it("Hard on a learning card holds it until tomorrow instead of looping all evening", async () => {
  // Will's report: two words rated Hard came back in every "Another round". Hard repeats a
  // learning step (5–10 m), inside learn-ahead, so the card was due again at once, forever.
  await queued("喝水", "water", 4);
  await queued("吃饭", "eat", 3);

  expect(await roundAll(T0, 3)).toEqual(["water", "eat"]); // Good: 10-minute step
  expect((await roundAll(T0 + 5 * MIN, 2))?.sort()).toEqual(["eat", "water"]); // Hard

  // No more rounds tonight for those two: they wait for tomorrow.
  expect((await getToday(db, clock(T0 + 7 * MIN))).status).toEqual({
    kind: "done",
    another: null,
  });
  expect(await startRound(db, clock(T0 + 30 * MIN))).toBeNull();

  // Tomorrow they're still learning cards, due, and in the first round.
  for (const c of await db.select().from(card)) expect(c.state).toBe(State.Learning);
  expect((await roundAll(T0 + DAY, 3))?.sort()).toEqual(["eat", "water"]);
});

it("Again on a learning card still brings it back tonight", async () => {
  await queued("喝水", "water", 4);
  expect(await roundAll(T0, 1)).toEqual(["water"]);
  expect((await getToday(db, clock(T0 + 2 * MIN))).status).toMatchObject({
    kind: "done",
    another: { due: 1 },
  });
});
