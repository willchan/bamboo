// The name filter (DESIGN §5.5.8, PLAN H4): before a result is posted, anything extracted that
// contains a name from `~/.config/bamboo/names.deny` is dropped, or, in an English field,
// rewritten to a role word. The list stays on the Mac: it is never logged, sent or committed, and
// only a count (`dropped_name`) leaves the worker. Tests use a synthetic deny file.
//
// File format: UTF-8, one name per line (hanzi or a Latin spelling), blank lines and `#` comments
// ignored. Latin names match as whole words, and only capitalized as a name is written ("Plum",
// "PLUM", not "plum"), so a name that is also an English word doesn't rewrite that word (§10 #104);
// hanzi names match anywhere.
import { readFileSync, statSync } from "node:fs";
import type { ExtractItem, ExtractTurnResult } from "@bamboo/shared";

export interface DenyList {
  path: string;
  loaded: boolean;
  /** How many names (for the startup log; never the names). */
  count: number;
  /** The file is readable or writable by the group or others. */
  tooOpen: boolean;
  /** Does `text` contain a listed name? */
  matches(text: string): boolean;
  /** `text` with every listed name replaced by `replacement`. */
  rewrite(text: string, replacement: string): string;
}

const LATIN = /^[\p{Script=Latin}\s'.-]+$/u;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A Latin name as a pattern: its first letter upper case only, the rest in either case. "will"
 * in the file matches "Will" and "WILL" but not the word "will" (§10 #104).
 */
function capitalized(name: string): string {
  return Array.from(name)
    .map((ch, i) => {
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      if (lo === up) return escape(ch);
      return i === 0 ? escape(up) : `[${escape(lo)}${escape(up)}]`;
    })
    .join("");
}

/** Build a deny list from the file's text. */
export function parseDenyList(text: string, path = "(inline)", tooOpen = false): DenyList {
  const names = [
    ...new Set(
      text
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    ),
  ];
  const parts = names.map((n) =>
    // Latin: whole words, so a short name doesn't match inside another word.
    LATIN.test(n) ? `(?<![\\p{L}\\p{N}])${capitalized(n)}(?![\\p{L}\\p{N}])` : escape(n),
  );
  // No `i` flag: Latin case is handled per letter by `capitalized`, and hanzi have none.
  const re = parts.length ? new RegExp(parts.join("|"), "gu") : null;
  return {
    path,
    loaded: true,
    count: names.length,
    tooOpen,
    matches: (t) => (re ? new RegExp(re.source, "u").test(t) : false),
    rewrite: (t, replacement) => (re ? t.replace(re, replacement) : t),
  };
}

/** The deny list at `path`; an empty, `loaded: false` list if the file can't be read. */
export function loadDenyList(path: string): DenyList {
  try {
    const mode = statSync(path).mode;
    return parseDenyList(readFileSync(path, "utf8"), path, (mode & 0o077) !== 0);
  } catch {
    return { ...parseDenyList(""), path, loaded: false };
  }
}

/** What an English field becomes when it names someone: a neutral role word. */
export const NAME_REPLACEMENT = "someone";

/**
 * Apply the deny list to a result: an item whose Chinese (hanzi, breakdown parts) contains a name
 * is dropped; an example that does is dropped; English fields (english, note, glosses, the
 * breakdown's meaning or note, example English) are rewritten; a `heard_as` naming someone is
 * cleared. Returns the cleaned result and how many things were dropped or rewritten.
 */
export function filterNames(
  result: ExtractTurnResult,
  deny: DenyList,
): { result: ExtractTurnResult; dropped: number } {
  if (deny.count === 0) return { result, dropped: 0 };
  let dropped = 0;
  const english = (s: string): string => {
    if (!deny.matches(s)) return s;
    dropped += 1;
    return deny.rewrite(s, NAME_REPLACEMENT);
  };
  const items: ExtractItem[] = [];
  for (const item of result.items) {
    const chinese = [item.hanzi, ...(item.breakdown?.parts.map((p) => p.hanzi) ?? [])];
    if (chinese.some((c) => deny.matches(c))) {
      dropped += 1;
      continue;
    }
    const examples = (item.examples ?? (item.example ? [item.example] : [])).filter((e) => {
      if (!deny.matches(e.hanzi)) return true;
      dropped += 1;
      return false;
    });
    // An example's pinyin (v8) is syllables only, so it stays as it is.
    const cleanExamples = examples.map((e) => ({
      ...e,
      english: e.english === null ? null : english(e.english),
    }));
    let heardAs = item.heard_as;
    if (heardAs && deny.matches(heardAs)) {
      dropped += 1;
      heardAs = null;
    }
    const bd = item.breakdown;
    items.push({
      ...item,
      english: english(item.english),
      note: item.note == null ? item.note : english(item.note),
      heard_as: heardAs,
      example: cleanExamples[0] ?? null,
      ...(item.examples !== undefined ? { examples: cleanExamples } : {}),
      breakdown: bd
        ? "meaning" in bd
          ? {
              parts: bd.parts.map((p) => ({ hanzi: p.hanzi, gloss: english(p.gloss) })),
              meaning: english(bd.meaning),
            }
          : {
              parts: bd.parts.map((p) => ({ hanzi: p.hanzi, gloss: english(p.gloss) })),
              note: english(bd.note),
            }
        : bd,
    });
  }
  return { result: { turn_kind: result.turn_kind, items }, dropped };
}
