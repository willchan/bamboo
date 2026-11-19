// Turn identity (DESIGN §4.5). The CLI computes keys to ask the engine what it already has; the
// engine recomputes them and is the authority. Both import this one function.
import { createHash } from "node:crypto";
import { hanziKey } from "./text";

/** `tutor` (H5): one question Will asked the #bamboo agent and its answer (DESIGN §5.5.1). */
export const IMPORT_KINDS = ["link", "pdf", "text", "tutor"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * `turn_key` for one turn:
 * - link and PDF imports key on Will's own words only: `sha256(hanziKey(user_text))`, so re-shares
 *   and re-exports (which can re-flow Gemini's reply) map to the same key;
 * - text imports (a pasted answer, usually with no prompt) and tutor turns key on prompt and
 *   reply: `sha256(hanziKey(user_text) + '\n' + hanziKey(reply_text))`. A tutor question asked
 *   again gets a new answer, so it's a new turn (it counts as asking again);
 * - **empty prompts** (an image-only prompt in a link or PDF: `hanziKey(user_text)` is empty) are
 *   keyed like a text import, on the reply. Otherwise every image-only turn would share one key.
 */
export function turnKey(
  turn: { user_text: string | null | undefined; reply_text: string },
  kind: ImportKind,
): string {
  const user = hanziKey(turn.user_text ?? "");
  if (kind !== "text" && kind !== "tutor" && user !== "") return sha256(user);
  return sha256(`${user}\n${hanziKey(turn.reply_text)}`);
}
