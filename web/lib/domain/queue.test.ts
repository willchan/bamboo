import { describe, expect, it } from "vitest";
import { config } from "../config";
import { parseFrequencies } from "./frequency";
import {
  baseScore,
  effectiveScore,
  frequencyPoints,
  isLong,
  orderQueue,
  rescored,
  type ScoreInput,
} from "./queue";

// A stand-in word list, so the weights are tested apart from the bundled data: 宝宝 is common
// (Zipf 4.5), 泡打粉 at the pivot (3.5), 围兜 rare (2.0); anything else is unknown (1.5).
const FREQ = parseFrequencies("45\t宝宝 洗澡\n35\t泡打粉 高压锅\n20\t围兜");

const base: ScoreInput = {
  kind: "term",
  turnKind: null,
  heardAs: null,
  askedCount: 1,
  usefulness: null,
  tags: [],
  hanziKey: "泡打粉",
};
const score = (o: Partial<ScoreInput>) => baseScore({ ...base, ...o }, config.rank, FREQ);

describe("baseScore", () => {
  it("weights the kind", () => {
    expect(score({})).toBe(1);
    expect(score({ kind: "frame" })).toBe(2);
    expect(score({ kind: "sentence" })).toBe(1);
  });

  it("weights the source turn", () => {
    expect(score({ turnKind: "decode" })).toBe(3);
    expect(score({ turnKind: "say" })).toBe(2);
    expect(score({ turnKind: "errand" })).toBe(-2);
    expect(score({ turnKind: "other" })).toBe(0);
  });

  it("adds heard_as, asking again and usefulness", () => {
    expect(score({ heardAs: "podafen" })).toBe(2);
    expect(score({ askedCount: 3 })).toBe(7);
    expect(score({ usefulness: 5 })).toBe(4);
    expect(score({ usefulness: 1 })).toBe(-2);
    expect(score({ usefulness: 3 })).toBe(1);
  });

  it("adds how common the phrase's words are, clamped", () => {
    expect(score({ hanziKey: "宝宝" })).toBe(1 + 1.5 * 1);
    expect(score({ hanziKey: "围兜" })).toBe(1 - 1.5 * 1.5);
    // Unknown (Zipf 1.5): 2 below the pivot, the clamp.
    expect(score({ hanziKey: "拍嗝" })).toBe(1 - 1.5 * 2);
    // Tags no longer score by themselves …
    expect(score({ tags: ["household", "food"] })).toBe(1);
    // … but baby, feeding and toddler words aren't penalized for rarity.
    expect(score({ hanziKey: "拍嗝", tags: ["baby"] })).toBe(1);
    expect(score({ hanziKey: "宝宝", tags: ["baby"] })).toBe(2.5);
  });

  it("penalizes length beyond 12 key characters", () => {
    const key = "宝宝".repeat(7) + "洗澡"; // 16, all common
    expect(score({ hanziKey: key, kind: "sentence" })).toBeCloseTo(1 + 1.5 - 0.2 * 4);
  });

  it("combines everything (DESIGN §4.6 formula)", () => {
    const p: ScoreInput = {
      kind: "frame",
      turnKind: "decode",
      heardAs: "gaoyaguo",
      askedCount: 2,
      usefulness: 4,
      tags: ["food"],
      hanziKey: "高压锅",
    };
    expect(baseScore(p, config.rank, FREQ)).toBe(2 + 2 + 1 + 3 + 1.5 + 0);
  });

  it("uses the weights it is given", () => {
    const rank = { ...config.rank, heardAs: 10 };
    expect(baseScore({ ...base, heardAs: "x" }, rank, FREQ)).toBe(11);
  });

  it("scores with the bundled word list by default", () => {
    // 不要 is everyday Mandarin (Zipf 5.7): the clamp's full +2.
    expect(frequencyPoints({ kind: "term", tags: [], hanziKey: "不要" })).toBe(3);
    expect(baseScore({ ...base, hanziKey: "不要" })).toBe(4);
  });

  it("gives no frequency points without hanzi", () => {
    expect(frequencyPoints({ kind: "term", tags: [], hanziKey: "abc" }, config.rank, FREQ)).toBe(0);
  });
});

describe("rescored", () => {
  it("returns only phrases whose stored score is out of date", () => {
    const fresh = { ...base, id: "a", baseScore: 1 };
    const stale = { ...base, id: "b", hanziKey: "宝宝", baseScore: 9 };
    expect(rescored([fresh, stale], config.rank, FREQ)).toEqual([{ id: "b", baseScore: 2.5 }]);
  });
});

describe("isLong", () => {
  it("flags keys over 20 characters", () => {
    expect(isLong("一".repeat(20))).toBe(false);
    expect(isLong("一".repeat(21))).toBe(true);
  });
});

const WEEK = 7 * 24 * 3600 * 1000;
const NOW = new Date("2026-06-01T12:00:00Z").getTime();

describe("effectiveScore", () => {
  it("decays 0.25 per week since last asked", () => {
    expect(effectiveScore({ baseScore: 4, lastAskedAt: NOW }, NOW)).toBe(4);
    expect(effectiveScore({ baseScore: 4, lastAskedAt: NOW - 2 * WEEK }, NOW)).toBe(3.5);
    expect(effectiveScore({ baseScore: 4, lastAskedAt: NOW - WEEK / 2 }, NOW)).toBe(3.88);
    // A future timestamp never boosts.
    expect(effectiveScore({ baseScore: 4, lastAskedAt: NOW + WEEK }, NOW)).toBe(4);
  });
});

describe("orderQueue", () => {
  const entry = (id: string, o: Partial<Parameters<typeof orderQueue>[0][number]> = {}) => ({
    id,
    pinned: false,
    pinnedAt: null,
    baseScore: 1,
    lastAskedAt: NOW,
    createdAt: NOW,
    ...o,
  });

  it("puts pinned first, newest pin first", () => {
    const order = orderQueue(
      [
        entry("high", { baseScore: 9 }),
        entry("pinOld", { pinned: true, pinnedAt: NOW - 1000, baseScore: 0 }),
        entry("pinNew", { pinned: true, pinnedAt: NOW, baseScore: -5 }),
      ],
      NOW,
    );
    expect(order.map((e) => e.id)).toEqual(["pinNew", "pinOld", "high"]);
    expect(order.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("then sorts by effective score, so age decay can reorder", () => {
    const order = orderQueue(
      [
        entry("oldHigh", { baseScore: 5, lastAskedAt: NOW - 12 * WEEK }), // 2
        entry("fresh", { baseScore: 3 }), // 3
        entry("mid", { baseScore: 4, lastAskedAt: NOW - 4 * WEEK }), // 3, older createdAt
      ],
      NOW,
    );
    expect(order.map((e) => [e.id, e.effectiveScore])).toEqual([
      ["fresh", 3],
      ["mid", 3],
      ["oldHigh", 2],
    ]);
  });

  it("breaks ties by newest", () => {
    const order = orderQueue(
      [entry("older", { createdAt: NOW - 10 }), entry("newer", { createdAt: NOW })],
      NOW,
    );
    expect(order.map((e) => e.id)).toEqual(["newer", "older"]);
  });

  it("orders pins with a missing pin time last among pins", () => {
    const order = orderQueue(
      [entry("a", { pinned: true, pinnedAt: null }), entry("b", { pinned: true, pinnedAt: 5 })],
      NOW,
    );
    expect(order.map((e) => e.id)).toEqual(["b", "a"]);
  });
});
