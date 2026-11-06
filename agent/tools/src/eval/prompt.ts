// The tutor system prompt's one copy is in docs/PROMPTS.md, between
// `<!-- tutor-eval-system-prompt:start -->` and `…:end -->` (DESIGN §5.4).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedConfig } from "@bamboo/shared";

/** The checkout's root (agent/tools/src/eval → four levels up). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const PROMPTS_DOC = join(REPO_ROOT, "docs", "PROMPTS.md");

export interface TutorPrompt {
  system: string;
  /** First 12 hex digits of the text's SHA-256, recorded per run. */
  sha: string;
}

export function parseTutorPrompt(
  doc: string,
  marker: string = sharedConfig.tutorEval.promptMarker,
): TutorPrompt {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  if (i < 0 || j < i) throw new Error(`docs/PROMPTS.md: no ${start} … ${end} block`);
  const system = doc.slice(i + start.length, j).trim();
  if (!system) throw new Error(`docs/PROMPTS.md: the ${marker} block is empty`);
  return { system, sha: createHash("sha256").update(system, "utf8").digest("hex").slice(0, 12) };
}

export const loadTutorPrompt = (path = PROMPTS_DOC): TutorPrompt =>
  parseTutorPrompt(readFileSync(path, "utf8"));
