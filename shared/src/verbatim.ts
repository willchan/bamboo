// The verbatim check (DESIGN §4.6 step 1): extracted hanzi must be copied from the turn. The
// engine drops items that fail it; the worker's opt-in eval measures the model's pass rate with
// the same function, so it lives here rather than in web/lib/domain (moved from queue.ts in M4).
import type { ITEM_KINDS } from "./contracts/extract";
import { hanziKey, hasHanzi, normalizeText } from "./text";

/** A frame's slot. Gemini writes `…`; `...` is accepted too. */
const SLOT = /…|\.{3}/u;

/** Hanzi for storage: normalized (§4.1), on one line. */
export const cleanHanzi = (s: string): string => normalizeText(s).replace(/\n+/gu, " ");

/** Keys are compared on the whole turn: Will's prompt and Gemini's reply. */
export const turnTextKey = (t: { userText: string; replyText: string }): string =>
  hanziKey(`${t.userText}\n${t.replyText}`);

/**
 * The verbatim check: `hanziKey(hanzi)` must occur in the turn's key. A frame's slot (`…`) matches
 * anything, so `阿姨，您是说…吗？` passes on a turn that says `阿姨，您是说要加水吗？`: each part
 * between slots must occur, in order.
 */
export function occursVerbatim(
  hanzi: string,
  kind: (typeof ITEM_KINDS)[number],
  turnKey: string,
): boolean {
  if (!hasHanzi(hanziKey(hanzi))) return false;
  const parts = (kind === "frame" ? hanzi.split(SLOT) : [hanzi])
    .map((p) => hanziKey(p))
    .filter((p) => p !== "");
  let from = 0;
  for (const part of parts) {
    const at = turnKey.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}
