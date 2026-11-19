// bamboo-worker (DESIGN §5.3, §5.5, §8.3): claims extract_turn and pinyin jobs from the State
// Engine and runs them on Gemini (free tier), with the Mac's local Ollama as the extraction
// fallback. `main.ts` wires these together under launchd.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_NAME = "bamboo-worker";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `version` from worker/package.json. */
export function workerVersion(): string {
  const pkg = JSON.parse(readFileSync(join(WORKER_DIR, "package.json"), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

/** The checkout's commit (short), or null outside a git checkout. */
export function gitSha(cwd = WORKER_DIR): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export {
  ConfigError,
  agentEnvPath,
  envFilePath,
  loadEnvFile,
  geminiKeyChoice,
  geminiKeyLog,
  readConfig,
  readGeminiKeys,
  selectGeminiKey,
} from "./config";
export { EngineClient } from "./api";
export { extractTurn } from "./extract";
export { GeminiClient } from "./gemini";
export { loadDenyList } from "./names";
export { OllamaClient } from "./ollama";
export { loadPrompt } from "./prompt";
export { RateLimiter } from "./rate-limit";
export { Worker } from "./worker";
