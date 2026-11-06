// bamboo-eval (DESIGN §5.4): the local tutor evaluation. Not a bamboo-tools command: OpenClaw's
// skill can't reach it, and it is the one Mac-side tool besides the worker that calls a model
// (local Ollama only). Will's questions, Gemini's answers and every model output go only to the
// run's output directory, outside the checkout (it refuses one inside).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EvalTurnsResponse, sharedConfig } from "@bamboo/shared";
import { Api, type Fetch } from "../api";
import { loadSettings } from "../env";
import { buildBlind } from "./blind";
import { renderJudgeHtml } from "./html";
import { TutorOllama } from "./ollama";
import { loadTutorPrompt, REPO_ROOT, type TutorPrompt } from "./prompt";
import { newAnswers, replay } from "./replay";
import { formatScores, score } from "./score";
import { serveJudge, type Served } from "./serve";
import { AnswersFile, KeyFile, ResultsFile } from "./types";

const E = sharedConfig.tutorEval;

export const EVAL_USAGE = `usage: bamboo-eval <command> [options]   (make tutor-eval ARGS="<command> …")

  run [--out <dir>] [--limit ${E.defaultLimit}] [--seed ${E.defaultSeed}] [--models ${E.defaultModels.join(",")}]
      [--ollama-url <url>] [--think] [--fixture <turns.json>]
      Sample past questions from the engine (or --fixture: a synthetic EvalTurnsResponse, no
      engine call), replay them through each model one at a time, and write answers.json,
      judge.html and key.json to --out (default ${E.outRoot}/<run id>/). With an existing --out,
      resumes: only missing or failed answers are asked again.
  build --out <dir>
      Rewrite judge.html and key.json from answers.json.
  serve --out <dir> [--host 127.0.0.1] [--port 8787]
      Serve judge.html at a secret URL; "Save to Mac" writes <dir>/results.json. Ctrl-C to stop.
  score --out <dir> | --results <results.json> --key <key.json>
      Per-model table: mean accuracy, mean naturalness, % preferred, median latency.

Engine settings: ~/.config/bamboo/agent.env (BAMBOO_API_URL, BAMBOO_AGENT_API_TOKEN).
Ollama: --ollama-url, else OLLAMA_URL, else ${sharedConfig.worker.defaults.ollamaUrl}.`;

export interface EvalResult {
  code: number;
  out: string;
  err?: string;
  /** Set by `serve`: the caller keeps the process alive until it is closed. */
  served?: Served;
}

export interface EvalDeps {
  env: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** Progress lines (stderr). Never question or answer text. */
  log: (line: string) => void;
  now?: () => Date;
  prompt?: () => TutorPrompt;
}

const OPTIONS = {
  out: { type: "string" },
  limit: { type: "string" },
  seed: { type: "string" },
  models: { type: "string" },
  "ollama-url": { type: "string" },
  think: { type: "boolean" },
  fixture: { type: "string" },
  results: { type: "string" },
  key: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
} as const;

class UsageError extends Error {}

/** `2026-11-06T095604` (UTC), the run id and default directory name. */
export const runIdFor = (d: Date) => d.toISOString().replace(/[:]/gu, "").slice(0, 17);

const expandHome = (p: string, env: NodeJS.ProcessEnv) =>
  p === "~" || p.startsWith("~/") ? join(env.HOME ?? "", p.slice(1)) : p;

/** True if `p` is the checkout or inside it. */
export function insideRepo(p: string, root = REPO_ROOT): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function outDir(v: { out?: string }, env: NodeJS.ProcessEnv, runId: string | null): string {
  const dir = v.out
    ? resolve(expandHome(v.out, env))
    : runId
      ? join(expandHome(E.outRoot, env), runId)
      : null;
  if (!dir) throw new UsageError("--out <dir> is required");
  if (insideRepo(dir))
    throw new UsageError(`${dir} is inside the checkout; real questions never go in the repo`);
  return dir;
}

/** Private files: the directory 700, files 600. */
function writePrivate(dir: string, name: string, text: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function build(dir: string, answers: AnswersFile) {
  const { page, key } = buildBlind(answers);
  return {
    html: writePrivate(dir, "judge.html", renderJudgeHtml(page)),
    key: writePrivate(dir, "key.json", `${JSON.stringify(key, null, 2)}\n`),
  };
}

async function cmdRun(v: Record<string, string | boolean | undefined>, deps: EvalDeps) {
  const now = deps.now?.() ?? new Date();
  const runId = runIdFor(now);
  const dir = outDir(v as { out?: string }, deps.env, runId);
  const answersPath = join(dir, "answers.json");
  const prompt = (deps.prompt ?? loadTutorPrompt)();
  const models = ((v.models as string | undefined) ?? E.defaultModels.join(","))
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (!models.length) throw new UsageError("--models is empty");
  const ollamaUrl = (
    (v["ollama-url"] as string | undefined) ??
    deps.env.OLLAMA_URL ??
    sharedConfig.worker.defaults.ollamaUrl
  ).replace(/\/+$/u, "");
  const think = v.think === true;

  let answers: AnswersFile;
  if (existsSync(answersPath)) {
    answers = AnswersFile.parse(readJson(answersPath));
    if (answers.prompt_sha !== prompt.sha)
      deps.log(`note: the prompt changed since this run started (${answers.prompt_sha})`);
    deps.log(`resuming ${answers.run_id}: ${answers.questions.length} questions`);
  } else {
    const limit = Number(v.limit ?? E.defaultLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > E.maxLimit)
      throw new UsageError(`--limit must be 1–${E.maxLimit}`);
    const seed = (v.seed as string | undefined) ?? E.defaultSeed;
    let sample: EvalTurnsResponse;
    if (v.fixture) {
      sample = EvalTurnsResponse.parse(readJson(v.fixture as string));
      sample = { ...sample, turns: sample.turns.slice(0, limit) };
    } else {
      const settings = loadSettings(deps.env);
      if (!settings.apiUrl || !settings.token)
        return {
          code: 1,
          out: "",
          err: "bamboo-eval: BAMBOO_API_URL / BAMBOO_AGENT_API_TOKEN not set (~/.config/bamboo/agent.env)",
        };
      const api = new Api({
        baseUrl: settings.apiUrl,
        token: settings.token,
        tokenSource: settings.tokenSource,
        fetch: deps.fetch,
      });
      sample = await api.evalTurns(limit, seed);
    }
    if (!sample.turns.length)
      return { code: 1, out: "", err: "bamboo-eval: no questions to replay" };
    writePrivate(dir, "turns.json", `${JSON.stringify(sample, null, 2)}\n`);
    answers = newAnswers(sample, {
      run_id: runId,
      seed,
      created_at: now.toISOString(),
      prompt_sha: prompt.sha,
      ollama_url: ollamaUrl,
      think,
    });
    const imports = new Set(sample.turns.map((t) => t.import_id)).size;
    deps.log(
      `sampled ${sample.turns.length} questions from ${imports} imports (pool: ${sample.pool.turns} turns, ${sample.pool.imports} imports)`,
    );
  }
  const save = (a: AnswersFile) =>
    writePrivate(dir, "answers.json", `${JSON.stringify(a, null, 2)}\n`);
  save(answers);

  const ollama = new TutorOllama(ollamaUrl, deps.fetch, { think });
  await replay(answers, models, { ollama, prompt, save, log: deps.log });
  const files = build(dir, answers);
  const failed = answers.questions.reduce(
    (n, q) => n + Object.values(q.answers).filter((a) => a.error).length,
    0,
  );
  return {
    code: 0,
    out: [
      `run ${answers.run_id}: ${answers.questions.length} questions × ${answers.models.length} models${failed ? ` (${failed} failed answers; run again with --out to retry them)` : ""}`,
      `judge page: ${files.html}`,
      `key:        ${files.key}   (don't open it before judging)`,
      `next: make tutor-eval ARGS="serve --out ${dir} --host <tailscale ip>", then ARGS="score --out ${dir}"`,
    ].join("\n"),
  };
}

function cmdBuild(v: Record<string, string | boolean | undefined>, deps: EvalDeps) {
  const dir = outDir(v as { out?: string }, deps.env, null);
  const files = build(dir, AnswersFile.parse(readJson(join(dir, "answers.json"))));
  return { code: 0, out: `judge page: ${files.html}\nkey:        ${files.key}` };
}

async function cmdServe(v: Record<string, string | boolean | undefined>, deps: EvalDeps) {
  const dir = outDir(v as { out?: string }, deps.env, null);
  const key = KeyFile.parse(readJson(join(dir, "key.json")));
  const served = await serveJudge({
    dir,
    host: (v.host as string | undefined) ?? "127.0.0.1",
    port: Number(v.port ?? 8787),
    runId: key.run_id,
    writeResults: (json) => {
      writePrivate(dir, "results.json", `${json}\n`);
      deps.log(`saved ${join(dir, "results.json")}`);
    },
  });
  return {
    code: 0,
    out: `open on the iPhone: ${served.url}\n(Ctrl-C to stop; "Save to Mac" writes ${join(dir, "results.json")})`,
    served,
  };
}

function cmdScore(v: Record<string, string | boolean | undefined>, deps: EvalDeps) {
  let resultsPath = v.results as string | undefined;
  let keyPath = v.key as string | undefined;
  if (v.out) {
    const dir = outDir(v as { out?: string }, deps.env, null);
    resultsPath ??= join(dir, "results.json");
    keyPath ??= join(dir, "key.json");
  }
  if (!resultsPath || !keyPath) throw new UsageError("give --out <dir>, or --results and --key");
  const rows = score(ResultsFile.parse(readJson(resultsPath)), KeyFile.parse(readJson(keyPath)));
  return { code: 0, out: formatScores(rows) };
}

export async function runEval(argv: readonly string[], deps: EvalDeps): Promise<EvalResult> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help")
    return { code: 0, out: EVAL_USAGE };
  try {
    let v: Record<string, string | boolean | undefined>;
    try {
      v = parseArgs({
        args: [...args],
        options: OPTIONS,
        strict: true,
        allowPositionals: false,
      }).values;
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    switch (command) {
      case "run":
        return await cmdRun(v, deps);
      case "build":
        return cmdBuild(v, deps);
      case "serve":
        return await cmdServe(v, deps);
      case "score":
        return cmdScore(v, deps);
      default:
        return {
          code: 2,
          out: "",
          err: `bamboo-eval: unknown command '${command}'\n\n${EVAL_USAGE}`,
        };
    }
  } catch (e) {
    if (e instanceof UsageError)
      return { code: 2, out: "", err: `bamboo-eval ${command}: ${e.message}\n\n${EVAL_USAGE}` };
    return { code: 1, out: "", err: `bamboo-eval ${command}: ${(e as Error).message}` };
  }
}
