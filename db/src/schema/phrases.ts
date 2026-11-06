import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Phrases, cards, reviews and rounds (DESIGN §2.1). Times are integer ms since epoch.

export const PHRASE_STATUSES = ["queued", "active", "dropped", "expired"] as const;
export type PhraseStatus = (typeof PHRASE_STATUSES)[number];

export const PHRASE_KINDS = ["term", "frame", "sentence"] as const;
export type PhraseKind = (typeof PHRASE_KINDS)[number];

export const CARD_TYPES = ["say", "listen"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const TURN_KINDS = ["decode", "say", "errand", "other"] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

export const REVIEW_SOURCES = ["session", "already_know", "asked_again"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

/** One example sentence for a term (verbatim from Gemini for imports; typed by Will by hand). */
export interface PhraseExample {
  hanzi: string;
  english: string | null;
  turn_id: string | null;
}

/** Per-character pinyin: `[char, syllable]`, with `null` for non-hanzi (punctuation, Latin). */
export type PinyinPairs = [string, string | null][];

export const phrase = sqliteTable(
  "phrase",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: PHRASE_STATUSES }).notNull(),
    kind: text("kind", { enum: PHRASE_KINDS }).notNull(),
    hanzi: text("hanzi").notNull(),
    hanziKey: text("hanzi_key").notNull(),
    english: text("english").notNull(),
    addressee: text("addressee"),
    heardAs: text("heard_as"),
    examples: text("examples", { mode: "json" })
      .$type<PhraseExample[]>()
      .notNull()
      .default(sql`'[]'`),
    note: text("note"),
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    pinyin: text("pinyin", { mode: "json" }).$type<PinyinPairs>().notNull(),
    pinyinOverride: text("pinyin_override", { mode: "json" }).$type<PinyinPairs>(),
    usefulness: integer("usefulness"),
    turnKind: text("turn_kind", { enum: TURN_KINDS }),
    baseScore: real("base_score").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    /** When `pinned` was last set; orders pins newest first. Null when unpinned. */
    pinnedAt: integer("pinned_at"),
    source: text("source", { enum: ["manual", "import"] }).notNull(),
    /**
     * The turn that first produced it (`turn.id`). A plain column, no FK constraint: SQLite can add
     * one only by rebuilding the table, which isn't an expand-only change (PLAN M3 Notes).
     */
    sourceTurnId: text("source_turn_id"),
    /** The import that last bumped `asked_count` (or created it): at most one bump per import. */
    lastAskedImportId: text("last_asked_import_id"),
    askedCount: integer("asked_count").notNull().default(1),
    lastAskedAt: integer("last_asked_at").notNull(),
    flags: text("flags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    introducedAt: integer("introduced_at"),
    droppedAt: integer("dropped_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("phrase_hanzi_key_unique").on(t.hanziKey),
    index("phrase_status_idx").on(t.status),
  ],
);

export type Phrase = typeof phrase.$inferSelect;
export type NewPhrase = typeof phrase.$inferInsert;

/**
 * One card per phrase and type. The FSRS columns mirror the ts-fsrs 6 scheduler card
 * (`DefaultScheduler`, FSRS-7); `web/lib/domain/fsrs.ts` converts both ways.
 */
export const card = sqliteTable(
  "card",
  {
    id: text("id").primaryKey(),
    phraseId: text("phrase_id")
      .notNull()
      .references(() => phrase.id),
    type: text("type", { enum: CARD_TYPES }).notNull(),
    due: integer("due").notNull(),
    stability: real("stability").notNull().default(0),
    stabilityFast: real("stability_fast").notNull().default(0),
    difficulty: real("difficulty").notNull().default(0),
    scheduledDays: real("scheduled_days").notNull().default(0),
    learningSteps: integer("learning_steps").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    /** ts-fsrs `State`: 0 New, 1 Learning, 2 Review, 3 Relearning. */
    state: integer("state").notNull().default(0),
    /** ts-fsrs `scheduleStatus` ('new' | 'learning' | 'review' | 'relearning' | …). */
    scheduleStatus: text("schedule_status").notNull().default("new"),
    lastReview: integer("last_review"),
    buriedUntil: integer("buried_until"),
    /** Set when Will turns this card type off in the editor; kept so its history survives. */
    suspendedAt: integer("suspended_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("card_phrase_type_unique").on(t.phraseId, t.type),
    index("card_due_idx").on(t.due),
  ],
);

export type Card = typeof card.$inferSelect;
export type NewCard = typeof card.$inferInsert;

/** A review round (DESIGN §4.4). `card_ids` is the round as built; `cards` counts reviews done. */
export const round = sqliteTable("round", {
  id: text("id").primaryKey(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  cards: integer("cards").notNull().default(0),
  cardIds: text("card_ids", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
});

export type Round = typeof round.$inferSelect;

/** Append-only. `fsrs_log` is the ts-fsrs review log (the card as it was before this review). */
export const reviewLog = sqliteTable(
  "review_log",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => card.id),
    rating: integer("rating").notNull(),
    source: text("source", { enum: REVIEW_SOURCES }).notNull(),
    /** The ts-fsrs state before this review (0 = New): "introduced today" counts these. */
    stateBefore: integer("state_before").notNull(),
    roundId: text("round_id").references(() => round.id),
    reviewedAt: integer("reviewed_at").notNull(),
    durationMs: integer("duration_ms"),
    fsrsLog: text("fsrs_log", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index("review_log_reviewed_at_idx").on(t.reviewedAt),
    index("review_log_card_idx").on(t.cardId),
  ],
);

export type ReviewLog = typeof reviewLog.$inferSelect;
