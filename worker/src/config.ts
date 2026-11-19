// The worker's settings (DESIGN §8.1): read from the environment, which `loadEnvFile` fills from
// `~/.config/bamboo/worker.env` (ops/worker.env.example documents every variable). The file wins
// over the inherited environment.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { sharedConfig } from "@bamboo/shared";

const D = sharedConfig.worker.defaults;

export interface WorkerConfig {
  /** The State Engine's origin, without a trailing slash. */
  apiUrl: string;
  token: string;
  ollamaUrl: string;
  model: string;
  pollIntervalMs: number;
  /** The model, and each key's own limits (DESIGN §5.5.7, §10 #88). */
  gemini: { model: string; free: GeminiLimits; paid: GeminiLimits };
  /** The name deny-list's path (`BAMBOO_NAMES_DENY`, else the default). */
  namesDenyPath: string;
}

export interface GeminiLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

/** `BAMBOO_WORKER_ENV`, else the default path with `~` expanded. */
export function envFilePath(env: Env = process.env, home: string = homedir()): string {
  const p = env.BAMBOO_WORKER_ENV?.trim() || D.envFile;
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

export interface EnvFileStatus {
  path: string;
  loaded: boolean;
  /** Variables set from the file (names only). */
  keys: string[];
  /** The file is readable or writable by the group or others (it holds the worker token). */
  tooOpen: boolean;
}

/**
 * Copy the file's variables into `env`, **overriding** ones already set: the file wins (DESIGN
 * §8.1, §10 #44). Its keys are generic (`WORKER_API_TOKEN`, `OLLAMA_URL`), so a shell or job that
 * inherited another app's value must not replace Bamboo's. An empty value in the file sets the
 * key empty, i.e. "use the default". Keys the file doesn't list still come from the environment.
 * A missing file is not an error here; `readConfig` reports what's missing.
 */
export function loadEnvFile(path: string, env: Env = process.env): EnvFileStatus {
  let text: string;
  let mode: number;
  try {
    mode = statSync(path).mode;
    text = readFileSync(path, "utf8");
  } catch {
    return { path, loaded: false, keys: [], tooOpen: false };
  }
  const keys: string[] = [];
  for (const [k, v] of Object.entries(parseEnv(text))) {
    env[k] = v;
    keys.push(k);
  }
  return { path, loaded: true, keys, tooOpen: (mode & 0o077) !== 0 };
}

/** The settings, or a ConfigError naming every missing or bad variable (never their values). */
export function readConfig(env: Env = process.env): WorkerConfig {
  const problems: string[] = [];
  const get = (k: string) => env[k]?.trim() || undefined;

  const apiUrl = get("BAMBOO_API_URL");
  if (!apiUrl) problems.push("BAMBOO_API_URL is not set");
  else if (!/^https?:\/\/[^/]+/u.test(apiUrl))
    problems.push("BAMBOO_API_URL is not an http(s) URL");

  const token = get("WORKER_API_TOKEN");
  if (!token) problems.push("WORKER_API_TOKEN is not set");

  const ollamaUrl = get("OLLAMA_URL") ?? D.ollamaUrl;
  if (!/^https?:\/\/[^/]+/u.test(ollamaUrl)) problems.push("OLLAMA_URL is not an http(s) URL");

  const pollRaw = get("POLL_INTERVAL_SECONDS");
  const poll = pollRaw === undefined ? D.pollIntervalSeconds : Number(pollRaw);
  if (!Number.isFinite(poll) || poll < 1 || poll > 3600) {
    problems.push("POLL_INTERVAL_SECONDS must be a number from 1 to 3600");
  }

  const G = sharedConfig.worker.gemini;
  const limit = (k: string, dflt: number) => {
    const raw = get(k);
    const n = raw === undefined ? dflt : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) {
      problems.push(`${k} must be a whole number from 1 to 100000`);
      return dflt;
    }
    return n;
  };
  const gemini = {
    model: get("GEMINI_MODEL") ?? G.model,
    free: {
      requestsPerMinute: limit("GEMINI_RPM", G.requestsPerMinute),
      requestsPerDay: limit("GEMINI_RPD", G.requestsPerDay),
    },
    paid: {
      requestsPerMinute: limit("GEMINI_PAID_RPM", G.paid.requestsPerMinute),
      requestsPerDay: limit("GEMINI_PAID_RPD", G.paid.requestsPerDay),
    },
  };

  if (problems.length > 0) throw new ConfigError(problems.join("; "));
  return {
    apiUrl: apiUrl!.replace(/\/+$/u, ""),
    token: token!,
    ollamaUrl: ollamaUrl.replace(/\/+$/u, ""),
    model: get("OLLAMA_TEXT_MODEL") ?? D.model,
    pollIntervalMs: Math.round(poll * 1000),
    gemini,
    namesDenyPath: expandHome(get("BAMBOO_NAMES_DENY") ?? D.namesDenyFile),
  };
}

const expandHome = (p: string, home: string = homedir()) =>
  p.startsWith("~/") ? join(home, p.slice(2)) : p;

/** `BAMBOO_AGENT_ENV`, else `~/.config/bamboo/agent.env`. */
export function agentEnvPath(env: Env = process.env, home: string = homedir()): string {
  return expandHome(env.BAMBOO_AGENT_ENV?.trim() || D.agentEnvFile, home);
}

/** Which Gemini key a run uses (DESIGN §5.5.7, §10 #88). */
export type GeminiKeyChoice = "free" | "paid";

/** The variables each key is read from, in order: the first one set wins. */
export const GEMINI_KEY_VARS = {
  free: ["BAMBOO_GEMINI_API_KEY_FREE", "BAMBOO_GEMINI_API_KEY"],
  paid: ["BAMBOO_GEMINI_API_KEY_PAID"],
} as const satisfies Record<GeminiKeyChoice, readonly string[]>;

/**
 * `BAMBOO_GEMINI_API_KEY` is H4's name for the free key, kept as an alias (expand → contract): a
 * later PR drops it.
 */
export const DEPRECATED_GEMINI_KEY_VAR = "BAMBOO_GEMINI_API_KEY";

export interface FoundKey {
  key: string;
  /** The variable it came from (logged; the value never is). */
  variable: string;
  source: "env" | "file";
}

export interface GeminiKeys {
  free: FoundKey | null;
  paid: FoundKey | null;
  /** agent.env held a key and is readable or writable by the group or others. */
  tooOpen: boolean;
}

/**
 * The Gemini keys (DESIGN §5.5.7, §8.1): `BAMBOO_GEMINI_API_KEY_FREE` (alias
 * `BAMBOO_GEMINI_API_KEY`) and `BAMBOO_GEMINI_API_KEY_PAID`, each from the process environment,
 * else from agent.env. Only these keys are read from the file (it also holds the agent token,
 * which the worker has no use for), and nothing from it reaches `env`. The env wins, as for
 * bamboo-tools, which is safe because the names are `BAMBOO_`-prefixed (§10 #42). Never logged.
 */
export function readGeminiKeys(
  env: Env = process.env,
  path: string = agentEnvPath(env),
): GeminiKeys {
  let file: Env = {};
  let open = false;
  try {
    open = (statSync(path).mode & 0o077) !== 0;
    file = parseEnv(readFileSync(path, "utf8"));
  } catch {
    // No file: keys come from the env or nowhere.
  }
  let fromFile = false;
  const find = (vars: readonly string[]): FoundKey | null => {
    for (const [source, src] of [
      ["env", env],
      ["file", file],
    ] as const) {
      for (const variable of vars) {
        const key = src[variable]?.trim();
        if (key) {
          if (source === "file") fromFile = true;
          return { key, variable, source };
        }
      }
    }
    return null;
  };
  const free = find(GEMINI_KEY_VARS.free);
  const paid = find(GEMINI_KEY_VARS.paid);
  return { free, paid, tooOpen: fromFile && open };
}

/**
 * The selection hook (DESIGN §5.5.7): the worker uses the free key unless it was started with
 * `--gemini-key=paid` (or `--gemini-key paid`), which H7's backfill run passes:
 * `pnpm --filter @bamboo/worker start -- --gemini-key=paid`. A stray `--` (from pnpm) is ignored;
 * anything else is a ConfigError.
 */
export function geminiKeyChoice(argv: readonly string[]): GeminiKeyChoice {
  let choice: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    const m = /^--gemini-key(?:=(.*))?$/u.exec(a);
    if (!m) throw new ConfigError(`unknown argument ${JSON.stringify(a)}`);
    choice = m[1] ?? argv[++i];
  }
  if (choice === undefined) return "free";
  if (choice === "free" || choice === "paid") return choice;
  throw new ConfigError("--gemini-key must be free or paid");
}

export interface GeminiSelection {
  choice: GeminiKeyChoice;
  key: FoundKey;
  limits: GeminiLimits;
}

/**
 * The key and limits this run uses. Null (Ollama only) when the free key is set nowhere; a run that
 * asks for the paid key and can't find it is a ConfigError, never a fallback to the free key.
 */
export function selectGeminiKey(
  keys: GeminiKeys,
  choice: GeminiKeyChoice,
  limits: WorkerConfig["gemini"],
): GeminiSelection | null {
  const key = keys[choice];
  if (!key) {
    if (choice === "paid") {
      throw new ConfigError(
        "--gemini-key=paid, but BAMBOO_GEMINI_API_KEY_PAID is not set (agent.env)",
      );
    }
    return null;
  }
  return { choice, key, limits: limits[choice] };
}

/** Startup log lines about the keys: variables and where they came from, never a value. */
export function geminiKeyLog(
  keys: GeminiKeys,
  sel: GeminiSelection | null,
  path: string,
): string[] {
  const where = (k: FoundKey) =>
    k.source === "file" ? `${k.variable} in ${path}` : `environment variable ${k.variable}`;
  const lines: string[] = [];
  for (const c of ["free", "paid"] as const) {
    const k = keys[c];
    lines.push(`gemini ${c} key: ${k ? where(k) : "not set"}`);
  }
  if (keys.free?.variable === DEPRECATED_GEMINI_KEY_VAR) {
    lines.push(
      `warning: ${DEPRECATED_GEMINI_KEY_VAR} is deprecated; rename it to BAMBOO_GEMINI_API_KEY_FREE`,
    );
  }
  if (keys.tooOpen) lines.push(`warning: ${path} is readable by others; run chmod 600 on it`);
  lines.push(
    sel
      ? `gemini: using the ${sel.choice} key (${sel.key.variable}), ${sel.limits.requestsPerMinute}/min, ${sel.limits.requestsPerDay}/day`
      : "gemini off: BAMBOO_GEMINI_API_KEY_FREE is not set; extracting on ollama only",
  );
  return lines;
}
