// Entry point (launchd: ops/launchd/com.bamboo.worker.plist; by hand: pnpm --filter @bamboo/worker
// start). Exits 78 (EX_CONFIG) when worker.env is missing or incomplete.
import { sharedConfig } from "@bamboo/shared";
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
  gitSha,
  loadDenyList,
  loadEnvFile,
  loadPrompt,
  readConfig,
  readGeminiKey,
  workerVersion,
} from "./index";
import { consoleLog as log } from "./log";

const envFile = loadEnvFile(envFilePath());
if (!envFile.loaded) log(`no env file at ${envFile.path}; using the process environment`);
else log(`env file ${envFile.path}: ${envFile.keys.length} variable(s)`);
if (envFile.tooOpen) log(`warning: ${envFile.path} is readable by others; run chmod 600 on it`);

let config;
try {
  config = readConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  log(`config error: ${e.message} (see ops/worker.env.example)`);
  // Under launchd (no TTY), wait before exiting so KeepAlive doesn't restart it every few seconds.
  if (!process.stdout.isTTY) await new Promise((r) => setTimeout(r, 5 * 60_000));
  process.exit(78);
}

const version = workerVersion();
const sha = gitSha();
log(`${WORKER_NAME} ${version} (${sha ?? "no git sha"}) → ${config.apiUrl}`);

// The free-tier key (DESIGN §5.5.7): from agent.env, never logged.
const key = readGeminiKey(process.env, agentEnvPath());
if (key.source === "file") log(`gemini key: BAMBOO_GEMINI_API_KEY in ${agentEnvPath()}`);
else if (key.source === "env") log("gemini key: environment variable BAMBOO_GEMINI_API_KEY");
if (key.tooOpen) log(`warning: ${agentEnvPath()} is readable by others; run chmod 600 on it`);
const gemini = key.key
  ? new GeminiClient(
      config.gemini.model,
      key.key,
      new RateLimiter({
        requestsPerMinute: config.gemini.requestsPerMinute,
        requestsPerDay: config.gemini.requestsPerDay,
        timeZone: sharedConfig.worker.gemini.quotaTimeZone,
      }),
      { log },
    )
  : null;
if (gemini) {
  log(
    `gemini: ${gemini.model}, ${config.gemini.requestsPerMinute}/min, ${config.gemini.requestsPerDay}/day`,
  );
}

const worker = new Worker({
  engine: new EngineClient(config.apiUrl, config.token),
  ollama: new OllamaClient(config.ollamaUrl, config.model),
  gemini,
  prompt: loadPrompt(),
  pinyinPrompts: { reading: loadPrompt("pinyin_reading"), referee: loadPrompt("pinyin_referee") },
  deny: loadDenyList(config.namesDenyPath),
  model: config.model,
  pollIntervalMs: config.pollIntervalMs,
  version,
  sha,
  log,
});

// launchd sends SIGTERM on unload/kickstart -k and waits ExitTimeOut before SIGKILL.
let signals = 0;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    signals += 1;
    if (signals > 1) {
      log(`${sig} again: exiting now`);
      process.exit(128 + (sig === "SIGTERM" ? 15 : 2));
    }
    worker.stop();
  });
}

await worker.run();
process.exit(0);
