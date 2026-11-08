// Database calls per request in the review flow (Today → Start → review → grade → finish). Every
// sequential round trip costs a full trip to Turso, so these are kept low on purpose; a change
// that adds one should be deliberate (update the numbers and DESIGN §8.5).
import { createTestDb, type Db } from "@bamboo/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhraseInput } from "../domain/phrase";
import { instrumentClient, timed, timingSink, type Timing, currentTiming } from "../timing";
import { createManualPhrase } from "./phrases";
import { finishRound, getRound, gradeCard, startRound, type Clock } from "./review";
import { loadTodayPage } from "./today";

const T0 = new Date("2026-06-02T03:00:00Z").getTime();
const clock = (now = T0): Clock => ({ now, timeZone: "America/Los_Angeles" });

let db: Db;
const silent = timingSink.log;
beforeEach(async () => {
  db = await createTestDb();
  instrumentClient(db.$client);
  timingSink.log = () => {};
});
afterEach(() => {
  timingSink.log = silent;
  db.$client.close();
});

/** Run `fn` as one measured request; its database calls and sequential round trips. */
async function measure<T>(fn: () => Promise<T>) {
  let t: Timing | undefined;
  const out = await timed("test", async () => {
    t = currentTiming();
    return fn();
  });
  return { out, queries: t!.dbQueries, serial: t!.dbSerial };
}

async function add(hanzi: string, english: string, now = T0) {
  const r = await createManualPhrase(
    db,
    PhraseInput.parse({ kind: "sentence", hanzi, english, cardTypes: ["say"] }),
    now,
  );
  if (!r.ok) throw new Error(r.error);
}

describe("database calls per request in the review flow", () => {
  it("Today, Start, the review page, grading and finishing", async () => {
    await add("该吃饭了。", "Time to eat.");
    await add("喝水吗？", "Want some water?", T0 + 1);

    const today = await measure(() => loadTodayPage(db, clock()));
    const start = await measure(() => startRound(db, clock()));
    const roundId = start.out!;
    const page = await measure(() => getRound(db, roundId, clock()));
    const [first, second] = page.out!.cards;
    const gradeNew = await measure(() =>
      gradeCard(
        db,
        { roundId, cardId: first!.cardId, grade: 3, source: "session", durationMs: 1 },
        clock(),
      ),
    );
    await gradeCard(
      db,
      { roundId, cardId: second!.cardId, grade: 3, source: "session", durationMs: 1 },
      clock(),
    );
    const finish = await measure(() => finishRound(db, roundId, clock()));
    // A second round: the same cards are now learning cards (not new).
    const later = clock(T0 + 9 * 60_000);
    const round2 = (await startRound(db, later))!;
    const card2 = (await getRound(db, round2, later))!.cards[0]!;
    const gradeLearning = await measure(() =>
      gradeCard(
        db,
        { roundId: round2, cardId: card2.cardId, grade: 3, source: "session", durationMs: 1 },
        later,
      ),
    );

    const counts = Object.fromEntries(
      Object.entries({ today, start, page, gradeNew, gradeLearning, finish }).map(([k, v]) => [
        k,
        { queries: v.queries, serial: v.serial },
      ]),
    );
    // Before this was measured (PR "review speed"): today 9/2, start 6/3, page 3/3, gradeNew 4/4,
    // gradeLearning 3/3, finish 6/3 (queries / sequential round trips).
    expect(counts).toEqual({
      today: { queries: 5, serial: 1 },
      start: { queries: 2, serial: 2 },
      page: { queries: 1, serial: 1 },
      gradeNew: { queries: 3, serial: 3 },
      gradeLearning: { queries: 2, serial: 2 },
      finish: { queries: 2, serial: 2 },
    });
  });
});
