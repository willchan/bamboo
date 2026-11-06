// Turn identity (DESIGN §4.5). The CLI computes keys to ask the engine what it already has; the
// engine recomputes them and is the authority. Both import this one function.
import { createHash } from "node:crypto";
import { hanziKey } from "./text";

export const IMPORT_KINDS = ["link", "pdf", "text"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * `turn_key` for one turn:
 * - link and PDF imports key on Will's own words only: `sha256(hanziKey(user_text))`, so re-shares
 *   and re-exports (which can re-flow Gemini's reply) map to the same key;
 * - text imports (a pasted answer, usually with no prompt) key on prompt and reply:
 *   `sha256(hanziKey(user_text) + '\n' + hanziKey(reply_text))`;
 * - **empty prompts** (an image-only prompt in a link or PDF: `hanziKey(user_text)` is empty) are
 *   keyed like a text import, on the reply. Otherwise every image-only turn would share one key.
 */
export function turnKey(
  turn: { user_text: string | null | undefined; reply_text: string },
  kind: ImportKind,
): string {
  const user = hanziKey(turn.user_text ?? "");
  if (kind !== "text" && user !== "") return sha256(user);
  return sha256(`${user}\n${hanziKey(turn.reply_text)}`);
}
