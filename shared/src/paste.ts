// Pasted answer or question? (H5, DESIGN §5.1 *Text*). Text in #bamboo that isn't a link or a
// PDF is either a Gemini answer Will pasted (imported as text, as before H5) or a question for
// the tutor. `bamboo-tools ask` decides with this rule, so the model never has to.
import { sharedConfig } from "./config";
import { hasHanzi } from "./text";

export type TextRoute = { route: "paste"; text: string } | { route: "question"; text: string };

const PASTE = /^\s*(?:📋|paste[ds]?\s*:)\s*/iu;
const ASK = /^\s*ask\s*:\s*/iu;

/**
 * 1. `paste:` (or `pasted:`, `📋`) at the start → a pasted answer; `ask:` → a
 *    question. The marker is removed.
 * 2. Otherwise a pasted answer only if it has Chinese, is at least `paste.minChars` long and has
 *    at least `paste.minLines` non-blank lines: a Gemini answer is long and structured, a
 *    question is a line or two, even one that quotes a Chinese message to decode.
 * 3. Everything else is a question.
 */
export function routeText(
  raw: string,
  cfg: { minChars: number; minLines: number } = sharedConfig.tools.paste,
): TextRoute {
  const paste = PASTE.exec(raw);
  if (paste) return { route: "paste", text: raw.slice(paste[0].length).trim() };
  const ask = ASK.exec(raw);
  if (ask) return { route: "question", text: raw.slice(ask[0].length).trim() };
  const text = raw.trim();
  const lines = text.split(/\r?\n/u).filter((l) => l.trim() !== "").length;
  const pasted = hasHanzi(text) && [...text].length >= cfg.minChars && lines >= cfg.minLines;
  return { route: pasted ? "paste" : "question", text };
}
