import { describe, expect, it } from "vitest";
import { config } from "../config";
import { baseScore, effectiveScore, isLong, orderQueue, type ScoreInput } from "./queue";

const base: ScoreInput = {
  kind: "term",
  turnKind: null,
  heardAs: null,
  askedCount: 1,
  usefulness: null,
  tags: [],
  hanziKey: "泡打粉",
};

describe("baseScore", () => {
  it("weights the kind", () => {
    expect(baseScore(base)).toBe(1);
    expect(baseScore({ ...base, kind: "frame" })).toBe(3);
    expect(baseScore({ ...base, kind: "sentence" })).toBe(1);
  });

  it("weights the source turn", () => {
    expect(baseScore({ ...base, turnKind: "decode" })).toBe(4);
    expect(baseScore({ ...base, turnKind: "say" })).toBe(2);
    expect(baseScore({ ...base, turnKind: "errand" })).toBe(-1);
    expect(baseScore({ ...base, turnKind: "other" })).toBe(0);
  });

  it("adds heard_as, asking again, usefulness and core tags", () => {
    expect(baseScore({ ...base, heardAs: "podafen" })).toBe(3);
    expect(baseScore({ ...base, askedCount: 3 })).toBe(7);
    expect(baseScore({ ...base, usefulness: 5 })).toBe(3);
    expect(baseScore({ ...base, usefulness: 1 })).toBe(-1);
    expect(baseScore({ ...base, usefulness: 3 })).toBe(1);
    expect(baseScore({ ...base, tags: ["household", "feeding"] })).toBe(2);
    expect(baseScore({ ...base, tags: ["household"] })).toBe(1);
  });

  it("penalizes length beyond 12 key characters", () => {
    const key = "一二三四五六七八九十一二三四五"; // 15
    expect(baseScore({ ...base, hanziKey: key })).toBeCloseTo(1 - 0.2 * 3);
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
    expect(baseScore(p)).toBe(3 + 3 + 2 + 3 + 1 + 1);
  });

  it("uses the weights it is given", () => {
    const rank = { ...config.rank, heardAs: 10 };
    expect(baseScore({ ...base, heardAs: "x" }, rank)).toBe(11);
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
  it("decays 0.5 per week since last asked", () => {
    expect(effectiveScore({ baseScore: 4, lastAskedAt: NOW }, NOW)).toBe(4);
    expect(effectiveScore({ baseScore: 4, lastAskedAt: NOW - 2 * WEEK }, NOW)).toBe(3);
    expect(effectiveScore({ baseScore: 4, lastAskedAt: NOW - WEEK / 2 }, NOW)).toBe(3.75);
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
        entry("oldHigh", { baseScore: 5, lastAskedAt: NOW - 6 * WEEK }), // 2
        entry("fresh", { baseScore: 3 }), // 3
        entry("mid", { baseScore: 4, lastAskedAt: NOW - 2 * WEEK }), // 3, older createdAt
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
