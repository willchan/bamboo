// The phrase queue (DESIGN §4.6–4.7): score and order, validation of extracted items, dedupe into
// existing phrases (asked again, revival), and expiry. Pure: lib/repo applies the results.
import type { PhraseExample, PhraseKind, PhraseStatus, TurnKind } from "@bamboo/db";
import { hanziKey, hasHanzi, normalizeText, type ExtractTurnResult } from "@bamboo/shared";
import { config, type RankConfig } from "../config";

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

/** The stored part of the score; recomputed whenever any input changes. */
export function baseScore(p: ScoreInput, rank: RankConfig = config.rank): number {
  const coreTags: readonly string[] = rank.coreTags;
  let score = rank.kindWeight[p.kind];
  if (p.turnKind) score += rank.turnWeight[p.turnKind];
  if (p.heardAs) score += rank.heardAs;
  score += rank.askedAgain * Math.max(0, p.askedCount - 1);
  if (p.usefulness !== null) score += rank.usefulness * (p.usefulness - rank.usefulnessPivot);
  if (p.tags.some((t) => coreTags.includes(t))) score += rank.coreTag;
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
 * Queue order: pinned first (newest pin first), then `effective_score` descending, then newest.
 * Returns new objects carrying their `effectiveScore` and 1-based `rank`.
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
      if (a.effectiveScore !== b.effectiveScore) return b.effectiveScore - a.effectiveScore;
      return b.createdAt - a.createdAt;
    })
    .map((item, i) => ({ ...item, rank: i + 1 }));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- Validation (§4.6 steps 1–3) ---------------------------------------------------------------

/** A frame's slot. Gemini writes `…`; `...` is accepted too. */
const SLOT = /…|\.{3}/u;

/** Hanzi for storage: normalized (§4.1), on one line. */
export const cleanHanzi = (s: string): string => normalizeText(s).replace(/\n+/gu, " ");

/** Keys are compared on the whole turn: Will's prompt and Gemini's reply. */
export const turnTextKey = (t: { userText: string; replyText: string }): string =>
  hanziKey(`${t.userText}\n${t.replyText}`);

/**
 * The verbatim check: `hanziKey(hanzi)` must occur in the turn's key. A frame's slot (`…`) matches
 * anything, so `阿姨，您是说…吗？` passes on a turn that says `阿姨，您是说要加水吗？`: each part
 * between slots must occur, in order.
 */
export function occursVerbatim(hanzi: string, kind: PhraseKind, turnKey: string): boolean {
  if (!hasHanzi(hanziKey(hanzi))) return false;
  const parts = (kind === "frame" ? hanzi.split(SLOT) : [hanzi])
    .map((p) => hanziKey(p))
    .filter((p) => p !== "");
  let from = 0;
  for (const part of parts) {
    const at = turnKey.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/gu, "");

/** A validated item, ready to become (or merge into) a phrase. */
export interface ValidItem {
  kind: PhraseKind;
  hanzi: string;
  hanziKey: string;
  english: string;
  addressee: string | null;
  heardAs: string | null;
  example: { hanzi: string; english: string | null } | null;
  usefulness: number;
  tags: string[];
  /** `heard_as_dropped`, `example_dropped`. */
  flags: string[];
}

export interface Validation {
  turnKind: TurnKind;
  items: ValidItem[];
  /** Items whose hanzi isn't in the turn (or has no Chinese): the model invented it. */
  droppedNotVerbatim: number;
  /** Items repeating an earlier item's key in the same result. */
  droppedDuplicate: number;
  examplesDropped: number;
  heardAsDropped: number;
}

/**
 * §4.6 steps 1–3 on one `extract_turn` result: drop items not copied from the turn, keep
 * `heard_as` only if Will typed it, keep a term's example only if it is verbatim and contains the
 * term. Items for the same key collapse to the first.
 */
export function validateExtraction(
  t: { userText: string; replyText: string },
  result: ExtractTurnResult,
): Validation {
  const key = turnTextKey(t);
  const user = squash(t.userText);
  const out: Validation = {
    turnKind: result.turn_kind,
    items: [],
    droppedNotVerbatim: 0,
    droppedDuplicate: 0,
    examplesDropped: 0,
    heardAsDropped: 0,
  };
  const seen = new Set<string>();
  for (const raw of result.items) {
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

    const flags: string[] = [];
    let heardAs = raw.heard_as?.trim() || null;
    if (heardAs !== null && !user.includes(squash(heardAs))) {
      heardAs = null;
      flags.push("heard_as_dropped");
      out.heardAsDropped += 1;
    }

    let example: ValidItem["example"] = null;
    if (raw.example && raw.kind === "term") {
      const exHanzi = cleanHanzi(raw.example.hanzi);
      if (occursVerbatim(exHanzi, "sentence", key) && hanziKey(exHanzi).includes(k)) {
        example = { hanzi: exHanzi, english: raw.example.english?.trim() || null };
      } else {
        flags.push("example_dropped");
        out.examplesDropped += 1;
      }
    }

    out.items.push({
      kind: raw.kind,
      hanzi,
      hanziKey: k,
      english: raw.english.trim(),
      addressee: raw.addressee?.trim() || null,
      heardAs,
      example,
      usefulness: raw.usefulness,
      tags: [...new Set(raw.tags.map((x) => x.trim().toLowerCase()).filter(Boolean))],
      flags,
    });
  }
  return out;
}

// --- Dedupe into an existing phrase (§4.6 step 4) -----------------------------------------------

/** Append an example unless one with the same key is there; keep at most `max` (oldest win). */
export function mergeExamples(
  existing: readonly PhraseExample[],
  incoming: PhraseExample | null,
  max: number = config.phrase.maxExamples,
): PhraseExample[] {
  const out = [...existing];
  if (incoming && !out.some((e) => hanziKey(e.hanzi) === hanziKey(incoming.hanzi))) {
    out.push(incoming);
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
}

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
  item: Pick<ValidItem, "heardAs" | "example" | "flags">,
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
      ? mergeExamples(p.examples, item.example && { ...item.example, turn_id: ctx.turnId })
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
      ...(revived ? { droppedAt: null } : {}),
      updatedAt: ctx.now,
    },
  };
}

// --- Expiry (§4.7) ------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/**
 * Queued, unpinned phrases that have sunk below `expireBelow` and are older than `minAgeDays`.
 * Expired phrases come back if asked about again.
 */
export function expiredPhraseIds(
  phrases: readonly {
    id: string;
    status: PhraseStatus;
    pinned: boolean;
    baseScore: number;
    lastAskedAt: number;
    createdAt: number;
  }[],
  now: number,
  q: { expireBelow: number; minAgeDays: number } = config.queue,
  rank: RankConfig = config.rank,
): string[] {
  return phrases
    .filter(
      (p) =>
        p.status === "queued" &&
        !p.pinned &&
        now - p.createdAt > q.minAgeDays * DAY &&
        effectiveScore(p, now, rank) < q.expireBelow,
    )
    .map((p) => p.id);
}
