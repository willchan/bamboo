// The worker's settings (DESIGN §8.1): read from the environment, which `loadEnvFile` fills from
// `~/.config/bamboo/worker.env` (ops/worker.env.example documents every variable).
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
 * Copy the file's variables into `env` without overriding ones already set (like Node's
 * `--env-file`: the process environment wins). A missing file is not an error here; `readConfig`
 * reports what's missing.
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
    if (env[k] === undefined || env[k] === "") {
      env[k] = v;
      keys.push(k);
    }
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

  if (problems.length > 0) throw new ConfigError(problems.join("; "));
  return {
    apiUrl: apiUrl!.replace(/\/+$/u, ""),
    token: token!,
    ollamaUrl: ollamaUrl.replace(/\/+$/u, ""),
    model: get("OLLAMA_TEXT_MODEL") ?? D.model,
    pollIntervalMs: Math.round(poll * 1000),
  };
}
