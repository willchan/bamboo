import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Neural TTS clips (DESIGN §2.3, §6.1), stored by content: `key` is the sha256 of voice, output
 * format and SSML (web/lib/domain/tts.ts), so a changed reading or hanzi gets a new row. The daily
 * cron prunes clips not played for `config.audio.neural.retainDays`.
 */
export const ttsClip = sqliteTable("tts_clip", {
  key: text("key").primaryKey(),
  /** The MP3. */
  audio: blob("audio", { mode: "buffer" }).$type<Buffer>().notNull(),
  /** Characters sent to Azure for it (SSML, pins included). */
  chars: integer("chars").notNull(),
  createdAt: integer("created_at").notNull(),
  lastPlayedAt: integer("last_played_at"),
});

export type TtsClip = typeof ttsClip.$inferSelect;
