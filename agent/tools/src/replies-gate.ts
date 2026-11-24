// When `replies` needs to ask the engine for finished imports (DESIGN §10 #110). The engine has
// nothing to say unless an import is unfinished, and every call spends Vercel free-tier CPU, so
// idle runs are skipped locally: imports made through this CLI mark the gate "pending" for a
// while, and a slow safety poll covers anything else. State is a tiny file beside the others.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sharedConfig } from "@bamboo/shared";
import { z } from "zod";
import { configDir } from "./env";

const cfg = sharedConfig.tools.automation.replies;

const Gate = z.object({
  /** ms since epoch of the last successful poll, or null. */
  lastPoll: z.number().nullable().default(null),
  /** ms since epoch of the latest import with a reply target, or null. */
  pendingSince: z.number().nullable().default(null),
});
type Gate = z.infer<typeof Gate>;

const path = (env: NodeJS.ProcessEnv) => join(configDir(env), "replies-gate.json");

function read(env: NodeJS.ProcessEnv): Gate {
  try {
    return Gate.parse(JSON.parse(readFileSync(path(env), "utf8")));
  } catch {
    return Gate.parse({});
  }
}

function write(env: NodeJS.ProcessEnv, g: Gate): void {
  try {
    mkdirSync(dirname(path(env)), { recursive: true, mode: 0o700 });
    writeFileSync(path(env), `${JSON.stringify(g)}\n`);
  } catch {
    // Best effort: without the file every run polls, which is the old behaviour.
  }
}

const MIN = 60_000;

/** Should this run ask the engine? */
export function repliesDue(env: NodeJS.ProcessEnv, now: Date): boolean {
  const g = read(env);
  if (g.pendingSince !== null) return true;
  return g.lastPoll === null || now.getTime() - g.lastPoll >= cfg.safetyPollMinutes * MIN;
}

/** An import with a reply target was uploaded: poll every run for a while. */
export function markImportPending(env: NodeJS.ProcessEnv, now: Date): void {
  write(env, { ...read(env), pendingSince: now.getTime() });
}

/** A poll succeeded; `found` is how many notifications it returned. */
export function recordPoll(env: NodeJS.ProcessEnv, now: Date, found: number): void {
  const g = read(env);
  const settled =
    found === 0 &&
    g.pendingSince !== null &&
    now.getTime() - g.pendingSince >= cfg.pendingMinutes * MIN;
  write(env, { lastPoll: now.getTime(), pendingSince: settled ? null : g.pendingSince });
}
