// Entry point (launchd: ops/launchd/com.bamboo.worker.plist; by hand: pnpm --filter @bamboo/worker
// start). Exits 78 (EX_CONFIG) when worker.env is missing or incomplete.
import {
  ConfigError,
  EngineClient,
  OllamaClient,
  WORKER_NAME,
  Worker,
  envFilePath,
  gitSha,
  loadEnvFile,
  loadPrompt,
  readConfig,
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

const worker = new Worker({
  engine: new EngineClient(config.apiUrl, config.token),
  ollama: new OllamaClient(config.ollamaUrl, config.model),
  prompt: loadPrompt(),
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
