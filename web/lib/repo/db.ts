// The app's database handle: one per server process (kept on globalThis so dev hot reloads don't
// open a new client each time). Repo functions take a `Db` so tests can pass `createTestDb()`.
import { createDb, event, type Db } from "@bamboo/db";
import type { BatchItem } from "drizzle-orm/batch";
import { ulid } from "ulid";

const holder = globalThis as unknown as { __bambooDb?: Db };

export function getDb(): Db {
  holder.__bambooDb ??= createDb();
  return holder.__bambooDb;
}

export const newId = (): string => ulid();

/** Run writes atomically (libSQL batch = one implicit transaction). No-op when empty. */
export async function runBatch(db: Db, writes: BatchItem<"sqlite">[]): Promise<void> {
  if (writes.length === 0) return;
  await db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/** Telemetry (DESIGN §7). */
export function eventRow(type: string, data: Record<string, unknown>, at: number) {
  return { id: newId(), type, data, at } satisfies typeof event.$inferInsert;
}
