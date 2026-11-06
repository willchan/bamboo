import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Telemetry (DESIGN §7). `type` names the event; `data` is its payload. */
export const event = sqliteTable(
  "event",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("event_type_at_idx").on(t.type, t.at)],
);

export type Event = typeof event.$inferSelect;
