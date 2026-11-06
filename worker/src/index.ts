// bamboo-worker (DESIGN §5.3, §8.3): claims extract_turn jobs from the State Engine and runs them
// on the Mac's local Ollama. `main.ts` wires these together under launchd.
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

export { ConfigError, envFilePath, loadEnvFile, readConfig } from "./config";
export { EngineClient } from "./api";
export { OllamaClient, extractTurn } from "./ollama";
export { loadPrompt } from "./prompt";
export { Worker } from "./worker";
