import { describe, expect, it } from "vitest";
import {
  computePinyin,
  displayPinyin,
  examplePinyin,
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
