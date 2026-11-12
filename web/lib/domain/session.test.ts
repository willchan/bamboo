import { describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { dayStart, nextDayStart } from "./day";
import { State } from "./fsrs";
import {
  askedAgainCards,
  buildRound,
  interleave,
  introducedSince,
  isFirstSight,
  reinsertIndex,
  seededShuffle,
  siblingsToBury,
  todayStatus,
  workload,
  type RoundState,
  type SchedCard,
} from "./session";

// These cases were written for a cap of 3 new cards a day; the rules don't depend on the value
// (`newPerDay` is 5 since DESIGN §10 #63), so the file keeps 3.
vi.mock("../config", async (importOriginal) => {
  const m = await importOriginal<typeof import("../config")>();
  return { ...m, config: { ...m.config, session: { ...m.config.session, newPerDay: 3 } } };
});

const LA = { timeZone: "America/Los_Angeles" };
// 21:00 PDT, 2026-06-01.
const NOW = new Date("2026-06-02T04:00:00Z").getTime();
const DAY_END = nextDayStart(NOW, LA);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let n = 0;
const card = (o: Partial<SchedCard> = {}): SchedCard => {
  n += 1;
  return {
    id: `c${n}`,
    phraseId: `p${n}`,
    type: "say",
    state: State.Review,
    due: NOW - DAY,
    buriedUntil: null,
    ...o,
  };
};
const review = (dueOffset: number, o: Partial<SchedCard> = {}) =>
  card({ state: State.Review, due: NOW + dueOffset, ...o });
const fresh = (o: Partial<SchedCard> = {}) => card({ state: State.New, due: NOW - DAY, ...o });
const queued = (...cards: SchedCard[]) => cards.map((c) => ({ phraseId: c.phraseId, cards: [c] }));

const state = (o: Partial<RoundState> = {}): RoundState => ({
  activeCards: [],
  queue: [],
  introducedToday: 0,
  ...o,
});
const ids = (slots: { cardId: string }[]) => slots.map((s) => s.cardId);
const kinds = (slots: { kind: string }[]) => slots.map((s) => s.kind[0]).join("");

describe("buildRound", () => {
  it("is empty when there is nothing to do", () => {
    expect(buildRound(NOW, state(), { dayEnd: DAY_END })).toEqual([]);
  });

  it("orders learning cards first, then review cards most overdue first", () => {
    const r1 = review(-1 * DAY);
    const r2 = review(-5 * DAY);
    const r3 = review(+2 * HOUR); // due later today
    const l1 = card({ state: State.Learning, due: NOW - MIN });
    const l2 = card({ state: State.Relearning, due: NOW - 5 * MIN });
    const round = buildRound(NOW, state({ activeCards: [r1, r2, r3, l1, l2] }), {
      dayEnd: DAY_END,
    });
    expect(ids(round).slice(0, 2).sort()).toEqual([l1.id, l2.id].sort());
    expect(ids(round).slice(2)).toEqual([r2.id, r1.id, r3.id]);
    expect(kinds(round)).toBe("llrrr");
  });

  it("varies the order of learning cards from round to round (§10 #57)", () => {
    // Will's evening: three cards rated Good in one round, all on their 10-minute step, graded
    // a few seconds apart. By due alone the first one graded led every next round.
    const learning = [0, 1, 2].map((i) =>
      card({ state: State.Learning, due: NOW + 10 * MIN + i * 15_000 }),
    );
    const leaders = new Map<string, number>();
    for (let k = 0; k < 300; k++) {
      const now = NOW + k * 37_000;
      const round = buildRound(now, state({ activeCards: learning }), { dayEnd: DAY_END });
      expect(ids(round).sort()).toEqual(learning.map((c) => c.id).sort());
      leaders.set(round[0]!.cardId, (leaders.get(round[0]!.cardId) ?? 0) + 1);
    }
    expect(leaders.size).toBe(3);
    for (const count of leaders.values()) expect(count).toBeGreaterThan(50);
  });

  it("orders learning cards the same way for the same seed, and keeps due before new", () => {
    const learning = Array.from({ length: 4 }, () => card({ state: State.Learning, due: NOW }));
    const st = state({ activeCards: learning, queue: queued(fresh()) });
    const a = buildRound(NOW, st, { dayEnd: DAY_END, seed: 7 });
    expect(buildRound(NOW + MIN, st, { dayEnd: DAY_END, seed: 7 })).toEqual(a);
    expect(kinds(a)).toBe("llnll");
  });

  it("keeps the earliest-due learning cards when there are more than fit", () => {
    const learning = Array.from({ length: 12 }, (_, i) =>
      card({ state: State.Learning, due: NOW - (i + 1) * MIN }),
    );
    const round = buildRound(NOW, state({ activeCards: learning }), { dayEnd: DAY_END });
    expect(ids(round).sort()).toEqual(
      learning
        .slice(2)
        .map((c) => c.id)
        .sort(),
    );
  });

  it("leaves out review cards due tomorrow and learning steps not yet due", () => {
    const tomorrow = review(DAY_END - NOW + MIN);
    const learningLater = card({ state: State.Learning, due: NOW + HOUR });
    const learningSoon = card({ state: State.Learning, due: NOW + 10 * MIN }); // learn-ahead
    const round = buildRound(NOW, state({ activeCards: [tomorrow, learningLater, learningSoon] }), {
      dayEnd: DAY_END,
    });
    expect(ids(round)).toEqual([learningSoon.id]);
  });

  it("caps a round at roundSize, due cards first", () => {
    const due = Array.from({ length: 12 }, (_, i) => review(-(i + 1) * HOUR));
    const round = buildRound(NOW, state({ activeCards: due, queue: queued(fresh(), fresh()) }), {
      dayEnd: DAY_END,
    });
    expect(round).toHaveLength(config.session.roundSize);
    expect(round.every((s) => s.kind === "review")).toBe(true);
  });

  it("interleaves new cards roughly one per 3 cards", () => {
    const due = Array.from({ length: 6 }, (_, i) => review(-(i + 1) * HOUR));
    const round = buildRound(
      NOW,
      state({ activeCards: due, queue: queued(fresh(), fresh(), fresh(), fresh()) }),
      { dayEnd: DAY_END },
    );
    expect(kinds(round)).toBe("rrnrrnrrn");
  });

  it("appends new cards when there are too few due cards to interleave", () => {
    const round = buildRound(
      NOW,
      state({ activeCards: [review(-HOUR)], queue: queued(fresh(), fresh(), fresh()) }),
      { dayEnd: DAY_END },
    );
    expect(kinds(round)).toBe("rnnn".slice(0, 4));
  });

  it("takes new cards from the queue in queue order, one card per phrase", () => {
    const a1 = fresh({ phraseId: "A", type: "listen" });
    const a2 = fresh({ phraseId: "A", type: "say" });
    const b1 = fresh({ phraseId: "B" });
    const round = buildRound(
      NOW,
      state({
        queue: [
          { phraseId: "A", cards: [a1, a2] },
          { phraseId: "B", cards: [b1] },
        ],
      }),
      { dayEnd: DAY_END },
    );
    expect(ids(round)).toEqual([a1.id, b1.id]);
  });

  it("introduces the second card of an active phrase before queued phrases", () => {
    const second = fresh({ phraseId: "active" });
    const q = fresh();
    const round = buildRound(NOW, state({ activeCards: [second], queue: queued(q) }), {
      dayEnd: DAY_END,
    });
    expect(ids(round)).toEqual([second.id, q.id]);
  });

  describe("the new-card cap across rounds", () => {
    const queue = queued(fresh(), fresh(), fresh(), fresh(), fresh());

    it("allows newPerDay new cards on a fresh day", () => {
      expect(buildRound(NOW, state({ queue }), { dayEnd: DAY_END })).toHaveLength(3);
    });

    it("subtracts the new cards already introduced today", () => {
      expect(
        buildRound(NOW, state({ queue, introducedToday: 2 }), { dayEnd: DAY_END }),
      ).toHaveLength(1);
      expect(buildRound(NOW, state({ queue, introducedToday: 3 }), { dayEnd: DAY_END })).toEqual(
        [],
      );
      expect(buildRound(NOW, state({ queue, introducedToday: 5 }), { dayEnd: DAY_END })).toEqual(
        [],
      );
    });

    it("counts only today's introductions (from review logs, at the 04:00 boundary)", () => {
      const start = dayStart(NOW, LA);
      const logs = [
        { stateBefore: State.New, reviewedAt: start - 1 }, // 03:59: yesterday
        { stateBefore: State.New, reviewedAt: start },
        { stateBefore: State.New, reviewedAt: NOW - MIN },
        { stateBefore: State.Review, reviewedAt: NOW - MIN }, // not a new card
      ];
      expect(introducedSince(logs, start)).toBe(2);
    });

    it("respects a custom session config", () => {
      const session = { ...config.session, newPerDay: 1 };
      expect(buildRound(NOW, state({ queue }), { dayEnd: DAY_END, session })).toHaveLength(1);
    });
  });

  describe("Learn more (extra new cards beyond the cap)", () => {
    const queue = queued(fresh(), fresh(), fresh(), fresh(), fresh());
    const opts = { dayEnd: DAY_END, learnMore: true };

    it("adds extraNewBatch new cards once today's cap is used up", () => {
      const slots = buildRound(NOW, state({ queue, introducedToday: 3 }), opts);
      expect(kinds(slots)).toBe("nnn");
      expect(ids(slots)).toEqual(queue.slice(0, 3).map((q) => q.cards[0]!.id));
    });

    it("can be repeated: the batch doesn't depend on how many extra were learned", () => {
      expect(buildRound(NOW, state({ queue, introducedToday: 7 }), opts)).toHaveLength(3);
    });

    it("adds nothing while the daily cap still has room (a normal round)", () => {
      expect(buildRound(NOW, state({ queue, introducedToday: 1 }), opts)).toHaveLength(2);
      expect(buildRound(NOW, state({ queue }), opts)).toHaveLength(3);
    });

    it("is limited by what's waiting", () => {
      const short = queued(fresh(), fresh());
      expect(buildRound(NOW, state({ queue: short, introducedToday: 3 }), opts)).toHaveLength(2);
    });

    it("keeps due cards, and reserves room for the new cards in a full round", () => {
      const due = Array.from({ length: 12 }, (_, i) => review(-DAY + i * MIN));
      const slots = buildRound(NOW, state({ activeCards: due, queue, introducedToday: 3 }), opts);
      expect(slots).toHaveLength(config.session.roundSize);
      expect(kinds(slots)).toBe("rrnrrnrrnr");
      // The most overdue due cards stay.
      expect(slots.filter((x) => x.kind === "review").map((x) => x.cardId)).toEqual(
        due.slice(0, 7).map((c) => c.id),
      );
    });

    it("respects a custom batch size", () => {
      const session = { ...config.session, extraNewBatch: 1 };
      expect(
        buildRound(NOW, state({ queue, introducedToday: 3 }), { ...opts, session }),
      ).toHaveLength(1);
    });
  });

  describe("sibling burying", () => {
    it("skips buried cards until the bury ends", () => {
      const buried = review(-HOUR, { buriedUntil: DAY_END });
      const freshBuried = fresh({ phraseId: "Q", buriedUntil: DAY_END });
      const st = state({ activeCards: [buried], queue: [{ phraseId: "Q", cards: [freshBuried] }] });
      expect(buildRound(NOW, st, { dayEnd: DAY_END })).toEqual([]);
      expect(ids(buildRound(DAY_END, st, { dayEnd: DAY_END + DAY }))).toEqual([
        buried.id,
        freshBuried.id,
      ]);
    });

    it("never puts two cards of one phrase in a round", () => {
      const say = review(-2 * HOUR, { phraseId: "P", type: "say" });
      const listen = review(-HOUR, { phraseId: "P", type: "listen" });
      const newSibling = fresh({ phraseId: "P" });
      const round = buildRound(NOW, state({ activeCards: [say, listen, newSibling] }), {
        dayEnd: DAY_END,
      });
      expect(ids(round)).toEqual([say.id]);
    });

    it("buries the other cards of a phrase once one is shown, except mid-learning ones", () => {
      const shown = fresh({ phraseId: "P" });
      const sibling = fresh({ phraseId: "P" });
      const learning = card({ phraseId: "P", state: State.Learning });
      expect(siblingsToBury([shown, sibling, learning], shown.id)).toEqual([sibling.id]);
    });
  });
});

describe("interleave", () => {
  it("places a new item at every nth position", () => {
    expect(interleave(["1", "2", "3", "4"], ["a", "b"], 3).join("")).toBe("12a34b");
    expect(interleave<string>([], ["a", "b"], 3).join("")).toBe("ab");
    expect(interleave(["1", "2"], [], 3).join("")).toBe("12");
  });
});

describe("Again within a round", () => {
  const s = { ...config.session, secondsPerCard: 15 };

  it("re-inserts after its learning step when that falls inside the round", () => {
    // 1 minute ≈ 4 cards at 15 s each.
    expect(reinsertIndex(6, MIN, s)).toBe(4);
    expect(reinsertIndex(4, MIN, s)).toBe(4);
  });

  it("waits for the next round or day otherwise", () => {
    expect(reinsertIndex(3, MIN, s)).toBeNull();
    expect(reinsertIndex(9, 10 * MIN, s)).toBeNull();
    expect(reinsertIndex(0, 0, s)).toBeNull();
  });

  it("never re-inserts immediately", () => {
    expect(reinsertIndex(5, 0, s)).toBe(1);
  });
});

describe("workload and done-for-today", () => {
  it("counts due and new for Today", () => {
    const st = state({
      activeCards: [review(-HOUR), card({ state: State.Learning, due: NOW })],
      queue: queued(fresh(), fresh(), fresh(), fresh()),
      introducedToday: 1,
    });
    expect(workload(NOW, st, { dayEnd: DAY_END })).toEqual({
      due: 2,
      newAvailable: 2,
      roundCards: 4,
      learnMore: 0,
    });
  });

  it("offers Learn more once the cap is used up and new phrases are waiting", () => {
    const queue = queued(fresh(), fresh(), fresh(), fresh());
    const w = workload(NOW, state({ queue, introducedToday: 3 }), { dayEnd: DAY_END });
    expect(w).toEqual({ due: 0, newAvailable: 0, roundCards: 0, learnMore: 3 });
    // Fewer waiting than a batch: offer what's there.
    const two = workload(NOW, state({ queue: queued(fresh(), fresh()), introducedToday: 4 }), {
      dayEnd: DAY_END,
    });
    expect(two.learnMore).toBe(2);
  });

  it("doesn't offer Learn more with nothing waiting or while the cap has room", () => {
    expect(workload(NOW, state({ introducedToday: 3 }), { dayEnd: DAY_END }).learnMore).toBe(0);
    const queue = queued(fresh(), fresh());
    expect(workload(NOW, state({ queue, introducedToday: 2 }), { dayEnd: DAY_END }).learnMore).toBe(
      0,
    );
  });

  it("asks to start when no round is finished and there is something to do", () => {
    const w = { due: 3, newAvailable: 1, roundCards: 4, learnMore: 0 };
    expect(todayStatus(false, w)).toEqual({ kind: "start", workload: w });
  });

  it("is done for today with nothing due and the new cap used up", () => {
    const w = { due: 0, newAvailable: 0, roundCards: 0, learnMore: 3 };
    expect(todayStatus(false, w)).toEqual({ kind: "done", another: null });
    expect(todayStatus(true, w)).toEqual({ kind: "done", another: null });
  });

  it("is done for today with an empty queue and nothing due", () => {
    const w = workload(NOW, state({ introducedToday: 1 }), { dayEnd: DAY_END });
    expect(todayStatus(false, w)).toEqual({ kind: "done", another: null });
  });

  it("offers another round after a finished round when more is waiting", () => {
    const w = { due: 4, newAvailable: 0, roundCards: 4, learnMore: 3 };
    expect(todayStatus(true, w)).toEqual({ kind: "done", another: w });
  });
});

describe("first sight", () => {
  it("offers Not useful / Already know only on a new card", () => {
    expect(isFirstSight({ state: State.New })).toBe(true);
    expect(isFirstSight({ state: State.Learning })).toBe(false);
    expect(isFirstSight({ state: State.Review })).toBe(false);
  });
});

describe("asked again", () => {
  const cards = [
    { id: "say", reps: 3 },
    { id: "listen", reps: 0 },
  ];

  it("grades Again every reviewed card of an active phrase", () => {
    expect(askedAgainCards({ status: "active" }, cards, false)).toEqual(["say"]);
  });

  it("applies at most once per phrase per import", () => {
    expect(askedAgainCards({ status: "active" }, cards, true)).toEqual([]);
  });

  it("does nothing for phrases that aren't active", () => {
    for (const status of ["queued", "dropped", "expired"]) {
      expect(askedAgainCards({ status }, cards, false)).toEqual([]);
    }
  });
});

describe("seededShuffle", () => {
  it("is a permutation, deterministic per seed", () => {
    const xs = [1, 2, 3, 4, 5, 6];
    const a = seededShuffle(xs, 42);
    expect([...a].sort()).toEqual(xs);
    expect(seededShuffle(xs, 42)).toEqual(a);
    expect(xs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seededShuffle([], 1)).toEqual([]);
  });
});
