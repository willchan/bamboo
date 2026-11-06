// Versioned prompts (CLAUDE.md): `worker/prompts/<name>.v<N>.md`, the highest N wins, and the job
// records `<name>.v<N>` as its `prompt_version`. A file has three parts, each after a marker line:
// `<!-- system -->`, `<!-- user -->` and `<!-- repair -->` (anything before the first is a comment).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedConfig, type ExtractTurnInput } from "@bamboo/shared";

export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export interface Prompt {
  /** e.g. `extract_turn.v1`: sent as `prompt_version`. */
  version: string;
  system: string;
  user: string;
  repair: string;
}

const MARKER = /^<!--\s*(system|user|repair)\s*-->\s*$/gmu;

export function parsePrompt(version: string, text: string): Prompt {
  const parts: Partial<Record<"system" | "user" | "repair", string>> = {};
  const marks = [...text.matchAll(MARKER)];
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    parts[m[1] as "system" | "user" | "repair"] = text.slice(start, end).trim();
  });
  for (const k of ["system", "user", "repair"] as const) {
    if (!parts[k]) throw new Error(`${version}: missing or empty <!-- ${k} --> part`);
  }
  return { version, system: parts.system!, user: parts.user!, repair: parts.repair! };
}

/** The highest-numbered `<name>.v<N>.md` in `dir`. */
export function loadPrompt(name = "extract_turn", dir = PROMPTS_DIR): Prompt {
  const re = new RegExp(`^${name}\\.v(\\d+)\\.md$`, "u");
  let best: { n: number; file: string } | null = null;
  for (const file of readdirSync(dir)) {
    const m = re.exec(file);
    if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), file };
  }
  if (!best) throw new Error(`no ${name}.v<N>.md in ${dir}`);
  return parsePrompt(`${name}.v${best.n}`, readFileSync(join(dir, best.file), "utf8"));
}

/** Fill `{{key}}` placeholders in one pass, so text that contains `{{…}}` stays as it is. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (whole, key: string) => values[key] ?? whole);
}

/** The reply as the model sees it: cut to `maxReplyCharsForModel` (DESIGN §1.2 `num_ctx`). */
export function replyForModel(reply: string, max = sharedConfig.worker.maxReplyCharsForModel) {
  const chars = [...reply];
  return chars.length <= max ? reply : `${chars.slice(0, max).join("")}\n[… reply cut here]`;
}

export function userMessage(prompt: Prompt, input: ExtractTurnInput): string {
  return fill(prompt.user, {
    conversation_title: input.conversation_title?.trim() || "(none)",
    // Empty for a pasted answer (the PWA paste box) and for an image-only prompt (DESIGN §4.5).
    user_text: input.user_text.trim() || "(not available: only Gemini's reply was shared)",
    reply_text: replyForModel(input.reply_text.trim()),
  });
}

export const repairMessage = (prompt: Prompt, errors: string): string =>
  fill(prompt.repair, { errors });
