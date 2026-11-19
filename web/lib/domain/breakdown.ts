// The card back's breakdown (DESIGN §5.5.4): the exact-match rule, English-only glosses, and each
// part's pinyin sliced from the phrase's displayed pinyin. Pure: lib/repo stores the results.
import type { PhraseKind } from "@bamboo/db";
import {
  hanziKey,
  type PhraseBreakdown,
  type SentenceBreakdown,
  type TermBreakdown,
} from "@bamboo/shared";
import type { PinyinPairs } from "./pinyin";

const HAN = /\p{Script=Han}/u;

const english = (s: string) => {
  const t = s.trim();
  return t && !HAN.test(t) ? t : null;
};

/**
 * Keep a breakdown only if it fits its phrase: the parts' hanzi, concatenated, equal the phrase's
 * hanzi (punctuation and spacing ignored, via `hanziKey`); every part has Chinese of its own;
 * glosses and the meaning (terms) or note (sentences) are English only; and the shape matches the
 * kind. Frames get none. Anything else returns `null` with `dropped` set (`breakdown_dropped`).
 */
export function checkBreakdown(
  kind: PhraseKind,
  hanzi: string,
  raw: PhraseBreakdown | null | undefined,
): { breakdown: PhraseBreakdown | null; dropped: boolean } {
  if (!raw) return { breakdown: null, dropped: false };
  const drop = { breakdown: null, dropped: true };
  if (kind === "frame") return drop;

  const parts: { hanzi: string; gloss: string }[] = [];
  for (const p of raw.parts) {
    const h = p.hanzi.trim();
    const gloss = english(p.gloss);
    if (!gloss || !hanziKey(h) || !HAN.test(h)) return drop;
    parts.push({ hanzi: h, gloss });
  }
  if (parts.length === 0 || parts.map((p) => hanziKey(p.hanzi)).join("") !== hanziKey(hanzi)) {
    return drop;
  }

  if (kind === "term") {
    const meaning = "meaning" in raw ? english(raw.meaning) : null;
    return meaning ? { breakdown: { parts, meaning }, dropped: false } : drop;
  }
  const note = "note" in raw ? english(raw.note) : null;
  return note ? { breakdown: { parts, note }, dropped: false } : drop;
}

export const isTermBreakdown = (b: PhraseBreakdown): b is TermBreakdown => "meaning" in b;
export const isSentenceBreakdown = (b: PhraseBreakdown): b is SentenceBreakdown => "note" in b;

/** One part on the card back: its hanzi, its slice of the phrase's pinyin, and its gloss. */
export interface BreakdownPartView {
  hanzi: string;
  pinyin: PinyinPairs;
  gloss: string;
}

export interface BreakdownView {
  parts: BreakdownPartView[];
  /** The term's overall meaning, or `null` for a sentence. */
  meaning: string | null;
  /** The sentence's note on how it's built, or `null` for a term. */
  note: string | null;
}

const counts = (c: string) => hanziKey(c) !== "";

/**
 * Each part's pinyin, sliced in order from the phrase's displayed pinyin (computed, merged,
 * overrides applied), so the breakdown always reads the same as the card. Characters the key
 * ignores (punctuation, spaces) are skipped. Returns `null` if the pinyin doesn't line up with the
 * parts (the phrase changed since the breakdown was checked); the card then shows no breakdown.
 */
export function breakdownView(
  breakdown: PhraseBreakdown | null,
  pinyin: PinyinPairs,
): BreakdownView | null {
  if (!breakdown) return null;
  const chars = pinyin.filter(([c]) => counts(c));
  let at = 0;
  const parts: BreakdownPartView[] = [];
  for (const p of breakdown.parts) {
    const want = Array.from(hanziKey(p.hanzi));
    const slice = chars.slice(at, at + want.length);
    if (slice.length !== want.length || slice.some(([c], i) => hanziKey(c) !== want[i])) {
      return null;
    }
    at += want.length;
    parts.push({ hanzi: p.hanzi, pinyin: slice, gloss: p.gloss });
  }
  if (at !== chars.length) return null;
  return {
    parts,
    meaning: isTermBreakdown(breakdown) ? breakdown.meaning : null,
    note: isSentenceBreakdown(breakdown) ? breakdown.note : null,
  };
}
