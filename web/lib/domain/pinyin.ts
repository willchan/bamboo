// Pinyin (DESIGN §4.2, §5.5.3): always computed from the characters, never taken from an LLM.
// pinyin-pro with tone marks, aligned per character, with tone sandhi shown only for 一/不. It
// loads pinyin-pro's large dictionary (`@pinyin-pro/data/complete`), trimmed by
// `scripts/pinyin-dict.ts` to the entries that change a reading, which fixes everyday neutral tones
// (梯子, 肚子, 舒服, 里脊, 芝麻). No context rules: polyphones are settled by H4's per-syllable merge,
// and Will's overrides win.
import { addDict, convert, pinyin } from "pinyin-pro";
import type { PinyinPairs } from "@bamboo/db";
import largeDict from "../data/pinyin-dict.json";

export type { PinyinPairs };

addDict(largeDict, "bamboo-large");

const HANZI = /\p{Script=Han}/u;
const isHanzi = (c: string | undefined): c is string => !!c && HANZI.test(c);

/** Per-character pinyin with tone marks; `null` for anything that isn't hanzi. */
export function computePinyin(hanzi: string): PinyinPairs {
  const chars = Array.from(hanzi);
  if (chars.length === 0) return [];
  const all = pinyin(hanzi, { type: "all", toneSandhi: true });
  // pinyin-pro returns one item per character; fall back to per-character lookups if it ever
  // groups differently, so alignment never drifts.
  const aligned =
    all.length === chars.length && all.every((a, i) => a.origin === chars[i])
      ? all.map((a) => (a.isZh && a.pinyin ? a.pinyin : null))
      : chars.map((c) => (isHanzi(c) ? pinyin(c) || null : null));

  return chars.map((c, i) => [c, isHanzi(c) ? (aligned[i] ?? null) : null]);
}

/** What to display: the computed pinyin with Will's overrides on top (same alignment). */
export function displayPinyin(computed: PinyinPairs, override: PinyinPairs | null): PinyinPairs {
  if (!override || !sameChars(computed, override)) return computed;
  return computed.map(([c, s], i) => [c, override[i]?.[1] ?? s]);
}

function sameChars(a: PinyinPairs, b: PinyinPairs): boolean {
  return a.length === b.length && a.every(([c], i) => b[i]?.[0] === c);
}

/**
 * Tidy a syllable Will typed: trim, lowercase, `u:`/`v` → `ü`, and tone numbers to marks
 * (`dei3` → `děi`, `de5`/`de0` → `de`). Empty → null (use the computed reading).
 */
export function normalizeSyllable(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/u:|v/gu, "ü");
  if (!s) return null;
  if (/^[a-zü]+[0-5]$/u.test(s)) {
    s = /[05]$/u.test(s) ? s.slice(0, -1) : convert(s);
  }
  return s;
}

/**
 * Build the stored override from the editor's syllable inputs (one per character, aligned with
 * `computed`). Only hanzi positions can be overridden. Returns null when nothing differs from the
 * computed pinyin, so an untouched editor stores no override.
 */
export function overrideFromEdits(
  computed: PinyinPairs,
  edits: readonly (string | null | undefined)[],
): PinyinPairs | null {
  let changed = false;
  const result: PinyinPairs = computed.map(([c, s], i) => {
    if (s === null) return [c, null];
    const edit = normalizeSyllable(edits[i] ?? "");
    if (edit === null || edit === s) return [c, null];
    changed = true;
    return [c, edit];
  });
  return changed ? result : null;
}

/**
 * On save: recompute pinyin for the (possibly new) hanzi. If the hanzi changed, an existing
 * override no longer lines up, so it is dropped and the caller tells Will (DESIGN §4.2).
 */
export function repinyin(
  previous: { hanzi: string; pinyinOverride: PinyinPairs | null } | null,
  hanzi: string,
): { pinyin: PinyinPairs; pinyinOverride: PinyinPairs | null; overrideDropped: boolean } {
  const computed = computePinyin(hanzi);
  if (!previous || previous.hanzi === hanzi) {
    return {
      pinyin: computed,
      pinyinOverride: previous?.pinyinOverride ?? null,
      overrideDropped: false,
    };
  }
  return {
    pinyin: computed,
    pinyinOverride: null,
    overrideDropped: previous.pinyinOverride !== null,
  };
}

/** A frame's slot as written (`…`, `⋯` or `...`), one or more characters of it. */
const SLOT_CHAR = /^[…⋯.]$/u;

/**
 * Pinyin for Discord replies: `pinyinText`'s spaced syllables, but a frame's slot stays `…`
 * (`阿姨，您是说…吗？` → `ā yí nín shì shuō … ma`). Other punctuation is dropped.
 */
export function replyPinyin(pairs: PinyinPairs): string {
  const out: string[] = [];
  for (const [c, s] of pairs) {
    if (s !== null) out.push(s);
    else if (SLOT_CHAR.test(c) && out.at(-1) !== "…") out.push("…");
  }
  return out.join(" ");
}

/** Plain-text pinyin (`ā yí`) for search, lists and accessibility labels. */
export function pinyinText(pairs: PinyinPairs): string {
  return pairs
    .map(([, s]) => s)
    .filter((s): s is string => s !== null)
    .join(" ");
}
