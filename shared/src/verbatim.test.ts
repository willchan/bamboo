import { describe, expect, it } from "vitest";
import { cleanHanzi, occursVerbatim, turnTextKey } from "./verbatim";

describe("verbatim check (DESIGN §4.6; web/lib/domain/queue.test.ts has the engine cases)", () => {
  const key = turnTextKey({
    userText: "what is gaoyaguo",
    replyText: "用高压锅煮汤，\n二十分钟。",
  });

  it("matches copied hanzi across punctuation and line breaks", () => {
    expect(occursVerbatim("高压锅", "term", key)).toBe(true);
    expect(occursVerbatim("煮汤二十分钟", "sentence", key)).toBe(true);
    expect(occursVerbatim("电饭锅", "term", key)).toBe(false);
    expect(occursVerbatim("gaoyaguo", "term", key)).toBe(false);
  });

  it("treats a frame's slot as a wildcard, in order", () => {
    expect(occursVerbatim("用…煮汤", "frame", key)).toBe(true);
    expect(occursVerbatim("煮汤…用", "frame", key)).toBe(false);
    expect(occursVerbatim("用…煮汤", "sentence", key)).toBe(false);
  });

  it("cleans hanzi onto one line", () => {
    expect(cleanHanzi(" 高压\n锅 ")).toBe("高压 锅");
  });
});
