// A fresh local database file, migrated and seeded relative to *now* (due reviews, today's
// learning cards and recent imports are current whenever it runs). Used by the `dev:seeded`
// server, `pnpm shot` and the seeded e2e project. Synthetic data only.
import { createDb, migrateDb } from "@bamboo/db";
import { rmSync } from "node:fs";
import { seedDb } from "./seed-data";

export async function seedFreshFile(file: string): Promise<void> {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  const db = createDb({ url: `file:${file}`, authToken: "" });
  try {
    await migrateDb(db);
    await seedDb(db);
  } finally {
    db.$client.close();
  }
}
