// Rounds (DESIGN §4.4): what goes into a round, in what order, what happens on Again inside it,
// and whether Will is done for today. Pure: the repo layer loads the state and persists results.
import type { CardType } from "@bamboo/db";
import { config, type SessionConfig } from "../config";
import { State } from "./state";

export interface SchedCard {
  id: string;
  phraseId: string;
  type: CardType;
  /** ts-fsrs state: 0 New, 1 Learning, 2 Review, 3 Relearning. */
  state: number;
  due: number;
  buriedUntil: number | null;
}

export interface RoundState {
  /** Unsuspended cards of `active` phrases. */
  activeCards: readonly SchedCard[];
  /** `queued` phrases in queue order (§4.6), each with its unsuspended cards, first card first. */
  queue: readonly { phraseId: string; cards: readonly SchedCard[] }[];
  /** New cards first shown since the start of today (Not useful doesn't count). */
  introducedToday: number;
}

export type SlotKind = "learning" | "review" | "new";
export interface RoundSlot {
  cardId: string;
  phraseId: string;
  kind: SlotKind;
}

export interface RoundOptions {
  /** Start of the next household day (§4.3): "due today" means due before this. */
  dayEnd: number;
  session?: SessionConfig;
  /** Seeds the order of the learning cards; defaults to `now`, so each round differs. */
  seed?: number;
}

const isLearning = (c: SchedCard) => c.state === State.Learning || c.state === State.Relearning;
const isBuried = (c: SchedCard, now: number) => c.buriedUntil !== null && c.buriedUntil > now;

interface Candidates {
  learning: SchedCard[];
  review: SchedCard[];
  fresh: SchedCard[];
  newAllowance: number;
}

/**
 * Everything eligible right now, before the round-size cap. One card per phrase: the first
 * eligible card of a phrase wins (learning before review before new), its siblings wait.
 */
function candidates(now: number, state: RoundState, opts: RoundOptions): Candidates {
  const s = opts.session ?? config.session;
  const learnAhead = now + s.learnAheadMinutes * 60_000;
  const open = state.activeCards.filter((c) => !isBuried(c, now));

  const learning = open.filter((c) => isLearning(c) && c.due <= learnAhead).sort(byDue);
  const review = open.filter((c) => c.state === State.Review && c.due < opts.dayEnd).sort(byDue);
  const activeNew = open.filter((c) => c.state === State.New);
  const queuedNew = state.queue.flatMap(({ cards }) => {
    const first = cards.find((c) => c.state === State.New && !isBuried(c, now));
    return first ? [first] : [];
  });

  const seen = new Set<string>();
  const onePerPhrase = (cards: SchedCard[]) =>
    cards.filter((c) => (seen.has(c.phraseId) ? false : (seen.add(c.phraseId), true)));

  return {
    learning: onePerPhrase(learning),
    review: onePerPhrase(review),
    fresh: onePerPhrase([...activeNew, ...queuedNew]),
    newAllowance: Math.max(0, s.newPerDay - state.introducedToday),
  };
}

const byDue = (a: SchedCard, b: SchedCard) => a.due - b.due;

/**
 * Build a round of up to `roundSize` cards: learning cards whose step is due (in a per-round
 * order), then review cards due today (most overdue first), with new cards interleaved roughly one
 * per `newEvery` cards. Due cards take priority over new ones; new cards are capped by `newPerDay`
 * minus today's.
 */
export function buildRound(now: number, state: RoundState, opts: RoundOptions): RoundSlot[] {
  const s = opts.session ?? config.session;
  const c = candidates(now, state, opts);

  // Learning cards: the earliest-due ones if there are too many, then in a per-round order
  // (§10 #57). By due alone, the card graded first in one round always led the next one.
  const learning = seededShuffle(c.learning.slice(0, s.roundSize), opts.seed ?? now);
  const due: RoundSlot[] = [
    ...learning.map((x) => slot(x, "learning")),
    ...c.review.map((x) => slot(x, "review")),
  ].slice(0, s.roundSize);
  const nNew = Math.min(c.newAllowance, c.fresh.length, s.roundSize - due.length);
  const fresh = c.fresh.slice(0, nNew).map((x) => slot(x, "new"));

  return interleave(due, fresh, s.newEvery);
}

/** A deterministic shuffle (Fisher–Yates driven by mulberry32, seeded by `seed`). */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let a = (seed ^ Math.floor(seed / 2 ** 32)) >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const slot = (c: SchedCard, kind: SlotKind): RoundSlot => ({
  cardId: c.id,
  phraseId: c.phraseId,
  kind,
});

/** Due cards with one new card at every `every`-th position (d d N d d N …), extras at the end. */
export function interleave<T>(due: readonly T[], fresh: readonly T[], every: number): T[] {
  const out: T[] = [];
  let d = 0;
  let n = 0;
  while (d < due.length || n < fresh.length) {
    const newTurn = out.length % every === every - 1;
    if ((newTurn && n < fresh.length) || d >= due.length) out.push(fresh[n++]!);
    else out.push(due[d++]!);
  }
  return out;
}

export interface Workload {
  /** Learning cards due now (with learn-ahead) plus review cards due today. */
  due: number;
  /** New cards still allowed today and available. */
  newAvailable: number;
  /** Cards the next round would hold. */
  roundCards: number;
}

/** What a round started now would contain, in counts (Today's "1 round · N due · M new"). */
export function workload(now: number, state: RoundState, opts: RoundOptions): Workload {
  const s = opts.session ?? config.session;
  const c = candidates(now, state, opts);
  const due = c.learning.length + c.review.length;
  const newAvailable = Math.min(c.newAllowance, c.fresh.length);
  return { due, newAvailable, roundCards: buildRound(now, state, { ...opts, session: s }).length };
}

export type TodayStatus =
  { kind: "start"; workload: Workload } | { kind: "done"; another: Workload | null };

/**
 * Today's state. The daily goal is met by one finished round, or by having nothing to do. After
 * that it's "✓ Done for today", plus "Another round (N due)" when something is still waiting.
 */
export function todayStatus(finishedRoundToday: boolean, w: Workload): TodayStatus {
  const nothingToDo = w.roundCards === 0;
  if (!finishedRoundToday && !nothingToDo) return { kind: "start", workload: w };
  return { kind: "done", another: nothingToDo ? null : w };
}

/**
 * Again (or any grade that lands on a short learning step) inside a round: the card comes back
 * after its step if that falls inside the round, judged by `secondsPerCard` per remaining card.
 * Returns the index in `remaining` to insert before, or null to leave it for a later round.
 */
export function reinsertIndex(
  remaining: number,
  dueInMs: number,
  session: SessionConfig = config.session,
): number | null {
  const cardsToWait = Math.max(1, Math.ceil(dueInMs / (session.secondsPerCard * 1000)));
  return cardsToWait <= remaining ? cardsToWait : null;
}

/**
 * Sibling burying: once a card of a phrase has been shown today, its other cards wait until
 * tomorrow. Cards mid-learning keep their steps.
 */
export function siblingsToBury(phraseCards: readonly SchedCard[], shownCardId: string): string[] {
  return phraseCards.filter((c) => c.id !== shownCardId && !isLearning(c)).map((c) => c.id);
}

/** Not useful / Already know are offered the first time a card is seen. */
export const isFirstSight = (c: { state: number }) => c.state === State.New;

/** New cards first shown today: review logs since `dayStart` whose card was New before. */
export function introducedSince(
  logs: readonly { stateBefore: number; reviewedAt: number }[],
  dayStart: number,
): number {
  return logs.filter((l) => l.stateBefore === State.New && l.reviewedAt >= dayStart).length;
}

/**
 * Asked again (§4.4, §4.6): when an import shows Will asked about an `active` phrase again, every
 * card that has been reviewed gets Again (`source: 'asked_again'`), at most once per phrase per
 * import. Returns the card ids to grade.
 */
export function askedAgainCards(
  phrase: { status: string },
  cards: readonly { id: string; reps: number }[],
  alreadyAppliedForImport: boolean,
): string[] {
  if (phrase.status !== "active" || alreadyAppliedForImport) return [];
  return cards.filter((c) => c.reps > 0).map((c) => c.id);
}
