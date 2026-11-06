import { describe, expect, it } from "vitest";
import { hasChineseVoice, pickVoice, speak, speechText, unlockAudio } from "./audio";

describe("pickVoice", () => {
  const v = (name: string, lang: string, localService = true) => ({ name, lang, localService });

  it("prefers an enhanced zh-CN voice", () => {
    const voices = [
      v("Samantha", "en-US"),
      v("Meijia", "zh-TW"),
      v("Tingting", "zh-CN"),
      v("Tingting (Enhanced)", "zh-CN"),
    ];
    expect(pickVoice(voices)?.name).toBe("Tingting (Enhanced)");
  });

  it("takes any zh-CN voice over other Chinese voices", () => {
    expect(pickVoice([v("Meijia (Premium)", "zh-TW"), v("Lili", "zh_CN")])?.name).toBe("Lili");
  });

  it("falls back to Taiwan Mandarin but never Cantonese", () => {
    expect(pickVoice([v("Sinji", "zh-HK"), v("Meijia", "zh-TW")])?.name).toBe("Meijia");
    expect(pickVoice([v("Sinji", "zh-HK"), v("Samantha", "en-US")])).toBeNull();
    expect(pickVoice([])).toBeNull();
  });
});

describe("speechText", () => {
  it("turns the frame slot into a pause", () => {
    expect(speechText("阿姨，您是说…吗？")).toBe("阿姨，您是说，吗？");
    expect(speechText("要 ... 吗")).toBe("要 ， 吗");
  });
});

describe("outside a browser", () => {
  it("does nothing and reports no voice", async () => {
    unlockAudio();
    await speak("你好");
    expect(await hasChineseVoice()).toBe(false);
  });
});
