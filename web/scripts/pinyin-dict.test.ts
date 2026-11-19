// pinyin-dict: the committed trimmed dictionary is exactly what the generator produces, and the
// trim keeps only entries that change pinyin-pro's built-in reading.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUT, generate, serializeDict, trimDict } from "./pinyin-dict";

describe("pinyin-dict generator", () => {
  it("keeps only entries whose reading differs from the built-in one", () => {
    const trimmed = trimDict({ 你好: ["nǐ hǎo", 1e-9], 梯子: ["tī zi", 1e-9], 肚子: "dù zi" });
    expect(trimmed).toEqual({ 梯子: ["tī zi", 1e-9], 肚子: "dù zi" });
    expect(serializeDict(trimmed)).toBe('{\n"梯子":["tī zi",1e-9],\n"肚子":"dù zi"\n}\n');
  });

  it("reproduces the committed data file byte for byte", () => {
    expect(generate() === readFileSync(OUT, "utf8")).toBe(true);
  });
});
