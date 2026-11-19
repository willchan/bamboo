// The card back's breakdown (DESIGN §5.5.4). Synthetic phrases only.
import { ExtractItem, PhraseBreakdown } from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { breakdownView, checkBreakdown } from "./breakdown";
import { computePinyin, displayPinyin, overrideFromEdits } from "./pinyin";
import { planMerge, validateExtraction, type ExistingPhrase } from "./queue";

const term = {
  parts: [
    { hanzi: "泡", gloss: "bubble" },
    { hanzi: "打", gloss: "beat" },
    { hanzi: "粉", gloss: "powder" },
  ],
  meaning: "baking powder",
};
const sentence = {
  parts: [
    { hanzi: "给", gloss: "for" },
    { hanzi: "宝宝", gloss: "baby" },
    { hanzi: "洗澡", gloss: "bathe" },
    { hanzi: "吧", gloss: "(suggestion)" },
  ],
  note: "给 + person + verb: do something for someone; 吧 softens it into a suggestion.",
};
const sentenceEnglish = { ...sentence, note: "Give + person + verb; the last word softens it." };

describe("checkBreakdown: the exact-match rule", () => {
  it("keeps a breakdown whose parts spell the phrase", () => {
    expect(checkBreakdown("term", "泡打粉", term)).toEqual({ breakdown: term, dropped: false });
  });

  it("ignores punctuation and spacing on either side", () => {
    const r = checkBreakdown("sentence", "给宝宝洗澡吧。", sentenceEnglish);
    expect(r.dropped).toBe(false);
    const spaced = {
      ...sentenceEnglish,
      parts: [{ hanzi: "给，", gloss: "for" }, ...sentenceEnglish.parts.slice(1)],
    };
    expect(checkBreakdown("sentence", "给 宝宝洗澡吧！", spaced).dropped).toBe(false);
  });

  it("drops a breakdown that doesn't match: missing, extra, reordered or changed characters", () => {
    const drop = { breakdown: null, dropped: true };
    expect(checkBreakdown("term", "泡打粉", { ...term, parts: term.parts.slice(0, 2) })).toEqual(
      drop,
    );
    expect(
      checkBreakdown("term", "泡打粉", {
        ...term,
        parts: [...term.parts, { hanzi: "了", gloss: "x" }],
      }),
    ).toEqual(drop);
    expect(
      checkBreakdown("term", "泡打粉", {
        ...term,
        parts: [term.parts[1]!, term.parts[0]!, term.parts[2]!],
      }),
    ).toEqual(drop);
    // A traditional character isn't the same character.
    expect(
      checkBreakdown("term", "泡打粉", {
        ...term,
        parts: [
          { hanzi: "泡", gloss: "a" },
          { hanzi: "打", gloss: "b" },
          { hanzi: "麵", gloss: "c" },
        ],
      }),
    ).toEqual(drop);
    // A part with no Chinese of its own.
    expect(
      checkBreakdown("term", "泡打粉", {
        ...term,
        parts: [...term.parts, { hanzi: "！", gloss: "x" }],
      }),
    ).toEqual(drop);
  });

  it("needs English-only glosses, meaning and note", () => {
    const zhGloss = {
      ...term,
      parts: [{ hanzi: "泡", gloss: "泡 bubble" }, ...term.parts.slice(1)],
    };
    expect(checkBreakdown("term", "泡打粉", zhGloss).dropped).toBe(true);
    expect(checkBreakdown("term", "泡打粉", { ...term, meaning: "发酵粉" }).dropped).toBe(true);
    // The fixture's note quotes 给 and 吧: Chinese in a note is dropped.
    expect(checkBreakdown("sentence", "给宝宝洗澡吧", sentence).dropped).toBe(true);
    expect(checkBreakdown("term", "泡打粉", { ...term, meaning: "   " }).dropped).toBe(true);
  });

  it("trims, and matches the shape to the kind; frames get none", () => {
    const padded = {
      ...term,
      parts: [{ hanzi: " 泡 ", gloss: " bubble " }, ...term.parts.slice(1)],
    };
    expect(checkBreakdown("term", "泡打粉", padded).breakdown?.parts[0]).toEqual({
      hanzi: "泡",
      gloss: "bubble",
    });
    expect(checkBreakdown("sentence", "泡打粉", term).dropped).toBe(true);
    expect(checkBreakdown("term", "给宝宝洗澡吧", sentenceEnglish).dropped).toBe(true);
    expect(checkBreakdown("frame", "泡打粉", term).dropped).toBe(true);
    expect(checkBreakdown("term", "泡打粉", null)).toEqual({ breakdown: null, dropped: false });
    expect(checkBreakdown("term", "泡打粉", undefined).dropped).toBe(false);
  });
});

describe("breakdownView: each part's pinyin from the phrase's displayed pinyin", () => {
  it("slices the computed pinyin per part, skipping punctuation", () => {
    // Expectations come from the computed pinyin itself: the dictionary (H1) may change readings.
    const py = computePinyin("给宝宝洗澡吧。");
    const v = breakdownView(sentenceEnglish, py);
    expect(v?.parts.map((p) => p.pinyin)).toEqual([
      py.slice(0, 1),
      py.slice(1, 3),
      py.slice(3, 5),
      py.slice(5, 6),
    ]);
    expect(v?.note).toBe(sentenceEnglish.note);
    expect(v?.meaning).toBeNull();
  });

  it("uses Will's override, so the breakdown always reads like the card", () => {
    const computed = computePinyin("泡打粉");
    const override = overrideFromEdits(computed, ["pāo", null, null]);
    const shown = displayPinyin(computed, override);
    const v = breakdownView(term, shown);
    expect(v?.parts[0]?.pinyin).toEqual([["泡", "pāo"]]);
    expect(v?.parts[1]?.pinyin).toEqual(computed.slice(1, 2));
    expect(v?.meaning).toBe("baking powder");
    expect(v?.note).toBeNull();
  });

  it("shows nothing when there's no breakdown or the pinyin no longer lines up", () => {
    expect(breakdownView(null, computePinyin("泡打粉"))).toBeNull();
    expect(breakdownView(term, computePinyin("泡打"))).toBeNull();
    expect(breakdownView(term, computePinyin("泡打粉了"))).toBeNull();
    expect(breakdownView(term, computePinyin("泡面粉"))).toBeNull();
  });
});

describe("validateExtraction and merges carry the breakdown", () => {
  const turn = { userText: "what is podafen", replyText: "泡打粉 (pào dǎ fěn) is baking powder." };
  const item = (breakdown: unknown) =>
    ExtractItem.parse({
      kind: "term",
      hanzi: "泡打粉",
      english: "baking powder",
      note: null,
      heard_as: null,
      example: null,
      usefulness: 4,
      tags: ["cooking"],
      breakdown,
    });

  it("keeps a matching breakdown and flags a mismatch", () => {
    const ok = validateExtraction(turn, { turn_kind: "decode", items: [item(term)] });
    expect(ok.items[0]?.breakdown).toEqual(term);
    expect(ok.breakdownsDropped).toBe(0);

    const bad = validateExtraction(turn, {
      turn_kind: "decode",
      items: [item({ ...term, parts: term.parts.slice(0, 1) })],
    });
    expect(bad.items[0]?.breakdown).toBeNull();
    expect(bad.items[0]?.flags).toContain("breakdown_dropped");
    expect(bad.breakdownsDropped).toBe(1);

    const none = validateExtraction(turn, { turn_kind: "decode", items: [item(undefined)] });
    expect(none.items[0]?.breakdown).toBeNull();
    expect(none.items[0]?.flags).not.toContain("breakdown_dropped");
  });

  it("a merge fills in a missing breakdown and keeps an existing one", () => {
    const p: ExistingPhrase = {
      status: "queued",
      kind: "term",
      hanziKey: "泡打粉",
      introducedAt: null,
      askedCount: 1,
      lastAskedImportId: "i1",
      heardAs: null,
      examples: [],
      usefulness: 4,
      turnKind: "decode",
      tags: [],
      flags: [],
    };
    const ctx = { importId: "i2", turnId: "t2", now: 1 };
    const v = { heardAs: null, example: null, flags: [], breakdown: term };
    expect(planMerge(p, v, ctx).patch.breakdown).toEqual(term);
    const other = { ...term, meaning: "leavening" };
    expect(planMerge({ ...p, breakdown: other }, v, ctx).patch.breakdown).toBeUndefined();
    expect(planMerge(p, { ...v, breakdown: null }, ctx).patch.breakdown).toBeUndefined();
  });
});

describe("PhraseBreakdown contract", () => {
  it("accepts both shapes and rejects pinyin-only or empty parts", () => {
    expect(PhraseBreakdown.safeParse(term).success).toBe(true);
    expect(PhraseBreakdown.safeParse(sentenceEnglish).success).toBe(true);
    expect(PhraseBreakdown.safeParse({ parts: [], meaning: "x" }).success).toBe(false);
    expect(PhraseBreakdown.safeParse({ parts: term.parts }).success).toBe(false);
    expect(ExtractItem.shape.breakdown.safeParse(null).success).toBe(true);
  });
});

describe("the synthetic seed's breakdowns", () => {
  it("all pass the exact-match rule (else the seeded shots would show none)", async () => {
    const { SEEDS } = await import("../../scripts/seed-data");
    const withBreakdown = SEEDS.filter((s) => s.breakdown);
    expect(withBreakdown.map((s) => s.kind).sort()).toEqual(["sentence", "term"]);
    for (const s of withBreakdown) {
      const r = checkBreakdown(s.kind, s.hanzi, s.breakdown);
      expect(r.dropped).toBe(false);
      expect(breakdownView(r.breakdown, computePinyin(s.hanzi))).not.toBeNull();
    }
  });
});
