import { describe, expect, it } from "vitest";
import { config } from "../config";
import {
  BUNDLED_MIN_ZIPF,
  bundledFrequencies,
  commonness,
  parseFrequencies,
  segment,
} from "./frequency";

const F = parseFrequencies("50\t我们 吃饭\n45\t宝宝 洗澡 了\n30\t奶瓶 吃\n20\t围兜\n\n10\t");

describe("parseFrequencies", () => {
  it("reads one line per tenth of a Zipf, keeping a word's first (highest) entry", () => {
    const f = parseFrequencies("50\t我们 宝宝\n40\t宝宝 辅食吃");
    expect(f.zipf.get("我们")).toBe(5);
    expect(f.zipf.get("宝宝")).toBe(5);
    expect(f.zipf.get("辅食吃")).toBe(4);
    expect(f.maxWordChars).toBe(3);
  });
});

describe("segment", () => {
  it("takes the longest listed word at each position, per run of hanzi", () => {
    expect(segment("我们吃饭了", F)).toEqual(["我们", "吃饭", "了"]);
    expect(segment("宝宝…洗澡", F)).toEqual(["宝宝", "洗澡"]);
    expect(segment("拍嗝", F)).toEqual(["拍", "嗝"]);
    expect(segment("abc", F)).toEqual([]);
  });
});

describe("commonness", () => {
  it("uses a listed phrase's own frequency", () => {
    expect(commonness("奶瓶", true, F)).toBe(3);
  });

  it("is the rarest part's frequency otherwise", () => {
    expect(commonness("宝宝洗澡了", false, F)).toBe(4.5);
    expect(commonness("宝宝吃围兜", false, F)).toBe(2);
    expect(commonness("宝宝吃嗝", false, F)).toBe(config.frequency.unknownZipf);
    // A term with a listed word in it, like 换尿布.
    expect(commonness("吃奶瓶", true, F)).toBe(3);
  });

  it("calls a term that only splits into single characters unknown", () => {
    expect(commonness("吃了", true, F)).toBe(config.frequency.unknownZipf);
    // A sentence of single listed characters is still as common as they are.
    expect(commonness("吃了", false, F)).toBe(3);
  });

  it("is null without hanzi", () => {
    expect(commonness("", true, F)).toBeNull();
    expect(commonness("ok", false, F)).toBeNull();
  });

  it("reads the bundled list (spoken Mandarin, Zipf ≥ 2)", () => {
    const b = bundledFrequencies();
    expect(b).toBe(bundledFrequencies());
    expect(b.zipf.size).toBeGreaterThan(100_000);
    expect(BUNDLED_MIN_ZIPF).toBe(2);
    expect(commonness("谢谢", true)).toBeGreaterThan(5);
    expect(commonness("奶瓶", true)).toBeGreaterThan(2.5);
    expect(commonness("奶瓶", true)).toBeLessThan(3.5);
  });
});
