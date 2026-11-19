// H7's backfill run (PLAN H7, DESIGN §5.5.6): `pnpm --filter @bamboo/worker backfill --
// --gemini-key=paid --count | --limit N | --all`, as openclaw-agent, with the launchd worker
// stopped. Prints counts only (CLAUDE.md › Privacy): never turn text, phrases or names.
// Exits 78 on a config error, 1 if the engine can't be reached, 2 if Gemini refused a request
// (a 4xx other than 429: the run stops instead of falling back to Ollama).
import { sharedConfig } from "@bamboo/shared";
import {
  AgentClient,
  estimate,
  parseBackfillArgs,
  readAgentToken,
  reextractBody,
  workerSums,
} from "./backfill";
import {
  ConfigError,
  EngineClient,
  GeminiClient,
  OllamaClient,
  RateLimiter,
  WORKER_NAME,
  Worker,
  agentEnvPath,
  envFilePath,
  geminiKeyLog,
  gitSha,
  loadDenyList,
  loadEnvFile,
  loadPrompt,
  readConfig,
  readGeminiKeys,
  selectGeminiKey,
  workerVersion,
} from "./index";
import { consoleLog as log } from "./log";

/** Engine clock vs. this Mac's: re-run events are summed from a little before the start. */
const CLOCK_SLACK_MS = 10_000;

const envFile = loadEnvFile(envFilePath());
if (!envFile.loaded) log(`no env file at ${envFile.path}; using the process environment`);

const keyPath = agentEnvPath();
let args, config, keys, selection, agentToken;
try {
  args = parseBackfillArgs(process.argv.slice(2));
  config = readConfig();
  keys = readGeminiKeys(process.env, keyPath);
  selection = selectGeminiKey(keys, args.key, config.gemini)!;
  agentToken = readAgentToken(process.env, keyPath);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  log(`config error: ${e.message}`);
  process.exit(78);
}

const print = (label: string, value: unknown) =>
  console.log(`${label} ${JSON.stringify(value, null, 2)}`);

const agent = new AgentClient(config.apiUrl, agentToken);
let before;
try {
  before = await agent.report(0);
} catch (e) {
  log(`engine: ${(e as Error).message}`);
  process.exit(1);
}
log(`${WORKER_NAME} backfill (${args.mode.kind}) ${workerVersion()} (${gitSha() ?? "no git sha"})`);
print("BEFORE", {
  newest_prompt: before.newest_prompt,
  turns: before.turns,
  phrases_reported_open: before.phrases_reported_open,
  review: before.review,
});

const body = reextractBody(args.mode);
if (!body) process.exit(0); // --count: no writes, no Gemini

for (const line of geminiKeyLog(keys, selection, keyPath)) log(line);
const gemini = new GeminiClient(
  config.gemini.model,
  selection.key.key,
  new RateLimiter({ ...selection.limits, timeZone: sharedConfig.worker.gemini.quotaTimeZone }),
  { log },
);
log(`gemini model: ${gemini.model}`);

const started = Date.now();
const queued = await agent.reextract(body);
log(`re-runs queued: ${queued.queued} (open: ${queued.open})`);

const worker = new Worker({
  engine: new EngineClient(config.apiUrl, config.token),
  ollama: new OllamaClient(config.ollamaUrl, config.model),
  gemini,
  prompt: loadPrompt(),
  pinyinPrompts: { reading: loadPrompt("pinyin_reading"), referee: loadPrompt("pinyin_referee") },
  deny: loadDenyList(config.namesDenyPath),
  model: config.model,
  pollIntervalMs: config.pollIntervalMs,
  version: workerVersion(),
  sha: gitSha(),
  log,
  reextractOnly: true,
  untilIdle: true,
  geminiOnly: true,
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => worker.stop());
await worker.run();

const sums = workerSums(worker.reports, gemini.model, gemini.requests, Date.now() - started);
const after = await agent.report(Math.max(0, started - CLOCK_SLACK_MS));
print("RESULT", {
  mode: args.mode,
  stopped_on_gemini_error: worker.refused,
  queued: queued.queued,
  worker: sums,
  engine: after.run,
  turns: after.turns,
  phrases_reported_open: after.phrases_reported_open,
  review_before: before.review,
  review_after: after.review,
  estimate_full_run: estimate(sums, after.turns.remaining, selection.limits),
});
// A refused request is a bug to fix before the next run, not an outage (exit 2).
process.exit(worker.refused ? 2 : 0);
