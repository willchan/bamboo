import { describe, expect, it } from "vitest";
import { hanziKey, hasHanzi, normalizeText, RADICAL_MAP, strayRadicals } from "./text";

describe("normalizeText", () => {
  it("maps Kangxi radical lookalikes through NFKC", () => {
    // ⺟ is CJK Radicals Supplement (explicitly mapped below if NFKC skips it); the rest are Kangxi.
    expect(normalizeText("⽉⼀⼉⽤⾼")).toBe("月一儿用高");
  });

  it("maps the CJK Radicals Supplement characters NFKC leaves alone", () => {
    expect(normalizeText("⻄⻋⻓⻛⻥⻧")).toBe("西车长风鱼麦");
    for (const [from, to] of Object.entries(RADICAL_MAP)) {
      expect(normalizeText(from)).toBe(to);
    }
  });

  it("normalizes ⺟ (seen in exports) to 母", () => {
    expect(normalizeText("⺟乳")).toBe("母乳");
  });

  it("keeps Chinese punctuation, including the frame slot", () => {
    expect(normalizeText("阿姨，您是说…吗？")).toBe("阿姨，您是说…吗？");
    expect(normalizeText("（小心）！：；～")).toBe("（小心）！：；～");
  });

  it("folds full-width letters and digits to ASCII", () => {
    expect(normalizeText("ＯＫ３个")).toBe("OK3个");
  });

  it("collapses whitespace inside lines and trims, keeping line breaks", () => {
    expect(normalizeText("  你好 \t  世界  \r\n  第二行  \n\n第三行 ")).toBe(
      "你好 世界\n第二行\n\n第三行",
    );
    expect(normalizeText("宝宝　睡了")).toBe("宝宝 睡了");
  });

  it("leaves ligature-damaged English alone", () => {
    expect(normalizeText("Simpli!ed bo#le")).toBe("Simpli!ed bo#le");
  });
});

describe("strayRadicals", () => {
  it("reports radicals left after normalization", () => {
    // U+2E81 ⺁ is in the supplement block, has no NFKC mapping and isn't in our table.
    expect(strayRadicals(normalizeText("⺁⺁好"))).toEqual(["⺁"]);
    expect(strayRadicals(normalizeText("⻄好"))).toEqual([]);
  });
});

describe("hanziKey", () => {
  it("keeps only ideographs, ASCII letters and digits, lowercased", () => {
    expect(hanziKey("阿姨，您是说…吗？")).toBe("阿姨您是说吗");
    expect(hanziKey("  买 3 瓶 Ｍilk! ")).toBe("买3瓶milk");
  });

  it("agrees across radical damage, so dedupe works on PDF text", () => {
    expect(hanziKey("⺟乳")).toBe(hanziKey("母乳"));
    expect(hanziKey("⻄⽠")).toBe(hanziKey("西瓜"));
  });

  it("is empty for text with nothing to keep", () => {
    expect(hanziKey("，。！…")).toBe("");
  });
});

describe("hasHanzi", () => {
  it("detects ideographs", () => {
    expect(hasHanzi("podafen")).toBe(false);
    expect(hasHanzi("say 泡打粉")).toBe(true);
  });
});
