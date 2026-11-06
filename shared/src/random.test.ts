import { describe, expect, it } from "vitest";
import { seededRandom, seededShuffle } from "./random";

describe("seeded randomness", () => {
  it("repeats for the same seed and differs for another", () => {
    const a = seededRandom("s1");
    const b = seededRandom("s1");
    const c = seededRandom("s2");
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect([c(), c(), c()]).not.toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  it("shuffles a copy: same items, reproducible order", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const s = seededShuffle(xs, "seed");
    expect(s).toEqual(seededShuffle(xs, "seed"));
    expect([...s].sort((x, y) => x - y)).toEqual(xs);
    expect(s).not.toEqual(xs);
    expect(xs[0]).toBe(0);
    expect(seededShuffle([], "x")).toEqual([]);
  });
});
