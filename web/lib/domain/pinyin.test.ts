import { describe, expect, it } from "vitest";
import {
  computePinyin,
  displayPinyin,
  normalizeSyllable,
  overrideFromEdits,
  pinyinText,
  repinyin,
} from "./pinyin";

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

  it("reads 得 by context: structural de, modal děi, and the word dé", () => {
    expect(at("你跑得很快", "得")).toBe("de");
    expect(at("宝宝睡得很好", "得")).toBe("de");
    expect(at("说得好", "得")).toBe("de");
    expect(at("我得走了", "得")).toBe("děi");
    expect(at("我们得给宝宝洗澡", "得")).toBe("děi");
    expect(at("你还得去", "得")).toBe("děi");
    expect(at("得到", "得")).toBe("dé");
    expect(at("你得到了", "得")).toBe("dé");
    expect(at("获得很多", "得")).toBe("dé");
    expect(at("不得不", "得")).toBe("dé");
  });

  it("reads 行 by context", () => {
    expect(at("银行", "行")).toBe("háng");
    expect(at("不行", "行")).toBe("xíng");
    expect(py("行不行")).toBe("xíng bù xíng");
  });

  it("reads 长 by context: cháng (long) vs zhǎng (grow)", () => {
    expect(at("很长", "长")).toBe("cháng");
    expect(at("头发很长", "长")).toBe("cháng");
    expect(at("长大了", "长")).toBe("zhǎng");
    expect(at("长高了", "长")).toBe("zhǎng");
    expect(at("宝宝在长牙", "长")).toBe("zhǎng");
    expect(at("她长得很像你", "长")).toBe("zhǎng");
    expect(at("她长得很像你", "得")).toBe("de");
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
    expect(py("我们得买一瓶泡打粉。")).toBe("wǒ men děi mǎi yì píng pào dǎ fěn");
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
  const computed = computePinyin("我得走");

  it("stores nothing when the edits match the computed pinyin", () => {
    expect(overrideFromEdits(computed, ["wǒ", "děi", ""])).toBeNull();
    expect(overrideFromEdits(computed, [])).toBeNull();
  });

  it("stores only the changed syllables", () => {
    const override = overrideFromEdits(computed, ["", "de2", null]);
    expect(override).toEqual([
      ["我", null],
      ["得", "dé"],
      ["走", null],
    ]);
    expect(pinyinText(displayPinyin(computed, override))).toBe("wǒ dé zǒu");
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
    const override = overrideFromEdits(computed, ["", "dé", ""]);
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
