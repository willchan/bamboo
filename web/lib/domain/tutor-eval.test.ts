import { describe, expect, it } from "vitest";
import { isEvalCandidate, sampleEvalTurns } from "./tutor-eval";

// Synthetic: import i1 has 10 turns, i2 has 2, i3 has 1.
const cands = [
  ...Array.from({ length: 10 }, (_, n) => ({ id: `t1-${n}`, importId: "i1" })),
  { id: "t2-0", importId: "i2" },
  { id: "t2-1", importId: "i2" },
  { id: "t3-0", importId: "i3" },
];

describe("sampleEvalTurns", () => {
  it("is deterministic for a seed and independent of input order", () => {
    const a = sampleEvalTurns(cands, 6, "s");
    expect(sampleEvalTurns([...cands].reverse(), 6, "s")).toEqual(a);
    expect(new Set(a).size).toBe(6);
    const others = ["a", "b", "c", "d"].map((s) => sampleEvalTurns(cands, 6, s).join());
    expect(new Set([a.join(), ...others]).size).toBeGreaterThan(1);
  });

  it("spreads across imports: every import appears before any repeats", () => {
    const s = sampleEvalTurns(cands, 3, "x");
    expect(new Set(s.map((id) => id.slice(0, 2)))).toEqual(new Set(["t1", "t2", "t3"]));
    const five = sampleEvalTurns(cands, 5, "x");
    expect(five.filter((id) => id.startsWith("t2"))).toHaveLength(2);
    expect(five.filter((id) => id.startsWith("t3"))).toHaveLength(1);
  });

  it("returns everything when the pool is smaller than the limit, and nothing from nothing", () => {
    expect(sampleEvalTurns(cands, 50, "x").sort()).toEqual(cands.map((c) => c.id).sort());
    expect(sampleEvalTurns([], 5, "x")).toEqual([]);
  });

  it("skips image-only and answerless turns", () => {
    expect(isEvalCandidate({ userText: "How do I say X?", replyText: "你好" })).toBe(true);
    expect(isEvalCandidate({ userText: "  ", replyText: "你好" })).toBe(false);
    expect(isEvalCandidate({ userText: "Q", replyText: "" })).toBe(false);
  });
});
