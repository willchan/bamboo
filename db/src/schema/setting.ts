import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Key/value settings (DESIGN §2.3), e.g. `nudge_enabled`, `nudge_last_sent_day`. */
export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Setting = typeof setting.$inferSelect;
