// How common a phrase's words are in spoken Mandarin (DESIGN §4.6, "frequency"). Computed from a
// bundled word list (web/lib/data/wordfreq-zh.ts), never from the LLM. Pure: the list is data.
import { WORDFREQ_ZH, WORDFREQ_ZH_MIN_ZIPF } from "../data/wordfreq-zh";
import { config, type FrequencyConfig } from "../config";

/** Word → Zipf frequency (log10 of occurrences per billion words). */
export interface WordFrequencies {
  zipf: ReadonlyMap<string, number>;
  /** The longest word in the list, in characters (bounds the segmenter's lookahead). */
  maxWordChars: number;
}

/** Parse the bundled format: one `<zipf×10>\t<word> <word> …` line per tenth of a Zipf. */
export function parseFrequencies(data: string): WordFrequencies {
  const zipf = new Map<string, number>();
  let maxWordChars = 1;
  for (const line of data.split("\n")) {
    const [tenth, words] = line.split("\t");
    if (!tenth || !words) continue;
    const z = Number(tenth) / 10;
    for (const w of words.split(" ")) {
      if (!w || zipf.has(w)) continue;
      zipf.set(w, z);
      maxWordChars = Math.max(maxWordChars, Array.from(w).length);
    }
  }
  return { zipf, maxWordChars };
}

let bundled: WordFrequencies | null = null;
/** The bundled list, parsed once per process (~108k words). */
export function bundledFrequencies(): WordFrequencies {
  bundled ??= parseFrequencies(WORDFREQ_ZH);
  return bundled;
}

/** The bundled list's cut-off: anything rarer is not in it. */
export const BUNDLED_MIN_ZIPF = WORDFREQ_ZH_MIN_ZIPF;

const HAN_RUN = /\p{Script=Han}+/gu;

/**
 * Greedy longest-match segmentation of each run of hanzi (anything else, such as a frame's
 * slot, separates runs). A character with no listed word is its own segment.
 */
export function segment(text: string, f: WordFrequencies): string[] {
  const out: string[] = [];
  for (const run of text.match(HAN_RUN) ?? []) {
    const chars = Array.from(run);
    let i = 0;
    while (i < chars.length) {
      let len = Math.min(f.maxWordChars, chars.length - i);
      while (len > 1 && !f.zipf.has(chars.slice(i, i + len).join(""))) len -= 1;
      out.push(chars.slice(i, i + len).join(""));
      i += len;
    }
  }
  return out;
}

/**
 * The Zipf frequency of a phrase's rarest word: a phrase is as common as its least common part.
 * A phrase listed whole uses its own frequency. Otherwise it is segmented, and an unlisted
 * character counts as `unknownZipf`. A **term** that only breaks into single characters (a rare
 * compound such as 围兜) is unknown as a whole: two common characters don't make a common word.
 * Null when the text has no hanzi.
 */
export function commonness(
  key: string,
  isTerm: boolean,
  f: WordFrequencies = bundledFrequencies(),
  cfg: FrequencyConfig = config.frequency,
): number | null {
  const whole = f.zipf.get(key);
  if (whole !== undefined) return whole;
  const parts = segment(key, f);
  if (parts.length === 0) return null;
  if (isTerm && parts.length > 1 && parts.every((p) => Array.from(p).length === 1))
    return cfg.unknownZipf;
  return Math.min(...parts.map((p) => f.zipf.get(p) ?? cfg.unknownZipf));
}
