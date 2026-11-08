import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasChineseVoice, pickVoice, speak, speechRate, speechText, unlockAudio } from "./audio";
import { config } from "./config";

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

describe("speechRate", () => {
  it("slow replay is half the normal rate or less, so iOS's compressed range still hears it", () => {
    expect(speechRate()).toBe(config.audio.rate);
    expect(speechRate({ slow: false })).toBe(config.audio.rate);
    expect(speechRate({ slow: true })).toBe(config.audio.slowRate);
    expect(config.audio.slowRate).toBeLessThanOrEqual(config.audio.rate / 2);
    expect(config.audio.slowRate).toBeGreaterThanOrEqual(0.4);
  });
});

describe("speak in a browser", () => {
  class FakeUtterance {
    voice: unknown = null;
    lang = "";
    rate = 1;
    volume = 1;
    constructor(public text: string) {}
  }
  const events: string[] = [];
  const spoken: { text: string; rate: number; lang: string; voice: unknown }[] = [];
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => [{ name: "Tingting", lang: "zh-CN", localService: true }],
    addEventListener: () => {},
    cancel: () => void events.push("cancel"),
    speak: (u: FakeUtterance) => {
      events.push("speak");
      spoken.push({ text: u.text, rate: u.rate, lang: u.lang, voice: u.voice });
    },
  };

  beforeAll(() => {
    vi.stubGlobal("window", { speechSynthesis: synth });
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  });
  afterAll(() => vi.unstubAllGlobals());

  it("speaks a fresh utterance with voice, lang and rate set, cancelling only when busy", async () => {
    await speak("你好");
    await speak("你好", { slow: true });
    expect(events).toEqual(["speak", "speak"]);
    synth.speaking = true;
    await speak("你好", { slow: true });
    expect(events).toEqual(["speak", "speak", "cancel", "speak"]);
    expect(spoken.map((u) => u.rate)).toEqual([
      config.audio.rate,
      config.audio.slowRate,
      config.audio.slowRate,
    ]);
    expect(spoken.every((u) => u.lang === "zh-CN" && u.text === "你好")).toBe(true);
    expect(spoken[0]!.voice).toMatchObject({ name: "Tingting" });
  });
});
