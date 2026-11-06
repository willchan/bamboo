// Text normalization (DESIGN §4.1). The engine and the Mac side must agree byte for byte, because
// `hanziKey` feeds dedupe (phrases) and turn identity (turn keys).

/**
 * CJK Radicals Supplement lookalikes that NFKC leaves alone, mapped to the ideograph they stand
 * for. Seen in Gemini PDF exports; extend as new ones turn up (any other character left in
 * U+2E80–U+2FDF is kept and reported by `strayRadicals`).
 */
export const RADICAL_MAP: Readonly<Record<string, string>> = {
  "⻄": "西",
  "⻋": "车",
  "⻓": "长",
  "⻛": "风",
  "⻥": "鱼",
  "⻧": "麦",
  "⻅": "见",
  "⻔": "门",
  "⻢": "马",
  "⻜": "飞",
  "⻝": "食",
  "⻰": "龙",
  "⻳": "龟",
  "⻆": "角",
  "⻚": "页",
  "⻉": "贝",
  "⻘": "青",
  "⻨": "麦",
  "⻩": "黄",
  "⻬": "齐",
  "⻮": "齿",
};

/** Kangxi Radicals (U+2F00–U+2FDF) and CJK Radicals Supplement (U+2E80–U+2EFF). */
const RADICAL_RANGE = /[⺀-⻿⼀-⿟]/gu;

/**
 * Full-width Chinese punctuation that NFKC would fold to ASCII (`，` → `,`, `…` → `...`). Stored
 * hanzi is displayed, so these keep their Chinese form; `hanziKey` drops them either way.
 */
const KEEP_PUNCT = "，！？：；（）～…";
const NOT_KEPT = new RegExp(`[^${KEEP_PUNCT}]+`, "gu");

/**
 * NFKC (which maps the Kangxi Radicals block, full-width letters and digits) except on Chinese
 * punctuation, then the explicit radical map, then collapse whitespace runs inside each line and
 * trim each line. Line breaks are kept; blank-line runs are left alone (segmentation decides what
 * they mean).
 */
export function normalizeText(s: string): string {
  const nfkc = s.replace(NOT_KEPT, (run) => run.normalize("NFKC"));
  const mapped = nfkc.replace(RADICAL_RANGE, (c) => RADICAL_MAP[c] ?? c);
  return mapped
    .split(/\r\n|\r|\n/u)
    .map((line) => line.replace(/[^\S\r\n]+/gu, " ").trim())
    .join("\n")
    .trim();
}

/** Radical lookalikes still present after `normalizeText`, for telemetry. Distinct, in order. */
export function strayRadicals(normalized: string): string[] {
  return [...new Set(normalized.match(RADICAL_RANGE) ?? [])];
}

/** A CJK unified ideograph (any block, including extensions and compatibility ideographs). */
const IDEOGRAPH = /\p{Script=Han}/u;
const KEY_DROP = /[^\p{Script=Han}A-Za-z0-9]/gu;

/** True if `s` contains at least one CJK ideograph. */
export const hasHanzi = (s: string): boolean => IDEOGRAPH.test(s);

/**
 * The dedupe key: `normalizeText(s)` with everything except CJK ideographs, ASCII letters and
 * digits removed, and letters lowercased. `阿姨，您是说…吗？` → `阿姨您是说吗`.
 */
export function hanziKey(s: string): string {
  return normalizeText(s).replace(KEY_DROP, "").toLowerCase();
}
