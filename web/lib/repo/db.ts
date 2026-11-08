// The app's database handle: one per server process (kept on globalThis so dev hot reloads don't
// open a new client each time). Repo functions take a `Db` so tests can pass `createTestDb()`.
import { createDb, event, type Db } from "@bamboo/db";
import type { BatchItem } from "drizzle-orm/batch";
import { monotonicFactory } from "ulid";
import { instrumentClient } from "../timing";

const holder = globalThis as unknown as { __bambooDb?: Db };

export function getDb(): Db {
  if (!holder.__bambooDb) {
    const db = createDb();
    // Request timing (DESIGN §8.5): count and time this client's calls per request.
    instrumentClient(db.$client);
    holder.__bambooDb = db;
  }
  return holder.__bambooDb;
}

/** ULIDs, monotonic within a millisecond, so rows written together (jobs) sort in write order. */
const ulid = monotonicFactory();
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
