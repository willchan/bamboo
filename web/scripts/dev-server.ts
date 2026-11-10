// Local `next dev` for verifying changes (DESIGN §8.6 "Verification loops"; the `dev-seeded` and
// `dev-prod-copy` entries in .claude/launch.json, `pnpm shot` and the seeded e2e project).
//
//   seeded     a throwaway db/dev-seeded.db (or --db) with the synthetic seed
//              (scripts/seed-data.ts), signed in through DEV_AUTH_BYPASS as the fake dev user.
//   prod-copy  the local prod copy (`make prod-copy` → .scratch/prod-copy.db), same dev sign-in.
//              Refuses unless TURSO_DATABASE_URL (default: the copy) is an existing `file:` URL.
//
// Both blank every secret that could reach a real service (Turso token, Google, machine tokens,
// the read-only prod token): Next keeps a variable that is already set, even to "", over any .env
// file.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { seedFreshFile } from "./seed-file";

export type DevMode = "seeded" | "prod-copy";

const REPO = path.resolve(import.meta.dirname, "..", "..");
export const SEEDED_DB = path.join(REPO, "db", "dev-seeded.db");
export const PROD_COPY_DB = path.join(REPO, ".scratch", "prod-copy.db");

/** Blanked in the child's env so neither process.env nor a .env file can supply them. */
export const BLANKED = [
  "TURSO_AUTH_TOKEN",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AGENT_API_TOKEN",
  "WORKER_API_TOKEN",
  "CRON_SECRET",
  "PROD_RO_TURSO_URL",
  "PROD_RO_TURSO_TOKEN",
];

export interface DevServer {
  env: NodeJS.ProcessEnv;
}

/** Why `url` may not back the prod-copy server, or null when it may. */
export function prodCopyRefusal(url: string | undefined): string | null {
  if (!url) return "TURSO_DATABASE_URL is not set";
  if (!url.startsWith("file:"))
    return "TURSO_DATABASE_URL must be a file: URL (the local prod copy), never a remote database";
  if (!existsSync(url.slice("file:".length)))
    return `${url} does not exist: run \`make prod-copy\` first`;
  return null;
}

export interface PrepareOptions {
  /** Seeded mode: the database file (default db/dev-seeded.db). */
  db?: string;
  /** NEXT_DIST_DIR, so it can run beside `pnpm dev` and the e2e server. */
  distDir?: string;
}

export async function prepareDevServer(
  mode: DevMode,
  base: NodeJS.ProcessEnv = process.env,
  opts: PrepareOptions = {},
): Promise<DevServer> {
  const env: NodeJS.ProcessEnv = {
    ...base,
    DEV_AUTH_BYPASS: "1",
    AUTH_SECRET: "dev-only-secret-not-for-production-use",
    AUTH_TRUST_HOST: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    HOUSEHOLD_TZ: base.HOUSEHOLD_TZ || "America/Los_Angeles",
  };
  for (const k of BLANKED) env[k] = "";
  if (mode === "seeded") {
    const file = opts.db ?? SEEDED_DB;
    await seedFreshFile(file);
    env.TURSO_DATABASE_URL = `file:${file}`;
    env.NEXT_DIST_DIR = opts.distDir ?? ".next-seeded";
  } else {
    const url = base.TURSO_DATABASE_URL || `file:${PROD_COPY_DB}`;
    const refusal = prodCopyRefusal(url);
    if (refusal) throw new Error(`dev-prod-copy refused: ${refusal}`);
    env.TURSO_DATABASE_URL = url;
    env.NEXT_DIST_DIR = opts.distDir ?? ".next-prod-copy";
  }
  return { env };
}

export function startNext(server: DevServer, port: number, quiet = false): ChildProcess {
  return spawn("pnpm", ["exec", "next", "dev", "--port", String(port)], {
    cwd: path.join(REPO, "web"),
    env: server.env,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "seeded" },
      port: { type: "string" },
      db: { type: "string" },
      "dist-dir": { type: "string" },
    },
  });
  const mode = values.mode as DevMode;
  if (mode !== "seeded" && mode !== "prod-copy") {
    console.error("--mode must be seeded or prod-copy");
    process.exit(2);
  }
  const port = Number(values.port ?? process.env.PORT ?? 3000);
  try {
    const server = await prepareDevServer(mode, process.env, {
      db: values.db && path.resolve(values.db),
      distDir: values["dist-dir"],
    });
    // Never print the copy's contents; the path is enough.
    console.log(
      mode === "seeded"
        ? `dev-seeded: ${server.env.TURSO_DATABASE_URL}, dev sign-in`
        : "dev-prod-copy: .scratch/prod-copy.db, dev sign-in (writes land in the copy only)",
    );
    const child = startNext(server, port);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
    child.on("exit", (code) => process.exit(code ?? 0));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
