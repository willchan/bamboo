import { describe, expect, it } from "vitest";
import { config } from "../config";
import { computePinyin, displayPinyin } from "./pinyin";
import { clipKey, parsePart, speechSsml, toSapi } from "./tts";

const voice = config.audio.neural.voice;

describe("speechSsml (DESIGN §6.1)", () => {
  // The bug that started T2: the device voice said cháng for 长了 while the card showed zhǎng le.
  it("pins 长了 to the card's displayed zhǎng, not the computed default", () => {
    const shown = displayPinyin(computePinyin("长了"), [
      ["长", "zhǎng"],
      ["了", "le"],
    ]);
    const ssml = speechSsml(shown, { voice });
    expect(ssml).toContain('<phoneme alphabet="sapi" ph="zhang 3">长</phoneme>');
    expect(ssml).toContain('<phoneme alphabet="sapi" ph="le 5">了</phoneme>');
    expect(ssml).not.toContain("chang");
  });

  it("follows an override on any syllable, so the audio says what the card shows", () => {
    const shown = displayPinyin(computePinyin("我得走了"), [
      ["我", null],
      ["得", "děi"],
      ["走", null],
      ["了", null],
    ]);
    expect(speechSsml(shown, { voice })).toContain('ph="dei 3">得</phoneme>');
  });

  it("wraps in speak/voice without an xmlns (Azure answers 400 to one)", () => {
    const ssml = speechSsml([["你", "nǐ"]], { voice });
    expect(ssml).toBe(
      `<speak version="1.0" xml:lang="zh-CN"><voice name="${voice}"><phoneme alphabet="sapi" ph="ni 3">你</phoneme></voice></speak>`,
    );
    expect(ssml).not.toContain("xmlns");
  });

  it("keeps non-hanzi as escaped text and turns the slot … into a break", () => {
    const ssml = speechSsml(
      [
        ["要", "yào"],
        ["…", null],
        ["吗", "ma"],
        ["<", null],
        ["&", null],
      ],
      { voice },
    );
    expect(ssml).toContain(`<break time="${config.audio.neural.breakMs}ms"/>`);
    expect(ssml).toContain("&lt;&amp;");
    expect(ssml).not.toContain("…");
  });

  it("speaks a syllable-less hanzi (no reading) as plain text", () => {
    expect(speechSsml([["㐀", null]], { voice })).toContain(">㐀</voice>");
  });
});

describe("toSapi", () => {
  it("converts tone marks to a digit, the neutral tone to 5 and ü to v", () => {
    expect(toSapi("zhǎng")).toBe("zhang 3");
    expect(toSapi("le")).toBe("le 5");
    expect(toSapi("lǜ")).toBe("lv 4");
    expect(toSapi("nǚ")).toBe("nv 3");
    expect(toSapi("lüè")).toBe("lve 4");
    expect(toSapi("Ā")).toBe("a 1");
  });
});

describe("clipKey", () => {
  it("is a sha256 that changes with the reading or the voice", () => {
    const a = speechSsml([["长", "zhǎng"]], { voice });
    const b = speechSsml([["长", "cháng"]], { voice });
    expect(clipKey(voice, a)).toMatch(/^[0-9a-f]{64}$/u);
    expect(clipKey(voice, a)).toBe(clipKey(voice, a));
    expect(clipKey(voice, a)).not.toBe(clipKey(voice, b));
    expect(clipKey(voice, a)).not.toBe(clipKey("zh-CN-XiaoxiaoNeural", a));
  });
});

describe("parsePart", () => {
  it("takes phrase and example-<n> only", () => {
    expect(parsePart("phrase")).toEqual({ kind: "phrase" });
    expect(parsePart("example-0")).toEqual({ kind: "example", index: 0 });
    expect(parsePart("example-2")).toEqual({ kind: "example", index: 2 });
    expect(parsePart("example-")).toBeNull();
    expect(parsePart("example-01")).toBeNull();
    expect(parsePart("example--1")).toBeNull();
    expect(parsePart("slow")).toBeNull();
  });
});
