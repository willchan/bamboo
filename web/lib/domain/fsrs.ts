// Scheduling (DESIGN §4.3): ts-fsrs 6's DefaultScheduler (FSRS-7) with `config.fsrs`. This module
// converts between our card columns and the scheduler's card, and never touches the database.
import { DefaultScheduler, Rating } from "ts-fsrs";
import { config } from "../config";

export { Rating };
/** Again 1, Hard 2, Good 3, Easy 4. */
export type Grade = 1 | 2 | 3 | 4;
export const GRADES: readonly Grade[] = [1, 2, 3, 4];

import { State } from "./state";
export { State };

/** The FSRS columns of a `card` row (DESIGN §2.1). Times are ms since epoch. */
export interface FsrsColumns {
  due: number;
  stability: number;
  stabilityFast: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  scheduleStatus: string;
  lastReview: number | null;
}

/**
 * The part of the ts-fsrs scheduler we use. Its own types are a union over model versions, too
 * wide to pass a card through; this keeps the call sites simple and checked at our boundary.
 */
interface Scheduler {
  review(args: { card: SchedulerCard; grade: Grade; now: Date }): {
    card: unknown;
    revlog: unknown;
  };
  preview(args: { card: SchedulerCard; now: Date }): Iterable<{ grade: number; card: unknown }>;
}
type SchedulerCard = { readonly __brand: "SchedulerCard" };

let cached: Promise<Scheduler> | undefined;
/** The shared scheduler, created once (DefaultScheduler is async). */
export function scheduler(): Promise<Scheduler> {
  cached ??= DefaultScheduler({
    version: config.fsrs.version,
    desiredRetention: config.fsrs.desiredRetention,
    maximumInterval: config.fsrs.maximumInterval,
    enableFuzz: config.fsrs.enableFuzz,
    enableShortTerm: config.fsrs.enableShortTerm,
    learningSteps: [...config.fsrs.learningSteps],
    relearningSteps: [...config.fsrs.relearningSteps],
    allowModelOverride: config.fsrs.allowModelOverride,
  }) as unknown as Promise<Scheduler>;
  return cached;
}

/** A brand-new card (FSRS state New), due at creation. */
export function newCardColumns(now: number): FsrsColumns {
  return {
    due: now,
    stability: 0,
    stabilityFast: 0,
    difficulty: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    scheduleStatus: "new",
    lastReview: null,
  };
}

function toSchedulerCard(cardId: string, c: FsrsColumns): SchedulerCard {
  return {
    cardId,
    dueAt: new Date(c.due),
    lastReviewAt: c.lastReview === null ? null : new Date(c.lastReview),
    stability: c.stability,
    stabilityFast: c.stabilityFast,
    difficulty: c.difficulty,
    scheduledDays: c.scheduledDays,
    learningStep: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    scheduleStatus: c.scheduleStatus,
  } as unknown as SchedulerCard;
}

interface SchedulerCardOut {
  dueAt: Date;
  lastReviewAt: Date | null;
  stability: number;
  stabilityFast?: number;
  difficulty: number;
  scheduledDays: number;
  learningStep: number;
  reps: number;
  lapses: number;
  state: number;
  scheduleStatus: string;
}

function fromSchedulerCard(card: unknown): FsrsColumns {
  const c = card as SchedulerCardOut;
  return {
    due: c.dueAt.getTime(),
    lastReview: c.lastReviewAt ? c.lastReviewAt.getTime() : null,
    stability: c.stability,
    stabilityFast: c.stabilityFast ?? 0,
    difficulty: c.difficulty,
    scheduledDays: c.scheduledDays,
    learningSteps: c.learningStep,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    scheduleStatus: c.scheduleStatus,
  };
}

/** JSON-safe copy of a ts-fsrs review log (Dates → ms). */
function serializeLog(revlog: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(revlog as Record<string, unknown>)) {
    out[k] = v instanceof Date ? v.getTime() : v;
  }
  return out;
}

export interface ReviewOutcome {
  next: FsrsColumns;
  /** The ts-fsrs review log, JSON-safe, for `review_log.fsrs_log`. */
  log: Record<string, unknown>;
}

/** Grade a card at `now`. Pure apart from the cached scheduler; never mutates `current`. */
export async function reviewCard(
  cardId: string,
  current: FsrsColumns,
  grade: Grade,
  now: number,
): Promise<ReviewOutcome> {
  const s = await scheduler();
  const result = s.review({ card: toSchedulerCard(cardId, current), grade, now: new Date(now) });
  return { next: fromSchedulerCard(result.card), log: serializeLog(result.revlog) };
}

/** For each grade, how long until the card would be due again (ms), for the grade buttons. */
export async function previewIntervals(
  cardId: string,
  current: FsrsColumns,
  now: number,
): Promise<Record<Grade, number>> {
  const s = await scheduler();
  const out = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<Grade, number>;
  for (const item of s.preview({ card: toSchedulerCard(cardId, current), now: new Date(now) })) {
    const grade = item.grade as Grade;
    out[grade] = Math.max(0, fromSchedulerCard(item.card).due - now);
  }
  return out;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact interval label for a grade button: `<1m`, `10m`, `3h`, `4d`, `2mo`, `1.2y`. */
export function formatInterval(ms: number): string {
  if (ms < MINUTE) return "<1m";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  const years = Math.round((days / 365) * 10) / 10;
  return `${years}y`;
}
