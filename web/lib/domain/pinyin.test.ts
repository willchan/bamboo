import { describe, expect, it } from "vitest";
import type { PhraseExample } from "@bamboo/db";
import {
  applyExampleResults,
  computePinyin,
  displayPinyin,
  exampleNeedsPinyin,
  examplePinyin,
  pinyinJobInput,
  settleExample,
  storedExample,
  normalizeSyllable,
  overrideFromEdits,
  pinyinText,
  replyPinyin,
  repinyin,
} from "./pinyin";
import type { PinyinPairs } from "./pinyin";

const py = (s: string) => pinyinText(computePinyin(s));
const at = (s: string, char: string, nth = 0) =>
  computePinyin(s).filter(([c]) => c === char)[nth]?.[1];

describe("computePinyin", () => {
  it("aligns one syllable per character, null for non-hanzi", () => {
    expect(computePinyin("阿姨，您是说…吗？")).toEqual([
      ["阿", "ā"],
      ["姨", "yí"],
      ["，", null],
      ["您", "nín"],
      ["是", "shì"],
      ["说", "shuō"],
      ["…", null],
      ["吗", "ma"],
      ["？", null],
    ]);
    expect(computePinyin("买3个 OK")).toEqual([
      ["买", "mǎi"],
      ["3", null],
      ["个", "gè"],
      [" ", null],
      ["O", null],
      ["K", null],
    ]);
    expect(computePinyin("")).toEqual([]);
  });

  it("reads everyday neutral tones from the large dictionary", () => {
    expect(py("梯子")).toBe("tī zi");
    expect(py("肚子")).toBe("dù zi");
    expect(py("舒服")).toBe("shū fu");
    expect(py("里脊")).toBe("lǐ ji");
    expect(py("芝麻")).toBe("zhī ma");
    expect(py("宝宝的肚子不舒服")).toBe("bǎo bao de dù zi bù shū fu");
    expect(py("阿姨买了里脊和芝麻。")).toBe("ā yí mǎi le lǐ ji hé zhī ma");
    expect(py("把梯子拿过来")).toBe("bǎ tī zi ná guò lái");
  });

  it("applies tone sandhi to 一 and 不 only", () => {
    expect(at("一个", "一")).toBe("yí");
    expect(at("一天", "一")).toBe("yì");
    expect(at("第一", "一")).toBe("yī");
    expect(at("不是", "不")).toBe("bú");
    expect(at("不好", "不")).toBe("bù");
    // No third-tone sandhi: 你好 stays nǐ hǎo.
    expect(py("你好")).toBe("nǐ hǎo");
  });

  it("works on example sentences", () => {
    expect(py("我们买一瓶泡打粉。")).toBe("wǒ men mǎi yì píng pào dǎ fěn");
    expect(py("明白了，谢谢")).toBe("míng bai le xiè xie");
  });
});

describe("normalizeSyllable", () => {
  it("tidies typed syllables", () => {
    expect(normalizeSyllable(" DEI3 ")).toBe("děi");
    expect(normalizeSyllable("de5")).toBe("de");
    expect(normalizeSyllable("de0")).toBe("de");
    expect(normalizeSyllable("lv4")).toBe("lǜ");
    expect(normalizeSyllable("nu:3")).toBe("nǚ");
    expect(normalizeSyllable("zhǎng")).toBe("zhǎng");
    expect(normalizeSyllable("   ")).toBeNull();
  });
});

describe("overrides", () => {
  // 得 here is the modal děi, which the dictionary alone reads dé: Will's override fixes it.
  const computed = computePinyin("我得走");

  it("stores nothing when the edits match the computed pinyin", () => {
    expect(overrideFromEdits(computed, ["wǒ", "dé", ""])).toBeNull();
    expect(overrideFromEdits(computed, [])).toBeNull();
  });

  it("stores only the changed syllables", () => {
    const override = overrideFromEdits(computed, ["", "dei3", null]);
    expect(override).toEqual([
      ["我", null],
      ["得", "děi"],
      ["走", null],
    ]);
    expect(pinyinText(displayPinyin(computed, override))).toBe("wǒ děi zǒu");
  });

  it("ignores edits on non-hanzi positions", () => {
    const c = computePinyin("好！");
    expect(overrideFromEdits(c, ["", "x"])).toBeNull();
  });

  it("is ignored for display when it no longer lines up", () => {
    const stale: [string, string | null][] = [["他", "tā"]];
    expect(displayPinyin(computed, stale)).toBe(computed);
    expect(displayPinyin(computed, null)).toBe(computed);
  });

  it("keeps the override when the hanzi is unchanged and drops it when it changes", () => {
    const override = overrideFromEdits(computed, ["", "děi", ""]);
    expect(repinyin({ hanzi: "我得走", pinyinOverride: override }, "我得走")).toEqual({
      pinyin: computed,
      pinyinOverride: override,
      overrideDropped: false,
    });
    const changed = repinyin({ hanzi: "我得走", pinyinOverride: override }, "我得走了");
    expect(changed.pinyinOverride).toBeNull();
    expect(changed.overrideDropped).toBe(true);
    expect(repinyin({ hanzi: "我", pinyinOverride: null }, "你").overrideDropped).toBe(false);
    expect(repinyin(null, "你").pinyin).toEqual([["你", "nǐ"]]);
  });
});

describe("replyPinyin", () => {
  it("spaces syllables like pinyinText and keeps a frame's slot as …", () => {
    expect(replyPinyin(computePinyin("高压锅"))).toBe("gāo yā guō");
    expect(replyPinyin(computePinyin("阿姨，您是说…吗？"))).toBe("ā yí nín shì shuō … ma");
    expect(replyPinyin(computePinyin("您是说...吗"))).toBe("nín shì shuō … ma");
    expect(replyPinyin(computePinyin("…⋯是什么"))).toBe("… shì shén me");
    expect(replyPinyin([])).toBe("");
  });
});

describe("examplePinyin", () => {
  // Synthetic: the dictionary reads 倒 dǎo; the merge settled the phrase 倒过来 on dào.
  const phrase = "倒过来";
  const merged: PinyinPairs = [
    ["倒", "dào"],
    ["过", "guò"],
    ["来", "lái"],
  ];

  it("gives the phrase's settled reading to every occurrence of its hanzi", () => {
    expect(pinyinText(examplePinyin("别把杯子倒过来。", phrase, merged))).toBe(
      "bié bǎ bēi zi dào guò lái",
    );
    expect(pinyinText(examplePinyin("倒过来再倒过来", phrase, merged))).toBe(
      "dào guò lái zài dào guò lái",
    );
  });

  it("carries Will's override through to the examples", () => {
    const computed = computePinyin("我得走");
    const shown = displayPinyin(computed, overrideFromEdits(computed, ["", "děi", ""]));
    expect(pinyinText(examplePinyin("我得走了。", "我得走", shown))).toBe("wǒ děi zǒu le");
  });

  it("keeps the sentence's own reading where nothing settled the phrase's", () => {
    // 不 alone is bù, but before a fourth tone the sentence reads bú: context wins there.
    expect(pinyinText(examplePinyin("不对", "不", computePinyin("不")))).toBe("bú duì");
  });

  it("stays fully computed when the example doesn't contain the hanzi", () => {
    expect(examplePinyin("别动", phrase, merged)).toEqual(computePinyin("别动"));
    expect(examplePinyin("别动", "", [])).toEqual(computePinyin("别动"));
  });

  it("ignores a phrase reading that doesn't line up with its hanzi", () => {
    expect(examplePinyin("倒过来", phrase, [["倒", "dào"]])).toEqual(computePinyin("倒过来"));
  });
});

// §10 #107: examples store their own merged reading (extract_turn.v8), and the card uses it.
describe("example pinyin, merged per syllable", () => {
  // Synthetic: the dictionary reads 得 dé in 我得走了。, Gemini reads děi (both valid).
  const ex = "我得走了。";
  const disputed = ["wǒ", "děi", "zǒu", "le"];

  it("settles an example like a phrase: agree, invalid, dispute, none", () => {
    const agree = settleExample({ hanzi: ex, english: null }, ["wǒ", "dé", "zǒu", "le"]);
    expect(agree.pinyin_sources).toEqual([]);
    expect(pinyinText(agree.pinyin!)).toBe("wǒ dé zǒu le");
    expect(exampleNeedsPinyin(agree)).toBe(false);

    const invalid = settleExample({ hanzi: ex, english: null }, ["wǒ", "dài", "zǒu", "le"]);
    expect(invalid.pinyin_sources).toEqual([
      expect.objectContaining({ rule: "invalid", chosen: "dé" }),
    ]);
    expect(pinyinText(invalid.pinyin!)).toBe("wǒ dé zǒu le");

    const dispute = settleExample({ hanzi: ex, english: null }, disputed);
    expect(dispute.pinyin_sources).toEqual([expect.objectContaining({ rule: "pending" })]);
    expect(exampleNeedsPinyin(dispute)).toBe(true);

    const referee = settleExample({ hanzi: ex, english: null }, disputed, new Map([[1, "děi"]]));
    expect(pinyinText(referee.pinyin!)).toBe("wǒ děi zǒu le");

    // No reading, or one that doesn't line up: nothing stored, and stale fields go.
    for (const g of [null, ["wǒ"]]) {
      const none = settleExample({ hanzi: ex, english: null, pinyin: [["x", "y"]] }, g);
      expect(none).toEqual({ hanzi: ex, english: null });
      expect(exampleNeedsPinyin(none)).toBe(true);
    }
  });

  it("the card uses the stored reading, then the phrase's settled reading on top", () => {
    const stored = settleExample({ hanzi: ex, english: null }, disputed, new Map([[1, "děi"]]));
    expect(pinyinText(examplePinyin(stored, "走", computePinyin("走")))).toBe("wǒ děi zǒu le");
    // Inside the phrase's span, the phrase's settled syllable still wins (§10 #106).
    const shown: PinyinPairs = [
      ["得", "de"],
      ["走", "zǒu"],
    ];
    expect(pinyinText(examplePinyin(stored, "得走", shown))).toBe("wǒ de zǒu le");
    // A stored reading that no longer lines up with the hanzi (Will edited it) is ignored.
    const edited = { hanzi: "我得走吧。", pinyin: stored.pinyin };
    expect(examplePinyin(edited, "走", computePinyin("走"))).toEqual(computePinyin("我得走吧。"));
    // Older examples have none: computed, as before.
    expect(examplePinyin({ hanzi: ex }, "走", computePinyin("走"))).toEqual(computePinyin(ex));
  });

  it("a pinyin job carries the examples that need it, with pending readings", () => {
    const settled = settleExample({ hanzi: "走吧", english: null }, ["zǒu", "ba"]);
    const pending = settleExample({ hanzi: ex, english: null }, disputed);
    const examples = [settled, pending, { hanzi: "快走", english: null }];
    const input = pinyinJobInput({ id: "p1", hanzi: "走", examples }, null, {
      phraseSettled: true,
      backfill: true,
      exampleGemini: new Map([[ex, disputed]]),
    });
    expect(input).toMatchObject({
      context: ["走吧", ex, "快走"],
      phrase_settled: true,
      backfill: true,
    });
    expect(input.examples!.map((e) => [e.index, e.hanzi, e.gemini])).toEqual([
      [1, ex, disputed],
      [2, "快走", null],
    ]);
    expect(input.examples![0]!.slots[1]).toMatchObject({
      char: "得",
      readings: ["dé", "děi", "de"],
    });
    expect(pinyinJobInput({ id: "p1", hanzi: "走", examples: [] }, null)).not.toHaveProperty(
      "phrase_settled",
    );
  });

  it("applies a job's results to the examples still in place", () => {
    const current: PhraseExample[] = [
      { hanzi: ex, english: "I must go.", turn_id: "t1" },
      { hanzi: "快走", english: null, turn_id: null },
    ];
    const input = pinyinJobInput({ id: "p1", hanzi: "走", examples: current }, null);
    const r = applyExampleResults(
      [...current.slice(0, 1), { hanzi: "慢走", english: null, turn_id: null }],
      input,
      {
        examples: [
          { index: 0, gemini: disputed, referee: [{ index: 1, reading: "děi" }] },
          { index: 1, gemini: ["kuài", "zǒu"], referee: [] },
        ],
      },
    );
    expect(r.changed).toBe(true);
    expect(r.examples[0]).toMatchObject({ english: "I must go.", turn_id: "t1" });
    expect(pinyinText(r.examples[0]!.pinyin!)).toBe("wǒ děi zǒu le");
    expect(r.examples[0]!.pinyin_sources).toEqual([
      expect.objectContaining({ rule: "referee", winner: "gemini" }),
    ]);
    // Will changed the second example since the job was queued: left alone.
    expect(r.examples[1]).toEqual({ hanzi: "慢走", english: null, turn_id: null });
    expect(r.settled.map((x) => x.index)).toEqual([0]);

    // An unanswered dispute is final (rejected); a misaligned reading still counts as checked.
    const unanswered = applyExampleResults(current, input, {
      examples: [
        { index: 0, gemini: disputed, referee: [] },
        { index: 1, gemini: ["kuài"], referee: [] },
      ],
    });
    expect(unanswered.examples[0]!.pinyin_sources).toEqual([
      expect.objectContaining({ rule: "rejected", chosen: "dé" }),
    ]);
    expect(unanswered.examples[1]!.pinyin_sources).toEqual([]);
    // An older worker's result (no examples) settles them on the dictionary reading.
    expect(applyExampleResults(current, { examples: undefined }, {}).changed).toBe(false);
  });

  it("repinyin keeps an example's referee choice and recomputes the rest", () => {
    const e = settleExample(
      { hanzi: ex, english: null, turn_id: null },
      disputed,
      new Map([[1, "děi"]]),
    );
    const stale = { ...e, pinyin: e.pinyin!.map(([c]) => [c, "x"] as [string, string]) };
    expect(storedExample(stale as PhraseExample)).toEqual(e);
    const old: PhraseExample = { hanzi: ex, english: null, turn_id: null };
    expect(storedExample(old)).toBe(old);
  });
});
