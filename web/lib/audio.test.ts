import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  hasChineseVoice,
  pickVoice,
  resetAudioForTest,
  say,
  silentMp3,
  speak,
  speechRate,
  speechText,
  unlockAudio,
} from "./audio";
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
  it("slow replay is about a third of the normal rate, so iOS's compressed range still hears it", () => {
    expect(speechRate()).toBe(config.audio.rate);
    expect(speechRate({ slow: false })).toBe(config.audio.rate);
    expect(speechRate({ slow: true })).toBe(config.audio.slowRate);
    // 0.45 (half) was better on an iPhone but still not slow enough (DESIGN §10 #60).
    expect(config.audio.slowRate).toBeLessThanOrEqual(0.3);
    expect(config.audio.slowRate).toBeGreaterThan(0);
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

describe("silentMp3", () => {
  it("is whole MPEG-1 Layer III frames, each starting with a sync header", () => {
    const b = silentMp3(2);
    expect(b.length).toBe(834);
    expect([...b.slice(0, 4)]).toEqual([0xff, 0xfb, 0x90, 0xc0]);
    expect([...b.slice(417, 421)]).toEqual([0xff, 0xfb, 0x90, 0xc0]);
  });
});

// DESIGN §6.1 *Playback*: the clip on one reused <audio>, Web Speech when it fails.
describe("say in a browser", () => {
  const spoken: { text: string; rate: number }[] = [];
  const beacons: string[] = [];
  let playResult: "ok" | "fail" | "hang" = "ok";
  class FakeAudio {
    src = "";
    preload = "";
    currentTime = 0;
    playbackRate = 1;
    defaultPlaybackRate = 1;
    preservesPitch = false;
    played: { src: string; rate: number }[] = [];
    pause() {}
    play() {
      this.played.push({ src: this.src, rate: this.playbackRate });
      if (playResult === "ok") return Promise.resolve();
      if (playResult === "fail") return Promise.reject(new Error("NotSupportedError"));
      return new Promise<void>(() => {});
    }
  }
  const audios: FakeAudio[] = [];
  let now = 1_000_000;

  beforeAll(() => {
    vi.stubGlobal("window", {
      speechSynthesis: {
        speaking: false,
        pending: false,
        getVoices: () => [{ name: "Tingting", lang: "zh-CN" }],
        addEventListener: () => {},
        cancel: () => {},
        speak: (u: { text: string; rate: number }) => void spoken.push(u),
      },
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        rate = 1;
        lang = "";
        volume = 1;
        voice: unknown = null;
        constructor(public text: string) {}
      },
    );
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor() {
          super();
          audios.push(this);
        }
      },
    );
    vi.stubGlobal("location", { href: "https://bamboo.test/review/r1", pathname: "/review/r1" });
    vi.stubGlobal("navigator", {
      onLine: true,
      sendBeacon: (_url: string, body: Blob) => {
        void body.text().then((t) => beacons.push(t));
        return true;
      },
    });
    vi.spyOn(Date, "now").mockImplementation(() => now);
    resetAudioForTest();
  });
  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetAudioForTest();
  });

  it("plays the clip, slow at the neural slow rate, without speaking", async () => {
    await say("长了", { clip: "/api/tts/p1/phrase?v=abc" });
    await say("长了", { clip: "/api/tts/p1/phrase?v=abc", slow: true });
    const el = audios[0]!;
    expect(el.played).toEqual([
      { src: "https://bamboo.test/api/tts/p1/phrase?v=abc", rate: 1 },
      { src: "https://bamboo.test/api/tts/p1/phrase?v=abc", rate: config.audio.neural.slowRate },
    ]);
    expect(el.preservesPitch).toBe(true);
    expect(spoken).toHaveLength(0);
  });

  it("without a clip, speaks with Web Speech", async () => {
    await say("你好");
    expect(spoken.map((u) => u.text)).toEqual(["你好"]);
  });

  it("falls back to Web Speech on a failed clip, reports it, and skips clips for a while", async () => {
    spoken.length = 0;
    playResult = "fail";
    await say("长了", { clip: "/api/tts/p1/phrase?v=abc", slow: true });
    expect(spoken).toEqual([
      expect.objectContaining({ text: "长了", rate: config.audio.slowRate }),
    ]);
    await vi.waitFor(() => expect(beacons).toHaveLength(1));
    expect(JSON.parse(beacons[0]!)).toMatchObject({ where: "tts_fallback", kind: "server" });

    // Within the cooldown, straight to Web Speech (airplane mode: no wait per card).
    const before = audios[0]!.played.length;
    playResult = "ok";
    await say("你好", { clip: "/api/tts/p2/phrase?v=def" });
    expect(audios[0]!.played.length).toBe(before);
    expect(spoken.at(-1)!.text).toBe("你好");

    now += config.audio.neural.failCooldownMs;
    await say("你好", { clip: "/api/tts/p2/phrase?v=def" });
    expect(audios[0]!.played.length).toBe(before + 1);
  });

  it("falls back when no audio starts within the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      now += config.audio.neural.failCooldownMs;
      spoken.length = 0;
      playResult = "hang";
      const p = say("你好", { clip: "/api/tts/p3/phrase?v=ghi" });
      await vi.advanceTimersByTimeAsync(config.audio.neural.timeoutMs);
      await p;
      expect(spoken.map((u) => u.text)).toEqual(["你好"]);
    } finally {
      vi.useRealTimers();
      playResult = "ok";
    }
  });

  it("unlock plays a silent clip on the shared element and ignores its abort", async () => {
    playResult = "fail";
    unlockAudio();
    expect(audios[0]!.played.at(-1)!.src).toMatch(/^data:audio\/mpeg;base64,/u);
    playResult = "ok";
  });
});
