// `pnpm db:seed`: synthetic phrases for local dev (scripts/seed-data.ts; CLAUDE.md › Privacy:
// invented content only). Idempotent. Refuses anything but a local database, so it can never
// touch Turso.
import { createDb, databaseUrlFromEnv, migrateDb } from "@bamboo/db";
import { SEEDS, seedDb } from "./seed-data";

const url = databaseUrlFromEnv();
if (!url.startsWith("file:") && url !== ":memory:") {
  console.error(
    "db:seed only seeds a local database (file:…); TURSO_DATABASE_URL points elsewhere.",
  );
  process.exit(1);
}

const db = createDb({ url });
await migrateDb(db);
const added = await seedDb(db);
console.log(
  `seeded ${added} synthetic phrases (${SEEDS.length - added} already there) into ${url}`,
);
db.$client.close();
