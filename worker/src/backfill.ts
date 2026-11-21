// H7's backfill (DESIGN §5.5.6, §5.5.7; PLAN H7): queue re-runs of stored turns, read them with a
// worker on the paid key that takes only re-runs and pinyin jobs and stops when idle, then print
// counts only. `backfill-main.ts` wires it up; this file holds the pure parts and the agent client.
//
//   pnpm --filter @bamboo/worker backfill -- --gemini-key=paid --count      # counts, no writes, no Gemini
//   pnpm --filter @bamboo/worker backfill -- --gemini-key=paid --limit 10   # the dry run
//   pnpm --filter @bamboo/worker backfill -- --gemini-key=paid --all        # the full run
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import {
  BackfillReport,
  ReextractResponse,
  sharedConfig,
  type ReextractRequest,
} from "@bamboo/shared";
import { agentEnvPath, ConfigError, geminiKeyChoice, type GeminiKeyChoice } from "./config";
import type { JobReport } from "./worker";

export type BackfillMode =
  | { kind: "count" }
  | { kind: "limit"; limit: number }
  | { kind: "all" }
  /** Only turns the name filter acted on, re-read after a name-filter fix (§10 #104). */
  | { kind: "named" };

export interface BackfillArgs {
  mode: BackfillMode;
  key: GeminiKeyChoice;
}

/**
 * `--count | --limit N | --all | --named`, plus `--gemini-key=paid`, which is required: the backfill never
 * runs on the free key (DESIGN §5.5.7, §10 #88). Exactly one mode.
 */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const rest: string[] = [];
  const modes: BackfillMode[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--count") modes.push({ kind: "count" });
    else if (a === "--all") modes.push({ kind: "all" });
    else if (a === "--named") modes.push({ kind: "named" });
    else if (a === "--limit" || a.startsWith("--limit=")) {
      const raw = a === "--limit" ? argv[++i] : a.slice("--limit=".length);
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > sharedConfig.reextract.maxLimit)
        throw new ConfigError(
          `--limit must be a whole number from 1 to ${sharedConfig.reextract.maxLimit}`,
        );
      modes.push({ kind: "limit", limit });
    } else rest.push(a);
  }
  if (modes.length !== 1)
    throw new ConfigError("give exactly one of --count, --limit N, --all, --named");
  const key = geminiKeyChoice(rest);
  if (key !== "paid") throw new ConfigError("the backfill runs on the paid key: --gemini-key=paid");
  return { mode: modes[0]!, key };
}

export const reextractBody = (mode: BackfillMode): ReextractRequest | null =>
  mode.kind === "count"
    ? null
    : mode.kind === "all"
      ? { all: true, named: false }
      : mode.kind === "named"
        ? { all: false, named: true }
        : { all: true, named: false, limit: mode.limit };

/** `BAMBOO_AGENT_API_TOKEN` from the environment, else agent.env. Never logged. */
export function readAgentToken(
  env: Record<string, string | undefined> = process.env,
  path: string = agentEnvPath(env),
): string {
  const VAR = "BAMBOO_AGENT_API_TOKEN";
  let token = env[VAR]?.trim();
  if (!token) {
    try {
      token = parseEnv(readFileSync(path, "utf8"))[VAR]?.trim();
    } catch {
      // No file: reported below.
    }
  }
  if (!token) throw new ConfigError(`${VAR} is not set (environment or ${path})`);
  return token;
}

/** The agent routes the backfill needs (DESIGN §3.2), with the AGENT token. */
export class AgentClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = sharedConfig.worker.apiTimeoutSeconds * 1000,
  ) {}

  private async call(path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.apiUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  async report(since = 0): Promise<BackfillReport> {
    return BackfillReport.parse(await this.call(`/api/agent/backfill?since=${since}`));
  }

  async reextract(body: ReextractRequest): Promise<ReextractResponse> {
    return ReextractResponse.parse(await this.call("/api/agent/reextract", body));
  }
}

/** What this process did, from the worker's own reports and the Gemini client's counter. */
export interface WorkerSums {
  reruns_done: number;
  reruns_failed: number;
  /** Re-runs read by the Ollama fallback instead of Gemini. */
  reruns_on_ollama: number;
  pinyin_done: number;
  pinyin_failed: number;
  referee_calls: number;
  gemini_requests: number;
  minutes: number;
}

export function workerSums(
  reports: readonly JobReport[],
  geminiModel: string,
  geminiRequests: number,
  elapsedMs: number,
): WorkerSums {
  const ex = reports.filter((r) => r.type === "extract_turn");
  const py = reports.filter((r) => r.type === "pinyin");
  const ok = (r: JobReport) => r.status === "done" && r.outcome === "ok";
  return {
    reruns_done: ex.filter(ok).length,
    reruns_failed: ex.filter((r) => !ok(r)).length,
    reruns_on_ollama: ex.filter((r) => r.status === "done" && r.model !== geminiModel).length,
    pinyin_done: py.filter(ok).length,
    pinyin_failed: py.filter((r) => !ok(r)).length,
    referee_calls: py.filter((r) => r.status === "done" && /referee/u.test(r.promptVersion ?? ""))
      .length,
    gemini_requests: geminiRequests,
    minutes: Math.round((elapsedMs / 60_000) * 10) / 10,
  };
}

export interface Estimate {
  remaining_turns: number;
  requests_per_turn: number | null;
  requests: number | null;
  minutes: number | null;
  /** Days of quota the requests need at the paid key's per-day limit. */
  days: number | null;
}

/**
 * The full run from this run's rates: requests per turn (pinyin follow-ups and retries included)
 * times the turns left; minutes are the slower of this run's pace and the per-minute limit.
 * Null when this run read no turn.
 */
export function estimate(
  sums: WorkerSums,
  remainingTurns: number,
  limits: { requestsPerMinute: number; requestsPerDay: number },
): Estimate {
  const turns = sums.reruns_done;
  if (turns === 0)
    return {
      remaining_turns: remainingTurns,
      requests_per_turn: null,
      requests: null,
      minutes: null,
      days: null,
    };
  const perTurn = sums.gemini_requests / turns;
  const requests = Math.ceil(perTurn * remainingTurns);
  const paced = (sums.minutes / turns) * remainingTurns;
  const minutes = Math.ceil(Math.max(paced, requests / limits.requestsPerMinute));
  return {
    remaining_turns: remainingTurns,
    requests_per_turn: Math.round(perTurn * 100) / 100,
    requests,
    minutes,
    days: Math.max(1, Math.ceil(requests / limits.requestsPerDay)),
  };
}
