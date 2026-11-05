import { fileURLToPath } from "node:url";

/**
 * Absolute path of `rel` resolved against this directory. A function rather than an inline
 * `new URL("literal", import.meta.url)` so bundlers (Next/Turbopack, when /web imports this
 * package) don't try to bundle the target as an asset.
 */
export const packagePath = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** Local default: `db/dev.db`, resolved absolutely so every package's scripts share one file. */
export const DEFAULT_DATABASE_URL = `file:${packagePath("../dev.db")}`;

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.TURSO_DATABASE_URL || DEFAULT_DATABASE_URL;
}

/**
 * On a Vercel build, migrations must target that environment's Turso database. A missing or
 * local URL there means the env vars aren't set, so fail loudly instead of migrating a throwaway
 * file and deploying code against an unmigrated database.
 */
export function vercelMigrateProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.VERCEL) return null;
  const url = env.TURSO_DATABASE_URL ?? "";
  if (!url || url.startsWith("file:") || url === ":memory:") {
    return `TURSO_DATABASE_URL must be a Turso URL on Vercel (VERCEL_ENV=${env.VERCEL_ENV ?? "?"}).`;
  }
  if (!env.TURSO_AUTH_TOKEN) {
    return `TURSO_AUTH_TOKEN is not set on Vercel (VERCEL_ENV=${env.VERCEL_ENV ?? "?"}).`;
  }
  return null;
}
