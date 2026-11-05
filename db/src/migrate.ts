// `pnpm db:migrate`: apply migrations to TURSO_DATABASE_URL (default file:db/dev.db). The Vercel
// build runs this first (DESIGN §8.2), against whichever database that environment points at.
import { createDb, migrateDb } from "./client";
import { databaseUrlFromEnv, vercelMigrateProblem } from "./env";

const problem = vercelMigrateProblem();
if (problem) {
  console.error(`db:migrate: ${problem}`);
  process.exit(1);
}

const url = databaseUrlFromEnv();
const db = createDb({ url });
await migrateDb(db);
// Never print a remote URL's query string (it can carry a token); the host is enough.
console.log(`migrated ${url.startsWith("file:") ? url : new URL(url).host}`);
db.$client.close();
