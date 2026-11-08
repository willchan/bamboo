// Rounds and grading: loads the scheduling state, calls the pure round logic (domain/session.ts)
// and FSRS (domain/fsrs.ts), and writes cards, review logs, rounds and events.
import {
  card,
  event,
  phrase,
  reviewLog,
  round,
  type Card,
  type Db,
  type Phrase,
  type PinyinPairs,
} from "@bamboo/db";
import { and, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { alias } from "drizzle-orm/sqlite-core";
import { dayStart, nextDayStart } from "../domain/day";
import {
  formatInterval,
  GRADES,
  previewIntervals,
  reviewCard,
  type FsrsColumns,
  type Grade,
} from "../domain/fsrs";
import { computePinyin, displayPinyin } from "../domain/pinyin";
import {
  buildRound,
  isFirstSight,
  siblingsToBury,
  todayStatus,
  workload,
  type RoundState,
  type SchedCard,
  type TodayStatus,
} from "../domain/session";
import { eventRow, newId, runBatch } from "./db";
import { orderQueue } from "../domain/queue";
import { dropPhrase, listQueue, queuedPhrasesQuery } from "./phrases";

export interface Clock {
  now: number;
  timeZone: string;
}

const dayOpts = (c: Clock) => ({ timeZone: c.timeZone });

export const fsrsColumns = (c: Card): FsrsColumns => ({
  due: c.due,
  stability: c.stability,
  stabilityFast: c.stabilityFast,
  difficulty: c.difficulty,
  scheduledDays: c.scheduledDays,
  learningSteps: c.learningSteps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state,
  scheduleStatus: c.scheduleStatus,
  lastReview: c.lastReview,
});

const schedCard = (c: Card): SchedCard => ({
  id: c.id,
  phraseId: c.phraseId,
  type: c.type,
  state: c.state,
  due: c.due,
  buriedUntil: c.buriedUntil,
});

/** A phrase's cards in the order they should be introduced: oldest first, Listen before Say. */
const cardOrder = (a: Card, b: Card) =>
  a.createdAt - b.createdAt || (a.type === b.type ? 0 : a.type === "listen" ? -1 : 1);

interface LoadedState {
  state: RoundState;
  dayStart: number;
  dayEnd: number;
  finishedRoundToday: boolean;
}

/** The reads behind `LoadedState`, independent of each other, for one libSQL batch. */
function roundStateQueries(db: Db, start: number) {
  return [
    db
      .select({ card, status: phrase.status })
      .from(card)
      .innerJoin(phrase, eq(card.phraseId, phrase.id))
      .where(and(inArray(phrase.status, ["active", "queued"]), isNull(card.suspendedAt)))
      .orderBy(card.createdAt, card.id),
    queuedPhrasesQuery(db),
    db
      .select({ n: count() })
      .from(reviewLog)
      .where(and(gte(reviewLog.reviewedAt, start), eq(reviewLog.stateBefore, 0))),
    db.select({ n: count() }).from(round).where(gte(round.finishedAt, start)),
  ] as const;
}

type RoundStateRows = BatchResponse<ReturnType<typeof roundStateQueries>>;

function toLoadedState(
  [cards, queued, [introduced], [finished]]: RoundStateRows,
  clock: Clock,
): LoadedState {
  const queue = orderQueue(queued, clock.now);
  const byPhrase = new Map<string, Card[]>();
  for (const r of cards) {
    if (r.status !== "queued") continue;
    byPhrase.set(r.card.phraseId, [...(byPhrase.get(r.card.phraseId) ?? []), r.card]);
  }
  return {
    state: {
      activeCards: cards.filter((r) => r.status === "active").map((r) => schedCard(r.card)),
      queue: queue.map((p) => ({
        phraseId: p.id,
        cards: (byPhrase.get(p.id) ?? []).sort(cardOrder).map(schedCard),
      })),
      introducedToday: introduced?.n ?? 0,
    },
    dayStart: dayStart(clock.now, dayOpts(clock)),
    dayEnd: nextDayStart(clock.now, dayOpts(clock)),
    finishedRoundToday: (finished?.n ?? 0) > 0,
  };
}

/** Everything a round is built from, in one round trip (DESIGN §8.5). */
export async function loadRoundState(db: Db, clock: Clock): Promise<LoadedState> {
  const rows = await db.batch(roundStateQueries(db, dayStart(clock.now, dayOpts(clock))));
  return toLoadedState(rows, clock);
}

export interface Today {
  status: TodayStatus;
  queueSize: number;
  /** "Learn N more" (§4.4): N, or 0 when it isn't offered. */
  learnMore: number;
}

export async function getToday(db: Db, clock: Clock): Promise<Today> {
  return todayFrom(await loadRoundState(db, clock), clock);
}

function todayFrom(loaded: LoadedState, clock: Clock): Today {
  const w = workload(clock.now, loaded.state, { dayEnd: loaded.dayEnd });
  return {
    status: todayStatus(loaded.finishedRoundToday, w),
    queueSize: loaded.state.queue.length,
    learnMore: w.learnMore,
  };
}

/**
 * Build a round now and record it. Null when there's nothing to review. `learnMore` asks for
 * extra new cards beyond today's cap; the engine grants them only once the cap is used up (§4.4).
 */
export async function startRound(
  db: Db,
  clock: Clock,
  opts: { learnMore?: boolean } = {},
): Promise<string | null> {
  const loaded = await loadRoundState(db, clock);
  const slots = buildRound(clock.now, loaded.state, {
    dayEnd: loaded.dayEnd,
    learnMore: opts.learnMore ?? false,
  });
  if (slots.length === 0) return null;
  const id = newId();
  await db.insert(round).values({ id, startedAt: clock.now, cardIds: slots.map((s) => s.cardId) });
  return id;
}

export interface ExampleView {
  hanzi: string;
  english: string | null;
  pinyin: PinyinPairs;
}

/** Everything the review screen needs for one card. */
export interface ReviewCardView {
  cardId: string;
  phraseId: string;
  type: Card["type"];
  kind: Phrase["kind"];
  firstSight: boolean;
  english: string;
  addressee: string | null;
  heardAs: string | null;
  hanzi: string;
  pinyin: PinyinPairs;
  examples: ExampleView[];
  note: string | null;
  /** Grade → label of the next interval ("10m", "4d"). */
  intervals: Record<Grade, string>;
  /**
   * Grade → ms until the card would be due again. The client decides an in-round re-insert
   * (§4.4) from this at once, without waiting for the grade to be saved.
   */
  dueInMsByGrade: Record<Grade, number>;
}

export type IntervalPreview = Pick<ReviewCardView, "intervals" | "dueInMsByGrade">;

async function intervalPreview(c: Card, now: number): Promise<IntervalPreview> {
  const ms = await previewIntervals(c.id, fsrsColumns(c), now);
  return {
    intervals: Object.fromEntries(GRADES.map((g) => [g, formatInterval(ms[g])])) as Record<
      Grade,
      string
    >,
    dueInMsByGrade: ms,
  };
}

async function cardView(c: Card, p: Phrase, now: number): Promise<ReviewCardView> {
  return {
    cardId: c.id,
    phraseId: p.id,
    type: c.type,
    kind: p.kind,
    firstSight: isFirstSight(c),
    english: p.english,
    addressee: p.addressee,
    heardAs: p.heardAs,
    hanzi: p.hanzi,
    pinyin: displayPinyin(p.pinyin, p.pinyinOverride),
    examples: p.examples.map((e) => ({
      hanzi: e.hanzi,
      english: e.english,
      pinyin: computePinyin(e.hanzi),
    })),
    note: p.note,
    ...(await intervalPreview(c, now)),
  };
}

export interface RoundView {
  id: string;
  finished: boolean;
  total: number;
  /** Cards not yet reviewed in this round, in round order. */
  cards: ReviewCardView[];
}

/** The round with the cards still to do (so a reload resumes where Will left off). */
export async function getRound(db: Db, roundId: string, clock: Clock): Promise<RoundView | null> {
  // One round trip: the round, what's been graded in it, and its cards (via json_each).
  const [[r], done, rows] = await db.batch([
    db.select().from(round).where(eq(round.id, roundId)),
    db.select({ cardId: reviewLog.cardId }).from(reviewLog).where(eq(reviewLog.roundId, roundId)),
    db
      .select({ card, phrase })
      .from(card)
      .innerJoin(phrase, eq(card.phraseId, phrase.id))
      .where(
        inArray(
          card.id,
          sql`(select j.value from ${round}, json_each(${round.cardIds}) as j where ${round.id} = ${roundId})`,
        ),
      ),
  ]);
  if (!r) return null;
  const doneIds = new Set(done.map((d) => d.cardId));
  const todo = r.cardIds.filter((id) => !doneIds.has(id));
  const live = new Map(
    rows
      .filter((x) => x.card.suspendedAt === null && x.phrase.status !== "dropped")
      .map((x) => [x.card.id, x]),
  );
  const cards = await Promise.all(
    todo.flatMap((id) => {
      const x = live.get(id);
      return x ? [cardView(x.card, x.phrase, clock.now)] : [];
    }),
  );
  return { id: r.id, finished: r.finishedAt !== null, total: r.cardIds.length, cards };
}

export interface GradeInput {
  roundId: string | null;
  cardId: string;
  grade: Grade;
  source: "session" | "already_know";
  durationMs: number | null;
  /**
   * The client's id for this grade, stored as the review log's id: a retried grade whose first
   * attempt was saved is answered without grading the card twice.
   */
  reviewId?: string;
}

/** The saved grade; `intervals`/`dueInMsByGrade` are fresh, in case the card comes back. */
export interface GradeResult extends IntervalPreview {
  /** How long until the card is due again. */
  dueInMs: number;
}

/**
 * Grade a card. Writes the card's new FSRS state and the review log, buries its siblings until
 * tomorrow, and introduces the phrase (queued → active) the first time one of its cards is seen.
 */
export async function gradeCard(
  db: Db,
  input: GradeInput,
  clock: Clock,
): Promise<GradeResult | null> {
  const now = clock.now;
  const target = alias(card, "target");
  // One round trip: the card with all its siblings and the phrase, and whether this grade was
  // already saved (a retry from the client after a lost response).
  const [rows, saved] = await db.batch([
    db
      .select({ card, phrase })
      .from(card)
      .innerJoin(phrase, eq(card.phraseId, phrase.id))
      .where(
        inArray(
          card.phraseId,
          db.select({ id: target.phraseId }).from(target).where(eq(target.id, input.cardId)),
        ),
      ),
    db
      .select({ id: reviewLog.id })
      .from(reviewLog)
      .where(eq(reviewLog.id, input.reviewId ?? "")),
  ]);
  const row = rows.find((r) => r.card.id === input.cardId);
  if (!row || row.phrase.status === "dropped") return null;
  const { card: c, phrase: p } = row;
  if (saved.length > 0) {
    return { dueInMs: c.due - now, ...(await intervalPreview(c, now)) };
  }
  const outcome = await reviewCard(c.id, fsrsColumns(c), input.grade, now);
  const dayEnd = nextDayStart(now, dayOpts(clock));
  const siblings = rows.map((r) => r.card);

  const writes: BatchItem<"sqlite">[] = [
    db.update(card).set(outcome.next).where(eq(card.id, c.id)),
    db.insert(reviewLog).values({
      id: input.reviewId ?? newId(),
      cardId: c.id,
      rating: input.grade,
      source: input.source,
      stateBefore: c.state,
      roundId: input.roundId,
      reviewedAt: now,
      durationMs: input.durationMs,
      fsrsLog: outcome.log,
    }),
    db
      .insert(event)
      .values(
        eventRow("review", { card_type: c.type, rating: input.grade, source: input.source }, now),
      ),
  ];
  const bury = siblingsToBury(siblings.map(schedCard), c.id);
  if (bury.length)
    writes.push(db.update(card).set({ buriedUntil: dayEnd }).where(inArray(card.id, bury)));
  if (input.roundId) {
    writes.push(
      db
        .update(round)
        .set({ cards: sql`${round.cards} + 1` })
        .where(eq(round.id, input.roundId)),
    );
  }
  if (input.source === "already_know") {
    writes.push(db.insert(event).values(eventRow("already_know", { phrase_id: p.id }, now)));
  }
  if (p.status === "queued" || p.status === "expired") {
    const queue = await listQueue(db, now);
    const ranked = queue.find((q) => q.id === p.id);
    writes.push(
      db
        .update(phrase)
        .set({ status: "active", introducedAt: p.introducedAt ?? now, updatedAt: now })
        .where(eq(phrase.id, p.id)),
      db.insert(event).values(
        eventRow(
          "phrase_introduced",
          {
            phrase_id: p.id,
            rank: ranked?.rank ?? null,
            effective_score: ranked?.effectiveScore ?? null,
            usefulness: p.usefulness,
            kind: p.kind,
          },
          now,
        ),
      ),
    );
  }
  await runBatch(db, writes);

  const next = { ...c, ...outcome.next };
  return { dueInMs: outcome.next.due - now, ...(await intervalPreview(next, now)) };
}

/** Not useful (first sight only): the phrase is dropped and the drop teaches the ranking. */
export async function markNotUseful(db: Db, cardId: string, clock: Clock): Promise<boolean> {
  const c = await db.query.card.findFirst({ where: eq(card.id, cardId) });
  if (!c || !isFirstSight(c)) return false;
  return dropPhrase(db, c.phraseId, clock.now, "not_useful");
}

/** Close the round (idempotent) and say what's next. */
export async function finishRound(db: Db, roundId: string, clock: Clock): Promise<Today | null> {
  // Read the round and Today's state together; finishing changes only "finished a round today".
  const [[r], ...rest] = await db.batch([
    db.select().from(round).where(eq(round.id, roundId)),
    ...roundStateQueries(db, dayStart(clock.now, dayOpts(clock))),
  ]);
  if (!r) return null;
  const loaded = toLoadedState(rest, clock);
  if (r.finishedAt === null) {
    await runBatch(db, [
      db.update(round).set({ finishedAt: clock.now }).where(eq(round.id, roundId)),
      db
        .insert(event)
        .values(
          eventRow("round_finished", { cards: r.cards, ms: clock.now - r.startedAt }, clock.now),
        ),
    ]);
    loaded.finishedRoundToday = true;
  }
  return todayFrom(loaded, clock);
}
