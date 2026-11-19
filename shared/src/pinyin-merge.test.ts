import { describe, expect, it } from "vitest";
import type { PinyinSlot } from "./contracts/jobs";
import {
  alignGemini,
  applySources,
  disputedSlots,
  mergeReading,
  neutralTone,
  normalizeModelSyllable,
  refereeOptions,
} from "./pinyin-merge";

// Synthetic slots, as the engine builds them from pinyin-pro (computed + `multiple: true`).
const slot = (char: string, computed: string | null, readings: string[] = []): PinyinSlot => ({
  char,
  computed,
  readings: computed ? [...new Set([computed, ...readings])] : [],
});
// 我得走了。 computed: wǒ dé zǒu le
const WODE = [
  slot("我", "wǒ"),
  slot("得", "dé", ["děi", "de"]),
  slot("走", "zǒu"),
  slot("了", "le", ["liǎo"]),
  slot("。", null),
];

describe("syllables", () => {
  it("normalizes tone numbers, v and case", () => {
    expect(normalizeModelSyllable("Dei3")).toBe("děi");
    expect(normalizeModelSyllable("de5")).toBe("de");
    expect(normalizeModelSyllable("lv4")).toBe("lǜ");
    expect(normalizeModelSyllable("hao3")).toBe("hǎo");
    expect(normalizeModelSyllable("gou3")).toBe("gǒu");
    expect(normalizeModelSyllable("gui4")).toBe("guì");
    expect(normalizeModelSyllable("wǒ ")).toBe("wǒ");
    expect(normalizeModelSyllable("wo-men")).toBeNull();
  });
  it("neutral tone strips marks but keeps ü", () => {
    expect(neutralTone("zǐ")).toBe("zi");
    expect(neutralTone("lǜ")).toBe("lü");
  });
  it("aligns one syllable per hanzi, else null", () => {
    expect(alignGemini(WODE, ["wǒ", "děi", "zǒu", "le"])).toEqual(["wǒ", "děi", "zǒu", "le", null]);
    expect(alignGemini(WODE, ["wǒ děi", "zǒu", "le"])).toEqual(["wǒ", "děi", "zǒu", "le", null]);
    expect(alignGemini(WODE, ["wǒ", "děi", "zǒule"])).toBeNull();
    expect(alignGemini(WODE, null)).toBeNull();
  });
});

describe("the merge's four rules (DESIGN §5.5.3b)", () => {
  it("1. agreement is accepted, with no sources", () => {
    const m = mergeReading(WODE, ["wo3", "dé", "zǒu", "le"]);
    expect(m.readings).toEqual(["wǒ", "dé", "zǒu", "le", null]);
    expect(m.sources).toEqual([]);
    expect(disputedSlots(WODE, m.aligned)).toEqual([]);
  });

  it("2. a reading that isn't valid for the character loses to the computed one, no referee", () => {
    const m = mergeReading(WODE, ["wǒ", "dài", "zǒu", "le"]);
    expect(m.readings[1]).toBe("dé");
    expect(m.sources).toEqual([
      {
        i: 1,
        char: "得",
        computed: "dé",
        gemini: "dài",
        chosen: "dé",
        rule: "invalid",
        winner: "computed",
      },
    ]);
    expect(m.pending).toEqual([]);
    expect(disputedSlots(WODE, m.aligned)).toEqual([]);
  });

  it("3. both valid → pending until the referee; its choice must be a valid reading or neutral", () => {
    const g = ["wǒ", "děi", "zǒu", "le"];
    const pending = mergeReading(WODE, g);
    expect(pending.pending).toEqual([1]);
    expect(pending.readings[1]).toBe("dé");
    expect(disputedSlots(WODE, alignGemini(WODE, g))).toEqual([1]);

    const won = mergeReading(WODE, g, new Map([[1, "dei3"]]));
    expect(won.readings[1]).toBe("děi");
    expect(won.sources[0]).toMatchObject({ rule: "referee", winner: "gemini", chosen: "děi" });

    const kept = mergeReading(WODE, g, new Map([[1, "dé"]]));
    expect(kept.sources[0]).toMatchObject({ rule: "referee", winner: "computed" });

    const third = mergeReading(WODE, g, new Map([[1, "de"]]));
    expect(third.readings[1]).toBe("de");
    expect(third.sources[0]).toMatchObject({ rule: "referee", winner: "other" });

    const off = mergeReading(WODE, g, new Map([[1, "dāi"]]));
    expect(off.readings[1]).toBe("dé");
    expect(off.sources[0]).toMatchObject({ rule: "rejected", winner: "computed" });

    const unanswered = mergeReading(WODE, g, new Map(), { final: true });
    expect(unanswered.sources[0]).toMatchObject({ rule: "rejected" });
    expect(unanswered.pending).toEqual([]);
  });

  it("the referee may pick the neutral tone even when the dictionary lists none", () => {
    const tizi = [slot("梯", "tī"), slot("子", "zǐ")];
    expect(refereeOptions(tizi[1]!)).toEqual(["zǐ", "zi"]);
    // Gemini's neutral tone alone isn't a valid reading (rule 2): no referee call for it.
    expect(mergeReading(tizi, ["tī", "zi"]).sources[0]).toMatchObject({ rule: "invalid" });
  });

  it("Gemini's citation tone on 一/不 agrees with the computed sandhi", () => {
    const s = [slot("一", "yí"), slot("个", "gè")];
    expect(mergeReading(s, ["yī", "gè"]).sources).toEqual([]);
  });

  it("4. stored choices survive a recompute only while still valid (Will's override is applied on display)", () => {
    const g = ["wǒ", "děi", "zǒu", "le"];
    const { sources } = mergeReading(WODE, g, new Map([[1, "děi"]]));
    expect(applySources(WODE, sources)).toEqual(["wǒ", "děi", "zǒu", "le", null]);
    const changed = [...WODE];
    changed[1] = slot("得", "dé", ["de"]); // the dictionary no longer lists děi
    expect(applySources(changed, sources)[1]).toBe("dé");
    expect(applySources(WODE, null)[1]).toBe("dé");
  });
});
