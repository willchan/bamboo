// The phrase queue (DESIGN §4.6–4.7): score and order, validation of extracted items, dedupe into
// existing phrases (asked again, revival). Pure: lib/repo applies the results.
import type { PhraseExample, PhraseKind, PhraseStatus, TurnKind } from "@bamboo/db";
import {
  cleanHanzi,
  hanziKey,
  occursVerbatim,
  PHRASE_TAGS,
  sharedConfig,
  turnTextKey,
  type ExtractTurnResult,
  type PhraseBreakdown,
} from "@bamboo/shared";
import { config, type ExtractionConfig, type RankConfig } from "../config";
import { checkBreakdown } from "./breakdown";
import { bundledFrequencies, commonness, type WordFrequencies } from "./frequency";

export interface ScoreInput {
  kind: PhraseKind;
  turnKind: TurnKind | null;
  heardAs: string | null;
  askedCount: number;
  /** The model's 1–5 rating; null for manual phrases. */
  usefulness: number | null;
  tags: readonly string[];
  hanziKey: string;
}

/**
 * The frequency part of the score: how common the phrase's rarest word is (Zipf, from the
 * bundled list), relative to `frequencyPivot`, clamped to ±`frequencyRange`. Household-tagged
 * phrases (baby, feeding, toddler) aren't penalized for rarity: subtitles under-count them.
 */
export function frequencyPoints(
  p: Pick<ScoreInput, "kind" | "tags" | "hanziKey">,
  rank: RankConfig = config.rank,
  freq: WordFrequencies = bundledFrequencies(),
): number {
  const zipf = commonness(p.hanziKey, p.kind === "term", freq);
  if (zipf === null) return 0;
  const range = rank.frequencyRange;
  let d = Math.max(-range, Math.min(range, zipf - rank.frequencyPivot));
  const household: readonly string[] = rank.householdTags;
  if (d < 0 && p.tags.some((t) => household.includes(t))) d = 0;
  return rank.frequency * d;
}

/** The stored part of the score; recomputed whenever any input changes, and daily (§4.7). */
export function baseScore(
  p: ScoreInput,
  rank: RankConfig = config.rank,
  freq: WordFrequencies = bundledFrequencies(),
): number {
  // Frames are retired (§10 #77): no weight of their own.
  let score = p.kind === "frame" ? 0 : rank.kindWeight[p.kind];
  if (p.turnKind) score += rank.turnWeight[p.turnKind];
  if (p.heardAs) score += rank.heardAs;
  score += rank.askedAgain * Math.max(0, p.askedCount - 1);
  if (p.usefulness !== null) score += rank.usefulness * (p.usefulness - rank.usefulnessPivot);
  score += frequencyPoints(p, rank, freq);
  score -= rank.lengthPenalty * Math.max(0, Array.from(p.hanziKey).length - rank.lengthFreeChars);
  return round2(score);
}

/** Phrases longer than this get the `long` flag (shown in the UI, used when tuning). */
export const isLong = (hanziKey: string, longChars: number = config.phrase.longChars): boolean =>
  Array.from(hanziKey).length > longChars;

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Read-time score: the base score, decayed by weeks since Will last asked about the phrase. */
export function effectiveScore(
  p: { baseScore: number; lastAskedAt: number },
  now: number,
  rank: RankConfig = config.rank,
): number {
  const weeks = Math.max(0, now - p.lastAskedAt) / WEEK;
  return round2(p.baseScore - rank.weeklyDecay * weeks);
}

export interface QueueEntry {
  pinned: boolean;
  pinnedAt: number | null;
  baseScore: number;
  lastAskedAt: number;
  createdAt: number;
}

/**
 * Queue order, freshest first (§4.6, §10 #79): pinned first (newest pin first), then the most
 * recently asked (`last_asked_at` desc), then `effective_score` descending as the tie-break, then
 * newest. Returns new objects carrying their `effectiveScore` and 1-based `rank`.
 */
export function orderQueue<T extends QueueEntry>(
  items: readonly T[],
  now: number,
  rank: RankConfig = config.rank,
): (T & { effectiveScore: number; rank: number })[] {
  return items
    .map((item) => ({ ...item, effectiveScore: effectiveScore(item, now, rank), rank: 0 }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) {
        const pin = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
        if (pin !== 0) return pin;
      }
      if (a.lastAskedAt !== b.lastAskedAt) return b.lastAskedAt - a.lastAskedAt;
      if (a.effectiveScore !== b.effectiveScore) return b.effectiveScore - a.effectiveScore;
      return b.createdAt - a.createdAt;
    })
    .map((item, i) => ({ ...item, rank: i + 1 }));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- Validation (§4.6 steps 1–3) ---------------------------------------------------------------

// `cleanHanzi`, `turnTextKey` and `occursVerbatim` moved to @bamboo/shared in M4 (the worker's
// eval uses them too); re-exported so callers and tests keep importing them from here.
export { cleanHanzi, occursVerbatim, turnTextKey };

const squash = (s: string) => s.toLowerCase().replace(/\s+/gu, "");

const LATIN_RUN = /\p{Script=Latin}+/gu;
const LOWER = /\p{Ll}/u;

/**
 * False when the sentence spells a word in Latin letters (a quoted mishearing like “qincai”,
 * pinyin, or an English gloss in brackets): a run of `romanizedMinLetters` Latin letters with a
 * lowercase one. Such a sentence is usually a question about the word, not a use of it, and its
 * ruby breaks around the Latin. Letter words in caps (A菜, B超) pass.
 */
export function isLearnableExample(
  hanzi: string,
  minLetters: number = config.phrase.romanizedMinLetters,
): boolean {
  for (const [run] of hanzi.matchAll(LATIN_RUN))
    if (run.length >= minLetters && LOWER.test(run)) return false;
  return true;
}

/** A validated item, ready to become (or merge into) a phrase. */
export interface ValidItem {
  kind: PhraseKind;
  hanzi: string;
  hanziKey: string;
  english: string;
  /** Who the wording is for, only when that changes it (extract_turn.v2). English only. */
  note: string | null;
  heardAs: string | null;
  /** Terms only: verbatim examples that contain the term (v4 may send several). */
  examples: { hanzi: string; english: string | null }[];
  usefulness: number;
  /** Gemini's reading, one syllable per hanzi (v4 on Gemini); null for Ollama and older prompts. */
  pinyin: string[] | null;
  tags: string[];
  /** The card back's breakdown, if it passed `checkBreakdown` (DESIGN §5.5.4). */
  breakdown: PhraseBreakdown | null;
  /** `heard_as_dropped`, `example_dropped`, `breakdown_dropped`. */
  flags: string[];
}

export interface Validation {
  turnKind: TurnKind;
  items: ValidItem[];
  /** Items whose hanzi isn't in the turn (or has no Chinese): the model invented it. */
  droppedNotVerbatim: number;
  /** Items repeating an earlier item's key in the same result. */
  droppedDuplicate: number;
  /** Frame items (from an older prompt or worker): frames are retired (§10 #77). */
  droppedFrame: number;
  examplesDropped: number;
  heardAsDropped: number;
  /** Items past the per-turn caps (`config.extraction`: errand items, say terms). */
  droppedOverCap: number;
  /** Tags off the fixed list, or past `maxTags`. */
  tagsDropped: number;
  /** 1 when a say turn's sentence was made from a term's example (`from_example`). */
  sentencePromoted: number;
  /** Breakdowns that didn't match their item's hanzi, or had Chinese in a gloss or note. */
  breakdownsDropped: number;
}

const KNOWN_TAGS: ReadonlySet<string> = new Set(PHRASE_TAGS);

/** Lower-cased, deduped tags from the fixed list, at most `max`; and how many were dropped. */
export function cleanTags(
  raw: readonly string[],
  max: number = sharedConfig.extraction.maxTags,
): { tags: string[]; dropped: number } {
  const unique = [...new Set(raw.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const tags = unique.filter((t) => KNOWN_TAGS.has(t)).slice(0, max);
  return { tags, dropped: unique.length - tags.length };
}

const HAN = /\p{Script=Han}/u;

/**
 * The model's `note`, trimmed. A note is English only: one with Chinese in it is dropped, since
 * LLM-written Chinese is never stored unless it's copied from the turn (CLAUDE.md).
 */
export function englishNote(note: string | null | undefined): string | null {
  const n = note?.trim();
  return n && !HAN.test(n) ? n : null;
}

/**
 * §4.6 steps 1–3 on one `extract_turn` result: drop frame items (retired, §10 #77) and items not
 * copied from the turn, keep `heard_as` only if Will typed it, keep a term's example only if it is
 * verbatim, contains the term and spells no word in romanization. Items for the same key collapse
 * to the first. Then the per-turn caps: an errand turn keeps
 * its first `errandMaxItems` items, a say turn its first `sayMaxTerms` terms. Tags are limited to
 * the fixed list.
 */
export function validateExtraction(
  t: { userText: string; replyText: string },
  result: ExtractTurnResult,
  caps: ExtractionConfig = config.extraction,
): Validation {
  const key = turnTextKey(t);
  const user = squash(t.userText);
  const out: Validation = {
    turnKind: result.turn_kind,
    items: [],
    droppedNotVerbatim: 0,
    droppedDuplicate: 0,
    droppedFrame: 0,
    examplesDropped: 0,
    heardAsDropped: 0,
    droppedOverCap: 0,
    tagsDropped: 0,
    sentencePromoted: 0,
    breakdownsDropped: 0,
  };
  const seen = new Set<string>();
  let terms = 0;
  for (const raw of result.items) {
    if (raw.kind === "frame") {
      out.droppedFrame += 1;
      continue;
    }
    const hanzi = cleanHanzi(raw.hanzi);
    const k = hanziKey(hanzi);
    if (!occursVerbatim(hanzi, raw.kind, key)) {
      out.droppedNotVerbatim += 1;
      continue;
    }
    if (seen.has(k)) {
      out.droppedDuplicate += 1;
      continue;
    }
    seen.add(k);
    const overCap =
      (result.turn_kind === "errand" && out.items.length >= caps.errandMaxItems) ||
      (result.turn_kind === "say" && raw.kind === "term" && terms >= caps.sayMaxTerms);
    if (overCap) {
      out.droppedOverCap += 1;
      continue;
    }
    if (raw.kind === "term") terms += 1;

    const flags: string[] = [];
    let heardAs = raw.heard_as?.trim() || null;
    if (heardAs !== null && !user.includes(squash(heardAs))) {
      heardAs = null;
      flags.push("heard_as_dropped");
      out.heardAsDropped += 1;
    }

    const examples: ValidItem["examples"] = [];
    const rawExamples = raw.examples?.length ? raw.examples : raw.example ? [raw.example] : [];
    if (raw.kind === "term") {
      for (const ex of rawExamples) {
        const exHanzi = cleanHanzi(ex.hanzi);
        const exKey = hanziKey(exHanzi);
        if (examples.some((e) => hanziKey(e.hanzi) === exKey)) continue;
        if (
          occursVerbatim(exHanzi, "sentence", key) &&
          exKey.includes(k) &&
          isLearnableExample(exHanzi)
        ) {
          examples.push({ hanzi: exHanzi, english: ex.english?.trim() || null });
        } else {
          if (!flags.includes("example_dropped")) flags.push("example_dropped");
          out.examplesDropped += 1;
        }
      }
    }

    const bd = checkBreakdown(raw.kind, hanzi, raw.breakdown);
    if (bd.dropped) {
      flags.push("breakdown_dropped");
      out.breakdownsDropped += 1;
    }

    const tags = cleanTags(raw.tags);
    out.tagsDropped += tags.dropped;
    out.items.push({
      kind: raw.kind,
      hanzi,
      hanziKey: k,
      english: raw.english.trim(),
      note: englishNote(raw.note),
      heardAs,
      examples,
      usefulness: raw.usefulness,
      pinyin: raw.pinyin?.length ? [...raw.pinyin] : null,
      tags: tags.tags,
      breakdown: bd.breakdown,
      flags,
    });
  }
  const promoted = caps.promoteExampleSentence
    ? promotedSentence(result.turn_kind, out.items)
    : null;
  if (promoted && !seen.has(promoted.hanziKey)) {
    out.items.push(promoted);
    out.sentencePromoted = 1;
  }
  return out;
}

/**
 * A say turn is a question about what to say, so its sentence is the thing to learn; the local
 * model often leaves it out and returns only terms. Then the shortest example of a kept term
 * becomes the sentence: it is already copied from the turn and contains the term (step 3), and
 * its English came with it. An example that is just the term, or has no English, doesn't count.
 */
function promotedSentence(turnKind: TurnKind, items: readonly ValidItem[]): ValidItem | null {
  if (turnKind !== "say" || items.some((i) => i.kind === "sentence")) return null;
  const candidates = items
    .flatMap((i) =>
      i.kind === "term"
        ? i.examples
            .filter((e) => e.english)
            .map((e) => ({ term: i, ex: e, hanzi: e.hanzi, key: hanziKey(e.hanzi) }))
        : [],
    )
    .filter((c) => c.key !== c.term.hanziKey)
    .sort((a, b) => Array.from(a.key).length - Array.from(b.key).length);
  const best = candidates[0];
  if (!best) return null;
  return {
    kind: "sentence",
    hanzi: best.hanzi,
    hanziKey: best.key,
    english: best.ex.english!,
    note: null,
    heardAs: null,
    examples: [],
    usefulness: best.term.usefulness,
    // Gemini read the term, not this sentence; the sentence gets a pinyin job (DESIGN §5.5.3).
    pinyin: null,
    tags: best.term.tags,
    breakdown: null,
    flags: ["from_example"],
  };
}

// --- Dedupe into an existing phrase (§4.6 step 4) -----------------------------------------------

/** Append examples unless one with the same key is there; keep at most `max` (oldest win). */
export function mergeExamples(
  existing: readonly PhraseExample[],
  incoming: PhraseExample | readonly PhraseExample[] | null,
  max: number = config.phrase.maxExamples,
): PhraseExample[] {
  const out = [...existing];
  const list = incoming === null ? [] : Array.isArray(incoming) ? incoming : [incoming];
  for (const ex of list as readonly PhraseExample[]) {
    if (!out.some((e) => hanziKey(e.hanzi) === hanziKey(ex.hanzi))) out.push(ex);
  }
  return out.slice(0, max);
}

export interface ExistingPhrase {
  status: PhraseStatus;
  kind: PhraseKind;
  hanziKey: string;
  introducedAt: number | null;
  askedCount: number;
  lastAskedImportId: string | null;
  heardAs: string | null;
  examples: PhraseExample[];
  usefulness: number | null;
  turnKind: TurnKind | null;
  tags: string[];
  flags: string[];
  /** Optional so older callers and fixtures needn't carry it; absent means none yet. */
  breakdown?: PhraseBreakdown | null;
}

/** A merge fills in a breakdown only when the phrase has none: the first good one stays. */
const filledBreakdown = (
  p: Pick<ExistingPhrase, "breakdown">,
  item: Pick<ValidItem, "breakdown">,
): { breakdown?: PhraseBreakdown } =>
  !p.breakdown && item.breakdown ? { breakdown: item.breakdown } : {};

export interface MergePlan {
  /** `asked_count` went up: the first time this import asks about the phrase. */
  bumped: boolean;
  /** Dropped or expired, and back. */
  revived: boolean;
  /** Apply Again (`source: 'asked_again'`) to the phrase's reviewed cards (§4.4). */
  askedAgain: boolean;
  /** Columns to write. */
  patch: {
    status: PhraseStatus;
    askedCount: number;
    lastAskedAt?: number;
    lastAskedImportId: string | null;
    heardAs: string | null;
    examples: PhraseExample[];
    baseScore: number;
    flags: string[];
    breakdown?: PhraseBreakdown;
    droppedAt?: null;
    updatedAt: number;
  };
}

/**
 * An item whose key matches an existing phrase. The first time an import asks about it:
 * `asked_count += 1` and re-score; an `active` phrase gets *asked again*; a `dropped` or `expired`
 * one comes back (to `queued`, or to `active` if it had been introduced, since a queued phrase
 * only ever offers New cards). A later turn of the same import only adds its example.
 */
export function planMerge(
  p: ExistingPhrase,
  item: Pick<ValidItem, "heardAs" | "examples" | "flags"> & Partial<Pick<ValidItem, "breakdown">>,
  ctx: { importId: string; turnId: string; now: number },
  rank: RankConfig = config.rank,
): MergePlan {
  const bumped = p.lastAskedImportId !== ctx.importId;
  const revived = bumped && (p.status === "dropped" || p.status === "expired");
  const status: PhraseStatus = revived ? (p.introducedAt !== null ? "active" : "queued") : p.status;
  const askedCount = p.askedCount + (bumped ? 1 : 0);
  const heardAs = p.heardAs ?? item.heardAs;
  const examples =
    p.kind === "term"
      ? mergeExamples(
          p.examples,
          item.examples.map((e) => ({ ...e, turn_id: ctx.turnId })),
        )
      : p.examples;
  const flags = [...new Set([...p.flags, ...item.flags])].filter((f) => f !== "long");
  if (isLong(p.hanziKey)) flags.push("long");
  return {
    bumped,
    revived,
    askedAgain: bumped && status === "active",
    patch: {
      status,
      askedCount,
      ...(bumped ? { lastAskedAt: ctx.now } : {}),
      lastAskedImportId: bumped ? ctx.importId : p.lastAskedImportId,
      heardAs,
      examples,
      baseScore: baseScore(
        {
          kind: p.kind,
          turnKind: p.turnKind,
          heardAs,
          askedCount,
          usefulness: p.usefulness,
          tags: p.tags,
          hanziKey: p.hanziKey,
        },
        rank,
      ),
      flags,
      ...filledBreakdown(p, { breakdown: item.breakdown ?? null }),
      ...(revived ? { droppedAt: null } : {}),
      updatedAt: ctx.now,
    },
  };
}

// --- Re-extraction (§4.6.1, extended in H6: §5.5.6) -------------------------------------------

export interface ReextractPhrase extends ExistingPhrase {
  id: string;
  hanzi: string;
  english: string;
  note: string | null;
  pinned: boolean;
  sourceTurnId: string | null;
  /** H6: when a re-run last reported it as no longer picked; null when it isn't. */
  unpickedAt?: number | null;
}

export interface ReextractPatch {
  status: PhraseStatus;
  english: string;
  note: string | null;
  heardAs: string | null;
  examples: PhraseExample[];
  usefulness: number | null;
  turnKind: TurnKind | null;
  tags: string[];
  baseScore: number;
  flags: string[];
  breakdown: PhraseBreakdown | null;
  /** Picked again: no longer reported. */
  unpickedAt: null;
  updatedAt: number;
}

export interface ReextractMerge {
  id: string;
  revived: boolean;
  patch: ReextractPatch;
  /**
   * Gemini's reading to merge into the stored pinyin (§5.5.3b), or null to leave the pinyin as
   * it is (the item has no reading: Ollama, or a promoted sentence). Will's override is a
   * separate column and is never touched.
   */
  gemini: string[] | null;
}

export interface ReextractPlan {
  /** Items with no phrase yet: created `queued`, dated to when Will asked (the turn's time). */
  create: ValidItem[];
  /** Existing phrases the new result picks again, in any status: refreshed. */
  merges: ReextractMerge[];
  /** Plain queued phrases first made from this turn that it no longer picks: drop them. */
  dropped: string[];
  /**
   * Active, pinned or asked-again phrases first made from this turn that it no longer picks:
   * reported (`unpicked_at`), not changed. A Phrases filter lists them for a bulk Retire.
   */
  reported: string[];
}

/**
 * A re-run of an extracted turn (§4.6.1, §5.5.6). It replaces what the old reading made of the
 * turn, without counting as Will asking again: no `asked_count` bump, no *asked again*,
 * `last_asked_*` untouched.
 *
 * Every existing phrase it picks, **in any status**, takes the new English, note and breakdown
 * (a breakdown only if it matches the phrase's own hanzi; none keeps the old one) and Gemini's
 * reading for the pinyin merge; its hanzi, cards and FSRS state are never touched. An expired one
 * comes back (to `queued`, or `active` if it was introduced); a dropped one stays dropped (Will's
 * call). A queued phrase first made from this turn also takes the new usefulness, turn kind and
 * tags. Of the phrases first made from this turn that it no longer picks, plain queued ones are
 * dropped; active, pinned or asked-again ones are reported.
 */
export function planReextract(
  turnId: string,
  validation: Pick<Validation, "turnKind" | "items">,
  existing: ReadonlyMap<string, ReextractPhrase>,
  fromTurn: readonly ReextractPhrase[],
  now: number,
  rank: RankConfig = config.rank,
): ReextractPlan {
  const plan: ReextractPlan = { create: [], merges: [], dropped: [], reported: [] };
  const picked = new Set(validation.items.map((i) => i.hanziKey));
  for (const item of validation.items) {
    const p = existing.get(item.hanziKey);
    if (!p) {
      plan.create.push(item);
      continue;
    }
    const revived = p.status === "expired";
    const status: PhraseStatus = revived
      ? p.introducedAt !== null
        ? "active"
        : "queued"
      : p.status;
    const refresh = status === "queued" && p.sourceTurnId === turnId;
    const usefulness = refresh ? item.usefulness : p.usefulness;
    const turnKind = refresh ? validation.turnKind : p.turnKind;
    const tags = refresh ? item.tags : p.tags;
    const heardAs = p.heardAs ?? item.heardAs;
    const examples =
      p.kind === "term"
        ? mergeExamples(
            p.examples,
            item.examples.map((e) => ({ ...e, turn_id: turnId })),
          )
        : p.examples;
    // The phrase keeps its own hanzi and kind, so the new breakdown must fit those.
    const breakdown =
      checkBreakdown(p.kind, p.hanzi, item.breakdown).breakdown ?? p.breakdown ?? null;
    const flags = [...new Set([...p.flags, ...item.flags])].filter((f) => f !== "long");
    if (isLong(p.hanziKey)) flags.push("long");
    // Same key, so Gemini's syllables line up with the phrase's characters (the merge re-checks).
    const gemini = item.pinyin ? [...item.pinyin] : null;
    plan.merges.push({
      id: p.id,
      revived,
      gemini,
      patch: {
        status,
        english: item.english,
        note: item.note,
        heardAs,
        examples,
        usefulness,
        turnKind,
        tags,
        baseScore: baseScore(
          {
            kind: p.kind,
            turnKind,
            heardAs,
            askedCount: p.askedCount,
            usefulness,
            tags,
            hanziKey: p.hanziKey,
          },
          rank,
        ),
        flags,
        breakdown,
        unpickedAt: null,
        updatedAt: now,
      },
    });
  }
  for (const p of fromTurn) {
    if (p.sourceTurnId !== turnId || picked.has(p.hanziKey)) continue;
    const kept = p.pinned || p.askedCount > 1;
    if (p.status === "queued" && !kept) plan.dropped.push(p.id);
    else if (p.status === "active" || (p.status === "queued" && kept)) plan.reported.push(p.id);
  }
  return plan;
}

/**
 * The daily re-score (§4.7): phrases whose stored `base_score` differs from the current formula
 * (weights or the word list changed since it was stored), with their new score.
 */
export function rescored<T extends ScoreInput & { id: string; baseScore: number }>(
  phrases: readonly T[],
  rank: RankConfig = config.rank,
  freq: WordFrequencies = bundledFrequencies(),
): { id: string; baseScore: number }[] {
  return phrases
    .map((p) => ({ id: p.id, before: p.baseScore, baseScore: baseScore(p, rank, freq) }))
    .filter((p) => p.baseScore !== p.before)
    .map(({ id, baseScore: b }) => ({ id, baseScore: b }));
}
