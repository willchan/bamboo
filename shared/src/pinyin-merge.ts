// The per-syllable pinyin merge (DESIGN §5.5.3b, §10 #80), pure and data-driven: the engine
// supplies each character's computed reading and valid readings (pinyin-pro, in
// `web/lib/domain/pinyin.ts`); the worker uses the same rules to know when the referee is needed.
//
// Per hanzi syllable:
//   1. computed and Gemini's agree → accept;
//   2. Gemini's isn't a valid reading of the character → the computed one, no extra call;
//   3. both valid → the referee, which must choose among the valid readings plus the neutral
//      tone; anything else is rejected and the computed reading stays;
//   4. Will's override wins over all of it (applied at display time, `displayPinyin`).
// Stored pinyin is therefore always a valid dictionary reading (or its neutral tone, when the
// referee chose it).
import { sharedConfig } from "./config";
import type { PinyinSlot } from "./contracts/jobs";

/** How a disputed syllable was settled. */
export type PinyinRule =
  /** Gemini's reading isn't valid for the character: the computed one stays (rule 2). */
  | "invalid"
  /** Both valid; the referee chose `chosen` (rule 3). */
  | "referee"
  /** Both valid; the referee answered outside the options, or didn't answer (rule 3). */
  | "rejected"
  /** Both valid; the referee hasn't run yet. The computed reading shows meanwhile. */
  | "pending";

/** Which source won for one disputed syllable (`phrase.pinyin_sources`). */
export interface PinyinSource {
  /** Index into the phrase's characters. */
  i: number;
  char: string;
  computed: string;
  gemini: string;
  chosen: string;
  rule: PinyinRule;
  /** `computed`, `gemini`, or `other` (the referee picked a third valid reading). */
  winner: "computed" | "gemini" | "other";
}

const TONE_MARKS = /[̀́̄̌]/gu;
const TONE_NUMBER = /^([a-zü]+)([0-5])$/u;
const TONED_VOWEL: Record<string, string[]> = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  ü: ["ǖ", "ǘ", "ǚ", "ǜ"],
};

/** The syllable without its tone mark (the neutral tone): `zǐ` → `zi`, `lǜ` → `lü`. */
export function neutralTone(s: string): string {
  return s.normalize("NFD").replace(TONE_MARKS, "").normalize("NFC");
}

/** Tone number → mark, on the standard vowel (a/e first, then the o of ou, else the last vowel). */
function markTone(base: string, tone: number): string {
  if (tone === 0 || tone === 5) return base;
  const at =
    base.search(/[ae]/u) >= 0
      ? base.search(/[ae]/u)
      : base.includes("ou")
        ? base.indexOf("o")
        : Math.max(...["i", "o", "u", "ü"].map((v) => base.lastIndexOf(v)));
  const v = base[at];
  if (at < 0 || !v || !TONED_VOWEL[v]) return base;
  return base.slice(0, at) + TONED_VOWEL[v][tone - 1] + base.slice(at + 1);
}

/**
 * A syllable as a model wrote it, tidied for comparison: trimmed, lower-cased, NFC, `v`/`u:` → `ü`,
 * tone numbers to marks (`de5` → `de`, `dei3` → `děi`). Null if it isn't one plain syllable.
 */
export function normalizeModelSyllable(raw: string): string | null {
  let s = raw.trim().toLowerCase().normalize("NFC").replace(/u:|v/gu, "ü");
  const n = TONE_NUMBER.exec(s);
  if (n) s = markTone(n[1]!, Number(n[2]));
  return /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜ]+$/u.test(s) ? s : null;
}

/**
 * Gemini's syllables lined up with the phrase's hanzi slots: one per hanzi, in order. Null when
 * the counts differ or a syllable isn't one (e.g. `māma` for 妈妈, `huār` for 花儿): then the
 * reading is ignored and the computed one stays.
 */
export function alignGemini(
  slots: readonly PinyinSlot[],
  gemini: readonly string[] | null | undefined,
): (string | null)[] | null {
  if (!gemini) return null;
  const syllables = gemini.flatMap((g) => g.trim().split(/\s+/u)).filter(Boolean);
  const hanzi = slots.filter((s) => s.computed !== null).length;
  if (syllables.length !== hanzi || hanzi === 0) return null;
  const out: (string | null)[] = [];
  let k = 0;
  for (const slot of slots) {
    if (slot.computed === null) {
      out.push(null);
      continue;
    }
    const s = normalizeModelSyllable(syllables[k++]!);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** What the referee may choose for a slot: its valid readings plus their neutral tones. */
export function refereeOptions(slot: PinyinSlot): string[] {
  const valid = [...new Set([...(slot.computed ? [slot.computed] : []), ...slot.readings])];
  return [...new Set([...valid, ...valid.map(neutralTone)])];
}

const agrees = (slot: PinyinSlot, g: string, sandhi: readonly string[]) =>
  g === slot.computed ||
  (sandhi.includes(slot.char) && neutralTone(g) === neutralTone(slot.computed!));

const isValid = (slot: PinyinSlot, g: string) => g === slot.computed || slot.readings.includes(g);

/** The slots where both readings are valid and differ: what the referee is asked about. */
export function disputedSlots(
  slots: readonly PinyinSlot[],
  aligned: readonly (string | null)[] | null,
  sandhi: readonly string[] = sharedConfig.pinyin.sandhiChars,
): number[] {
  if (!aligned) return [];
  const out: number[] = [];
  slots.forEach((slot, i) => {
    const g = aligned[i];
    if (slot.computed === null || !g || agrees(slot, g, sandhi)) return;
    if (isValid(slot, g)) out.push(i);
  });
  return out;
}

export interface MergedPinyin {
  /** One reading per slot (null for non-hanzi), the computed one unless the merge chose another. */
  readings: (string | null)[];
  /** The disputed syllables and who won (empty when Gemini agreed everywhere). */
  sources: PinyinSource[];
  /** Slots still waiting for the referee. */
  pending: number[];
  /** Gemini's reading lined up with the slots (null: absent or misaligned). */
  aligned: (string | null)[] | null;
}

/**
 * Merge Gemini's reading into the computed one. `referee` holds the referee's answers by slot
 * index; with `final`, a dispute the referee didn't answer is `rejected` rather than `pending`.
 */
export function mergeReading(
  slots: readonly PinyinSlot[],
  gemini: readonly string[] | null | undefined,
  referee: ReadonlyMap<number, string> = new Map(),
  opts: { final?: boolean; sandhi?: readonly string[] } = {},
): MergedPinyin {
  const sandhi = opts.sandhi ?? sharedConfig.pinyin.sandhiChars;
  const aligned = alignGemini(slots, gemini);
  const readings = slots.map((s) => s.computed);
  const sources: PinyinSource[] = [];
  const pending: number[] = [];
  if (!aligned) return { readings, sources, pending, aligned };

  slots.forEach((slot, i) => {
    const g = aligned[i];
    const computed = slot.computed;
    if (computed === null || !g || agrees(slot, g, sandhi)) return;
    const base = { i, char: slot.char, computed, gemini: g };
    if (!isValid(slot, g)) {
      sources.push({ ...base, chosen: computed, rule: "invalid", winner: "computed" });
      return;
    }
    const answer = referee.get(i);
    const r = answer === undefined ? null : normalizeModelSyllable(answer);
    if (r !== null && refereeOptions(slot).includes(r)) {
      readings[i] = r;
      const winner = r === computed ? "computed" : r === g ? "gemini" : "other";
      sources.push({ ...base, chosen: r, rule: "referee", winner });
      return;
    }
    const rule = answer === undefined && !opts.final ? "pending" : "rejected";
    if (rule === "pending") pending.push(i);
    sources.push({ ...base, chosen: computed, rule, winner: "computed" });
  });
  return { readings, sources, pending, aligned };
}

/**
 * Re-apply stored choices to freshly computed slots (the build's `repinyin`, §4.2): a referee's
 * choice stays while the character is unchanged and the choice is still one of its options.
 */
export function applySources(
  slots: readonly PinyinSlot[],
  sources: readonly PinyinSource[] | null,
): (string | null)[] {
  const readings = slots.map((s) => s.computed);
  for (const src of sources ?? []) {
    const slot = slots[src.i];
    if (src.rule !== "referee" || !slot || slot.char !== src.char || slot.computed === null)
      continue;
    if (refereeOptions(slot).includes(src.chosen)) readings[src.i] = src.chosen;
  }
  return readings;
}
