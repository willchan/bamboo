// `pnpm --filter @bamboo/worker gemini-probe -- [--gemini-key=paid]` (H7), on the Mac as
// openclaw-agent: five synthetic requests to Gemini (gemini-probe.ts), one line each. Exits 0 when
// all pass, 1 when any fails, 78 on a config error. Never prints a key, a prompt or a reply.
import { sharedConfig } from "@bamboo/shared";
import { runProbe } from "./gemini-probe";
import {
  ConfigError,
  GeminiClient,
  RateLimiter,
  agentEnvPath,
  envFilePath,
  geminiKeyChoice,
  geminiKeyLog,
  loadEnvFile,
  loadPrompt,
  readConfig,
  readGeminiKeys,
  selectGeminiKey,
} from "./index";
import { consoleLog as log } from "./log";

loadEnvFile(envFilePath());
const keyPath = agentEnvPath();
let config, keys, selection;
try {
  config = readConfig();
  keys = readGeminiKeys(process.env, keyPath);
  selection = selectGeminiKey(keys, geminiKeyChoice(process.argv.slice(2)), config.gemini);
  if (!selection) throw new ConfigError("no Gemini key (BAMBOO_GEMINI_API_KEY_FREE)");
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  log(`config error: ${e.message}`);
  process.exit(78);
}
for (const line of geminiKeyLog(keys, selection, keyPath)) log(line);
const gemini = new GeminiClient(
  config.gemini.model,
  selection.key.key,
  new RateLimiter({ ...selection.limits, timeZone: sharedConfig.worker.gemini.quotaTimeZone }),
  { log },
);
log(`probe: model ${gemini.model}, synthetic input only`);
const results = await runProbe(gemini, {
  extract: loadPrompt(),
  reading: loadPrompt("pinyin_reading"),
  referee: loadPrompt("pinyin_referee"),
});
for (const r of results) log(`probe ${r.name}: ${r.ok ? "PASS" : "FAIL"} ${r.outcome}`);
log(`probe: ${gemini.requests} request(s)`);
process.exit(results.every((r) => r.ok) && results.length === 5 ? 0 : 1);
