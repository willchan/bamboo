// `pnpm --filter web repinyin`: recompute stored phrase pinyin after a context-rule fix (DESIGN
// §4.2). The Vercel build runs it right after `db:migrate`, against the same database. Idempotent;
// prints a count only.
import { createDb, databaseUrlFromEnv } from "@bamboo/db";
import { recomputeStoredPinyin } from "../lib/repo/phrases";

const db = createDb({ url: databaseUrlFromEnv() });
const changed = await recomputeStoredPinyin(db);
console.log(`repinyin: ${changed} phrase(s) updated`);
db.$client.close();
