// Neural TTS (DESIGN §6.1): SSML that pins every syllable to the card's displayed pinyin, and the
// content key a clip is stored under. Pure; the Azure call is lib/tts-azure.ts, storage
// lib/repo/tts.ts.
import { createHash } from "node:crypto";
import { config } from "../config";
import type { PinyinPairs } from "./pinyin";

const TONES: Record<string, [string, number]> = {
  ā: ["a", 1], á: ["a", 2], ǎ: ["a", 3], à: ["a", 4],
  ē: ["e", 1], é: ["e", 2], ě: ["e", 3], è: ["e", 4],
  ī: ["i", 1], í: ["i", 2], ǐ: ["i", 3], ì: ["i", 4],
  ō: ["o", 1], ó: ["o", 2], ǒ: ["o", 3], ò: ["o", 4],
  ū: ["u", 1], ú: ["u", 2], ǔ: ["u", 3], ù: ["u", 4],
  ǖ: ["v", 1], ǘ: ["v", 2], ǚ: ["v", 3], ǜ: ["v", 4],
  ü: ["v", 5],
  ń: ["n", 2], ň: ["n", 3], ǹ: ["n", 4], ḿ: ["m", 2],
}; // prettier-ignore

/**
 * A tone-marked syllable in Azure's `zh-CN` `sapi` phone set: letters, a space, the tone digit
 * (`zhǎng` → `zhang 3`, neutral `le` → `le 5`, `lǜ` → `lv 4`). Azure answers 400 to a phone it
 * doesn't know, so a bad reading fails loudly instead of being spoken wrong.
 */
export function toSapi(syllable: string): string {
  let tone = 5;
  let out = "";
  for (const c of syllable.normalize("NFC").toLowerCase()) {
    const t = TONES[c];
    if (t) {
      out += t[0];
      if (t[1] !== 5) tone = t[1];
    } else out += c;
  }
  return `${out} ${tone}`;
}

const esc = (s: string) =>
  s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

const SLOT = /(?:…|⋯|\.\.\.)+/gu;

/**
 * The SSML for one card part: every syllable pinned to `pairs` (the displayed pinyin, override
 * included, never the computed default: T1's first pass pinned cháng for 长了), non-hanzi as
 * plain text, the slot `…` as a short break. No `xmlns` on `<speak>`: Azure answers 400.
 */
export function speechSsml(pairs: PinyinPairs, opts: { voice: string }): string {
  let body = "";
  let text = "";
  const flush = () => {
    const parts = text.replace(/\s+/gu, " ").split(SLOT);
    body += parts.map(esc).join(`<break time="${config.audio.neural.breakMs}ms"/>`);
    text = "";
  };
  for (const [c, syllable] of pairs) {
    if (syllable === null) {
      text += c;
      continue;
    }
    flush();
    body += `<phoneme alphabet="sapi" ph="${esc(toSapi(syllable))}">${esc(c)}</phoneme>`;
  }
  flush();
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${esc(opts.voice)}">${body.trim()}</voice></speak>`;
}

/** A clip's key: sha256 of voice, output format and SSML. A changed reading gives a new key. */
export function clipKey(
  voice: string,
  ssml: string,
  format: string = config.audio.neural.outputFormat,
): string {
  return createHash("sha256").update(`${voice}\n${format}\n${ssml}`, "utf8").digest("hex");
}

/** Characters in the request, as F0 is assumed to count them (pins included, §6.1 *Cost*). */
export function ssmlChars(ssml: string): number {
  return Array.from(ssml).length;
}

export type SpeechPart = { kind: "phrase" } | { kind: "example"; index: number };

/** The route's `part`: `phrase` or `example-<n>` (n without leading zeros). */
export function parsePart(s: string): SpeechPart | null {
  if (s === "phrase") return { kind: "phrase" };
  const m = /^example-(0|[1-9]\d{0,2})$/u.exec(s);
  return m ? { kind: "example", index: Number(m[1]) } : null;
}

export const partName = (p: SpeechPart): string =>
  p.kind === "phrase" ? "phrase" : `example-${p.index}`;

/** The clip URL the round payload carries; `v` changes with the reading, so it can be cached. */
export function clipUrl(phraseId: string, part: SpeechPart, key: string): string {
  return `/api/tts/${encodeURIComponent(phraseId)}/${partName(part)}?v=${key.slice(0, 16)}`;
}
