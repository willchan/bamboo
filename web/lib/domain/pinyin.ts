// Pinyin (DESIGN §4.2, §5.5.3): always computed from the characters, never taken from an LLM.
// pinyin-pro with tone marks, aligned per character, with tone sandhi shown only for 一/不. It
// loads pinyin-pro's large dictionary (`@pinyin-pro/data/complete`), trimmed by
// `scripts/pinyin-dict.ts` to the entries that change a reading, which fixes everyday neutral tones
// (梯子, 肚子, 舒服, 里脊, 芝麻). No context rules: polyphones are settled by H4's per-syllable merge,
// and Will's overrides win.
import { addDict, convert, pinyin } from "pinyin-pro";
import type { PhraseExample, PinyinPairs } from "@bamboo/db";
import {
  applySources,
  mergeReading,
  sharedConfig,
  type PinyinJobInput,
  type PinyinJobResult,
  type PinyinSlot,
  type PinyinSource,
} from "@bamboo/shared";
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

/**
 * An example sentence's pinyin (DESIGN §5.5.3, §10 #106, #107): its stored, merged reading when it
 * has one that lines up with its hanzi (since extract_turn.v8), else computed; then, wherever the
 * phrase's hanzi appears in it, the syllables the merge or Will's override settled for the phrase
 * (`shown`, its displayed pinyin) replace the example's. A syllable nothing settled for the phrase
 * keeps the sentence's own reading (一/不 sandhi, or its own merge). Examples without the hanzi
 * keep theirs.
 */
export function examplePinyin(
  example: string | Pick<PhraseExample, "hanzi" | "pinyin">,
  hanzi: string,
  shown: PinyinPairs,
): PinyinPairs {
  const ex = typeof example === "string" ? { hanzi: example, pinyin: null } : example;
  const computed = computePinyin(ex.hanzi);
  const out: PinyinPairs =
    ex.pinyin && sameChars(computed, ex.pinyin)
      ? computed.map(([c, s], i) => [c, s === null ? null : (ex.pinyin![i]![1] ?? s)])
      : computed;
  const own = computePinyin(hanzi);
  if (own.length === 0 || !sameChars(own, shown)) return out;
  const settled = shown.map(([, s], i) => (s !== own[i]?.[1] ? s : undefined));
  const chars = out.map(([c]) => c);
  for (let i = 0; i + own.length <= chars.length; i++) {
    if (!own.every(([c], j) => chars[i + j] === c)) continue;
    settled.forEach((s, j) => {
      if (s !== undefined) out[i + j] = [own[j]![0], s];
    });
    i += own.length - 1;
  }
  return out;
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

// --- The merge with Gemini's reading (DESIGN §5.5.3b, H4) --------------------------------------

/**
 * Each character's computed reading and its valid readings (pinyin-pro `multiple: true`, the
 * computed one included): what the merge, the worker and the referee choose among.
 */
export function pinyinSlots(hanzi: string): PinyinSlot[] {
  return computePinyin(hanzi).map(([char, computed]) => ({
    char,
    computed,
    readings:
      computed === null
        ? []
        : [...new Set([computed, ...pinyin(char, { multiple: true, type: "array" })])],
  }));
}

const toPairs = (slots: readonly PinyinSlot[], readings: readonly (string | null)[]): PinyinPairs =>
  slots.map((s, i) => [s.char, s.computed === null ? null : (readings[i] ?? s.computed)]);

export interface PhrasePinyin {
  /** The stored reading: computed, with the merge's choices. Overrides apply on display. */
  pinyin: PinyinPairs;
  /** `phrase.pinyin_sources`: null when there was no usable Gemini reading to merge. */
  pinyinSources: PinyinSource[] | null;
  /** The disputes still waiting for the referee. */
  pending: number;
  /** Gemini sent a reading that didn't line up with the hanzi (one syllable per character). */
  misaligned: boolean;
}

/** Merge Gemini's reading (and the referee's answers, if any) into the phrase's computed one. */
export function mergedPinyin(
  hanzi: string,
  gemini: readonly string[] | null | undefined,
  referee?: ReadonlyMap<number, string>,
  opts: { final?: boolean } = {},
): PhrasePinyin {
  const slots = pinyinSlots(hanzi);
  const m = mergeReading(slots, gemini, referee, opts);
  return {
    pinyin: toPairs(slots, m.readings),
    pinyinSources: m.aligned ? m.sources : null,
    pending: m.pending.length,
    misaligned: !!gemini?.length && m.aligned === null,
  };
}

/** The stored reading recomputed from the hanzi, keeping the referee's still-valid choices. */
export function storedPinyin(hanzi: string, sources: readonly PinyinSource[] | null): PinyinPairs {
  const slots = pinyinSlots(hanzi);
  return toPairs(slots, applySources(slots, sources));
}

// --- Examples (DESIGN §5.5.3b, §10 #107) -------------------------------------------------------

/** An example whose pinyin isn't settled: none merged yet, or a dispute waiting for the referee. */
export function exampleNeedsPinyin(e: Pick<PhraseExample, "pinyin" | "pinyin_sources">): boolean {
  return !e.pinyin || !e.pinyin_sources || e.pinyin_sources.some((s) => s.rule === "pending");
}

/**
 * An example with Gemini's reading merged in, like a phrase's (`mergedPinyin`): the stored
 * reading and its disputes. Without a reading that lines up (none sent, the Ollama fallback, a
 * misaligned one) nothing is stored, and the card computes it until a pinyin job has run.
 */
export function settleExample<E extends { hanzi: string }>(
  e: E,
  gemini: readonly string[] | null | undefined,
  referee?: ReadonlyMap<number, string>,
  opts: { final?: boolean } = {},
): Omit<E, "pinyin" | "pinyin_sources"> & Pick<PhraseExample, "pinyin" | "pinyin_sources"> {
  const rest = { ...e } as E & Partial<PhraseExample>;
  delete rest.pinyin;
  delete rest.pinyin_sources;
  const m = mergedPinyin(e.hanzi, gemini, referee, opts);
  if (!m.pinyinSources) return rest;
  return { ...rest, pinyin: m.pinyin, pinyin_sources: m.pinyinSources };
}

/**
 * A `pinyin` job for the worker: Gemini's reading of the phrase (when `gemini` is null), then
 * the referee. Its context is the phrase's own examples, and since §10 #107 it settles those whose
 * pinyin isn't settled (`exampleNeedsPinyin`): `exampleGemini` holds the extraction's readings
 * by example hanzi, for the ones with a pending dispute (only the referee runs for those). With
 * `phraseSettled`, only the examples are merged.
 */
export function pinyinJobInput(
  p: {
    id: string;
    hanzi: string;
    examples: readonly Pick<PhraseExample, "hanzi" | "pinyin" | "pinyin_sources">[];
  },
  gemini: readonly string[] | null,
  opts: {
    max?: number;
    phraseSettled?: boolean;
    backfill?: boolean;
    exampleGemini?: ReadonlyMap<string, readonly string[] | null | undefined>;
  } = {},
): PinyinJobInput {
  const max = opts.max ?? sharedConfig.pinyin.maxContextExamples;
  const context = p.examples.slice(0, max);
  const examples = context.flatMap((e, index) => {
    if (!exampleNeedsPinyin(e)) return [];
    const g = e.pinyin_sources ? opts.exampleGemini?.get(e.hanzi) : null;
    return [{ index, hanzi: e.hanzi, slots: pinyinSlots(e.hanzi), gemini: g ? [...g] : null }];
  });
  return {
    phrase_id: p.id,
    hanzi: p.hanzi,
    context: context.map((e) => e.hanzi),
    slots: pinyinSlots(p.hanzi),
    gemini: gemini ? [...gemini] : null,
    examples,
    ...(opts.phraseSettled ? { phrase_settled: true } : {}),
    ...(opts.backfill ? { backfill: true } : {}),
  };
}

/**
 * A finished pinyin job's example readings applied to the phrase's current examples (§10 #107):
 * each job example still there (same place, same hanzi) is merged with Gemini's reading (the
 * worker's, else the extraction's) and the referee's answers, finally (an unanswered dispute is
 * `rejected`). A reading that doesn't line up still counts as checked (`pinyin_sources: []`), so
 * it isn't asked again. Returns the examples and, per settled example, its disputes.
 */
export function applyExampleResults(
  current: readonly PhraseExample[],
  input: Pick<PinyinJobInput, "examples">,
  result: Pick<PinyinJobResult, "examples">,
): {
  examples: PhraseExample[];
  changed: boolean;
  settled: { index: number; sources: PinyinSource[] }[];
} {
  const examples = [...current];
  const settled: { index: number; sources: PinyinSource[] }[] = [];
  for (const je of input.examples ?? []) {
    const e = examples[je.index];
    if (!e || e.hanzi !== je.hanzi) continue;
    const r = result.examples?.find((x) => x.index === je.index);
    const referee = new Map((r?.referee ?? []).map((c) => [c.index, c.reading]));
    const m = mergedPinyin(e.hanzi, r?.gemini ?? je.gemini, referee, { final: true });
    const sources = m.pinyinSources ?? [];
    examples[je.index] = { ...e, pinyin: m.pinyin, pinyin_sources: sources };
    settled.push({ index: je.index, sources });
  }
  return { examples, changed: settled.length > 0, settled };
}

/** The stored example reading recomputed from its hanzi, keeping the referee's choices (§4.2). */
export function storedExample(e: PhraseExample): PhraseExample {
  if (!e.pinyin || !e.pinyin_sources) return e;
  return { ...e, pinyin: storedPinyin(e.hanzi, e.pinyin_sources) };
}

/** Settled disputes (not pending) for the `pinyin_disagreement` event, or null if none. */
export function disagreementEvent(
  phraseId: string,
  sources: readonly PinyinSource[] | null,
): Record<string, unknown> | null {
  const settled = (sources ?? []).filter((s) => s.rule !== "pending");
  if (!settled.length) return null;
  const winners = new Set(settled.map((s) => s.winner));
  const outcome = winners.size === 1 ? [...winners][0]! : "mixed";
  return {
    phrase_id: phraseId,
    syllables: settled.map(({ i, computed, gemini, chosen, rule, winner }) => ({
      i,
      computed,
      gemini,
      chosen,
      rule,
      winner,
    })),
    outcome,
  };
}
