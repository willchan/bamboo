import { describe, expect, it } from "vitest";
import { DROP_FIELDS, atReplyCap, sumRerunEvents } from "./backfill";

describe("sumRerunEvents", () => {
  it("is all zeros for no events", () => {
    const s = sumRerunEvents([]);
    expect(s).toMatchObject({ turns: 0, items_per_turn: [], items: 0, kept: 0, models: {} });
    expect(Object.keys(s.dropped)).toEqual([...DROP_FIELDS]);
    expect(Object.values(s.dropped).every((v) => v === 0)).toBe(true);
  });

  it("sums re-runs only, per turn and by model, ignoring missing or bad fields", () => {
    const s = sumRerunEvents([
      {
        reextract: true,
        model: "gemini-3.8-flash",
        items: 5,
        kept: 3,
        dropped_over_cap: 1,
        dropped_not_verbatim: 1,
        phrases_created: 2,
        phrases_refreshed: 1,
        phrases_dropped: 1,
        phrases_reported: 0,
        pinyin_jobs: 1,
        pinyin_misaligned: 1,
      },
      { reextract: false, items: 9, kept: 9 },
      {
        reextract: true,
        model: "qwen3.8:27b",
        items: 2,
        kept: 3,
        sentence_promoted: 1,
        dropped_name: 1,
        phrases_reported: 1,
        pinyin_jobs: 2,
      },
      { reextract: true, items: -1, kept: 1.5, model: "" },
    ]);
    expect(s).toMatchObject({
      turns: 3,
      items_per_turn: [5, 2, 0],
      items: 7,
      kept: 6,
      sentence_promoted: 1,
      phrases_created: 2,
      phrases_refreshed: 1,
      phrases_dropped: 1,
      phrases_reported: 1,
      pinyin_jobs_queued: 3,
      pinyin_misaligned: 1,
      models: { "gemini-3.8-flash": 1, "qwen3.8:27b": 1, unknown: 1 },
    });
    expect(s.dropped).toMatchObject({
      dropped_over_cap: 1,
      dropped_not_verbatim: 1,
      dropped_name: 1,
      dropped_frame: 0,
    });
  });
});

describe("atReplyCap", () => {
  it("counts UTF-16 code units, as the import's slice did", () => {
    expect(atReplyCap("好".repeat(4), 4)).toBe(true);
    expect(atReplyCap("好".repeat(3), 4)).toBe(false);
    // One astral character is two code units.
    expect(atReplyCap("😀好好", 4)).toBe(true);
  });
});
