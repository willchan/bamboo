// The phrase queue (DESIGN §4.6, *Score* and *Queue order*). Validation, dedupe, revival and
// expiry are added in M3.
import type { PhraseKind, TurnKind } from "@bamboo/db";
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
