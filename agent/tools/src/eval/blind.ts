// Blinding (DESIGN §5.4): per question, Gemini's answer and each local answer in a seeded shuffle,
// labeled A, B, C… The page data carries only labels and text; which label is which source goes
// in the separate key. Every answer gets the same plain-text cleanup, so Markdown from a local
// model doesn't give it away next to Gemini's plain share-page text.
import { seededShuffle } from "@bamboo/shared";
import { GEMINI, type AnswersFile, type KeyFile } from "./types";

/** What judge.html embeds: nothing that names a source or carries a timing. */
export interface PageData {
  run_id: string;
  questions: { id: string; question: string; answers: { label: string; text: string }[] }[];
}

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Markdown and thinking traces stripped to plain text with line breaks. */
export function plainText(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gu, "")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:[-*_]\s*){3,}$/u.test(line)) // horizontal rules
    .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(line)) // table rule
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/u, "") // headings
        .replace(/^(\s*)[*+-]\s+/u, "$1• ") // bullets
        .replace(/^\s*\|(.*)\|\s*$/u, (_, cells: string) =>
          cells
            .split("|")
            .map((c) => c.trim())
            .join(" · "),
        )
        .replace(/(\*\*|__)(.+?)\1/gu, "$2") // bold
        .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/gu, "$1$2") // italics
        .replace(/`{1,3}([^`]*)`{1,3}/gu, "$1")
        .replace(/^\s*`{3}.*$/u, "")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function buildBlind(answers: AnswersFile): { page: PageData; key: KeyFile } {
  const page: PageData = { run_id: answers.run_id, questions: [] };
  const key: KeyFile = { version: 1, run_id: answers.run_id, questions: [] };
  for (const q of answers.questions) {
    const shown: { source: string; text: string }[] = [{ source: GEMINI, text: q.gemini }];
    const missing: { source: string; error: string }[] = [];
    for (const m of answers.models) {
      const a = q.answers[m];
      const text = a?.text ? plainText(a.text) : "";
      if (!a || a.error || !text) missing.push({ source: m, error: a?.error ?? "not run" });
      else shown.push({ source: m, text });
    }
    const order = seededShuffle(shown, `${answers.seed}:blind:${answers.run_id}:${q.id}`);
    page.questions.push({
      id: q.id,
      question: q.question,
      answers: order.map((s, i) => ({
        label: LABELS[i]!,
        text: s.source === GEMINI ? plainText(s.text) : s.text,
      })),
    });
    key.questions.push({
      id: q.id,
      turn_id: q.turn_id,
      labels: Object.fromEntries(
        order.map((s, i) => {
          const a = s.source === GEMINI ? null : q.answers[s.source]!;
          return [
            LABELS[i]!,
            {
              source: s.source,
              latency_ms: a?.latency_ms ?? null,
              tokens_per_sec: a?.tokens_per_sec ?? null,
            },
          ];
        }),
      ),
      missing,
    });
  }
  return { page, key };
}
