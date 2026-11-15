// Pinyin (DESIGN §4.2): always computed from the characters, never taken from an LLM. pinyin-pro
// with tone marks, aligned per character, with tone sandhi shown only for 一/不. pinyin-pro reads
// some everyday polyphones wrongly out of context (跑得快 → dé, 我得走 → dé, 长高 → cháng), so a
// small table of context rules corrects the common cases; Will's per-syllable overrides fix the
// rest.
import { convert, pinyin } from "pinyin-pro";
import type { PinyinPairs } from "@bamboo/db";

export type { PinyinPairs };

const HANZI = /\p{Script=Han}/u;
const isHanzi = (c: string | undefined): c is string => !!c && HANZI.test(c);

/** Degree/manner words that follow a structural 得 (跑得很快, 说得好, 长得像). */
const DE_COMPLEMENT = new Set([..."很太好快慢多少真非挺特越清干不这那跟像满一早晚累饱香舒"]);
/** Characters that make 得 part of a word read dé (获得, 值得, 不得不), not a complement. */
const DE_WORD_BEFORE = new Set([..."获取赢值所难懂心求贪博不总使免记觉晓舍显"]);
/** Subjects and adverbs before the modal 得 "must" (我得走, 还得去, 我们得给…). */
const DEI_BEFORE = new Set([..."我你他她它们咱谁还就也都又总可必"]);
/** Characters that make 得 part of a word read dé after a subject (你得到了, 他得罪了). */
const DE_WORD_AFTER = new Set([..."到罪意分奖病失逞力体手出知"]);
/** 长 read zhǎng, "to grow" (长大, 长高, 长牙, 长得像). */
const ZHANG_BEFORE_NEXT = new Set([..."大高胖得牙个肉出成辈"]);

interface ContextRule {
  char: string;
  reading: string;
  applies: (prev: string | undefined, next: string | undefined) => boolean;
}

const CONTEXT_RULES: readonly ContextRule[] = [
  {
    char: "得",
    reading: "de",
    applies: (prev, next) =>
      isHanzi(prev) && !DE_WORD_BEFORE.has(prev) && !!next && DE_COMPLEMENT.has(next),
  },
  {
    char: "得",
    reading: "děi",
    applies: (prev, next) =>
      !!prev &&
      DEI_BEFORE.has(prev) &&
      isHanzi(next) &&
      !DE_COMPLEMENT.has(next) &&
      !DE_WORD_AFTER.has(next),
  },
  {
    char: "长",
    reading: "zhǎng",
    applies: (_prev, next) => !!next && ZHANG_BEFORE_NEXT.has(next),
  },
];

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

  return chars.map((c, i) => {
    let syllable = isHanzi(c) ? (aligned[i] ?? null) : null;
    if (syllable !== null) {
      for (const rule of CONTEXT_RULES) {
        if (rule.char === c && rule.applies(chars[i - 1], chars[i + 1])) {
          syllable = rule.reading;
          break;
        }
      }
    }
    return [c, syllable];
  });
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
