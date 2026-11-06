import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { TURN_KINDS } from "./phrases";

// Capture (DESIGN §2.2, §2.3): imports, the turns they carried, and the extract_turn job queue.
// Times are integer ms since epoch.

export const IMPORT_KINDS = ["link", "pdf", "text"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_STATUSES = ["extracting", "done"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const JOB_STATUSES = ["queued", "leased", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** One share link, PDF or pasted answer. The SQL table is `import`; `imports` in TypeScript. */
export const imports = sqliteTable(
  "import",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: IMPORT_KINDS }).notNull(),
    origin: text("origin", { enum: ["discord", "web"] }).notNull(),
    /** Share URL or file name; null for text. */
    sourceRef: text("source_ref"),
    conversationTitle: text("conversation_title"),
    discordChannelId: text("discord_channel_id"),
    /** The reply target. Null for web imports, which are never notified. */
    discordMessageId: text("discord_message_id"),
    /** `Idempotency-Key` of the call that created it (`discord:<message id>`). */
    idempotencyKey: text("idempotency_key"),
    turnsTotal: integer("turns_total").notNull(),
    turnsNew: integer("turns_new").notNull().default(0),
    /** `done` once the last chunk arrived and every job is `done` or `failed`. */
    status: text("status", { enum: IMPORT_STATUSES }).notNull(),
    jobsFailed: integer("jobs_failed").notNull().default(0),
    /** New phrases queued from this import's turns, plus dropped/expired ones it revived. */
    phrasesNew: integer("phrases_new").notNull().default(0),
    /** Existing phrases its turns asked about again. */
    phrasesAgain: integer("phrases_again").notNull().default(0),
    /** When the last chunk arrived (`more: false`). Null while chunks are still coming. */
    uploadedAt: integer("uploaded_at"),
    /** The ready-to-post Discord reply, built when the import finishes. */
    summary: text("summary"),
    notifiedAt: integer("notified_at"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    uniqueIndex("import_idempotency_key_unique").on(t.idempotencyKey),
    index("import_created_at_idx").on(t.createdAt),
  ],
);

export type Import = typeof imports.$inferSelect;

/** One user message plus Gemini's reply, stored once (by `turn_key`) for the first import. */
export const turn = sqliteTable(
  "turn",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => imports.id),
    turnKey: text("turn_key").notNull(),
    userText: text("user_text").notNull(),
    /** Normalized; capped at `config.imports.replyMaxChars`. */
    replyText: text("reply_text").notNull(),
    position: integer("position").notNull(),
    kind: text("kind", { enum: TURN_KINDS }),
    extractedAt: integer("extracted_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("turn_turn_key_unique").on(t.turnKey),
    index("turn_import_idx").on(t.importId),
  ],
);

export type Turn = typeof turn.$inferSelect;

/** The job queue (PandaBase's, with one type). `input`/`result` are the §5.3 contracts. */
export const job = sqliteTable(
  "job",
  {
    id: text("id").primaryKey(),
    type: text("type", { enum: ["extract_turn"] }).notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull(),
    /** Denormalized from `input.turn_id`'s import, to count an import's open jobs. */
    importId: text("import_id")
      .notNull()
      .references(() => imports.id),
    input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    attempt: integer("attempt").notNull().default(0),
    leaseExpiresAt: integer("lease_expires_at"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("job_status_created_idx").on(t.status, t.createdAt),
    index("job_import_idx").on(t.importId),
  ],
);

export type Job = typeof job.$inferSelect;
