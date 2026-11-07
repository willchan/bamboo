// How `replies` and `nudge` report errors when an OpenClaw command automation runs them
// (DESIGN §5.1 *Automation errors*). OpenClaw announces stdout to #bamboo; with stdout empty it
// announces stderr, and a bare `NO_REPLY` posts nothing. A non-zero exit also counts toward its
// own failure alerts. So:
//
// - transient engine errors (network, timeout, 5xx, 429): `NO_REPLY`, exit 0, details in the
//   local log only. Once the engine has been unreachable for `outageAlertMinutes`, one alert;
//   then quiet until a run succeeds, which posts one "back" line (if the alert went out).
// - anything else (401/403, other 4xx, a response that breaks the contract, missing settings):
//   reported once per distinct error and command (exit 1, the message on stdout, nothing on
//   stderr), then `NO_REPLY` with exit 0 while it repeats. Success clears it.
//
// State lives in `~/.config/bamboo/automation-state.json`; the log in
// `~/Library/Logs/bamboo/bamboo-tools.log` (as the worker's). Neither holds conversation text.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sharedConfig } from "@bamboo/shared";
import { z } from "zod";
import { ApiCallError } from "./api";
import { configDir } from "./env";

const cfg = sharedConfig.tools.automation;

export const NO_REPLY = "NO_REPLY";

export const AUTOMATION_MESSAGES = {
  outage: (since: string) =>
    `⚠️ Bamboo can't reach its server from the Mac (since ${since}). I'll keep trying.`,
  recovered: "✅ Bamboo can reach its server again.",
  error: (command: string, message: string) => `⚠️ bamboo-tools ${command}: ${message}`,
} as const;

const State = z.object({
  /** The engine has been unreachable since `since`; `last` is the latest failing run. */
  outage: z
    .object({ since: z.iso.datetime(), last: z.iso.datetime(), alerted: z.boolean() })
    .nullable()
    .default(null),
  /** The non-transient error last reported, per command. */
  reported: z.record(z.string(), z.string()).default({}),
});
type State = z.infer<typeof State>;

export interface AutomationContext {
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

export const statePath = (env: NodeJS.ProcessEnv) => join(configDir(env), "automation-state.json");
export const logPath = (env: NodeJS.ProcessEnv) =>
  join(env.HOME || homedir(), "Library", "Logs", "bamboo", "bamboo-tools.log");

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Worth waiting out: the engine (or the path to it) is down, slow or busy. */
export function isTransient(e: unknown): boolean {
  if (e instanceof ApiCallError) return e.status === 0 || e.status >= 500 || e.status === 429;
  // A connection dropped while reading a response body escapes `Api.call`'s fetch catch.
  if (!(e instanceof Error)) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  const code = (e as { code?: unknown }).code ?? (e.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  return e instanceof TypeError && /^(fetch failed|terminated)$/u.test(e.message);
}

export function log(env: NodeJS.ProcessEnv, now: Date, line: string): void {
  try {
    const path = logPath(env);
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > cfg.logMaxBytes) renameSync(path, `${path}.1`);
    } catch {
      // no log yet
    }
    appendFileSync(path, `${now.toISOString()} ${line}\n`);
  } catch {
    // Logging must never make the automation post something.
  }
}

function readState(env: NodeJS.ProcessEnv): State {
  try {
    return State.parse(JSON.parse(readFileSync(statePath(env), "utf8")));
  } catch {
    return State.parse({});
  }
}

function writeState(env: NodeJS.ProcessEnv, now: Date, state: State): void {
  try {
    const path = statePath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(state)}\n`);
  } catch (e) {
    log(env, now, `state not saved: ${(e as Error).message}`);
  }
}

/** "10:50" in the Mac's time zone (`TZ`, else the system's). */
function clock(d: Date, env: NodeJS.ProcessEnv): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: env.TZ || undefined,
  }).format(d);
}

const minutes = (ms: number) => ms / 60_000;

/**
 * Runs an automation command's `body` (which returns its stdout text, or `NO_REPLY`) and turns
 * errors into what #bamboo should see. Never writes stderr: OpenClaw would post it.
 */
export async function automation(
  command: string,
  ctx: AutomationContext,
  body: () => Promise<string>,
): Promise<{ code: number; out: string }> {
  const state = readState(ctx.env);
  let out: string;
  try {
    out = await body();
  } catch (e) {
    const now = ctx.now();
    const message = (e as Error).message;
    if (isTransient(e)) {
      let o = state.outage;
      if (!o || minutes(now.getTime() - Date.parse(o.last)) > cfg.outageResetMinutes)
        o = { since: now.toISOString(), last: now.toISOString(), alerted: false };
      else o = { ...o, last: now.toISOString() };
      const down = minutes(now.getTime() - Date.parse(o.since));
      let text = NO_REPLY;
      if (!o.alerted && down >= cfg.outageAlertMinutes) {
        o.alerted = true;
        text = AUTOMATION_MESSAGES.outage(clock(new Date(o.since), ctx.env));
      }
      log(
        ctx.env,
        now,
        `${command} transient (down ${Math.round(down)} min${text === NO_REPLY ? "" : ", alerted"}): ${message}`,
      );
      writeState(ctx.env, now, { ...state, outage: o });
      return { code: 0, out: text };
    }
    log(ctx.env, now, `${command} error: ${message}`);
    if (state.reported[command] === message) return { code: 0, out: NO_REPLY };
    writeState(ctx.env, now, { ...state, reported: { ...state.reported, [command]: message } });
    return { code: 1, out: AUTOMATION_MESSAGES.error(command, message) };
  }

  if (state.outage === null && !(command in state.reported)) return { code: 0, out };
  const now = ctx.now();
  const recovered = state.outage?.alerted && cfg.announceRecovery;
  if (state.outage) log(ctx.env, now, `${command} engine reachable again`);
  const reported = Object.fromEntries(
    Object.entries(state.reported).filter(([k]) => k !== command),
  );
  writeState(ctx.env, now, { outage: null, reported });
  if (!recovered) return { code: 0, out };
  const line = AUTOMATION_MESSAGES.recovered;
  return { code: 0, out: out === NO_REPLY ? line : `${out}\n\n${line}` };
}
