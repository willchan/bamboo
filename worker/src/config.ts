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
  gemini: { model: string; requestsPerMinute: number; requestsPerDay: number };
  /** The name deny-list's path (`BAMBOO_NAMES_DENY`, else the default). */
  namesDenyPath: string;
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
    requestsPerMinute: limit("GEMINI_RPM", G.requestsPerMinute),
    requestsPerDay: limit("GEMINI_RPD", G.requestsPerDay),
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

/**
 * The free-tier Gemini key (DESIGN §5.5.7, §8.1): `BAMBOO_GEMINI_API_KEY` from the process
 * environment, else from agent.env. Only that one key is read from the file (it also holds the
 * agent token, which the worker has no use for); the env wins, as for bamboo-tools, which is safe
 * because the name is `BAMBOO_`-prefixed (§10 #42). Null when it's set nowhere. Never logged.
 */
export function readGeminiKey(
  env: Env = process.env,
  path: string = agentEnvPath(env),
): { key: string | null; source: "env" | "file" | null; tooOpen: boolean } {
  const fromEnv = env.BAMBOO_GEMINI_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env", tooOpen: false };
  try {
    const mode = statSync(path).mode;
    const key = parseEnv(readFileSync(path, "utf8")).BAMBOO_GEMINI_API_KEY?.trim();
    return key
      ? { key, source: "file", tooOpen: (mode & 0o077) !== 0 }
      : { key: null, source: null, tooOpen: false };
  } catch {
    return { key: null, source: null, tooOpen: false };
  }
}
