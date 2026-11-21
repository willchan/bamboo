// The opt-in extraction eval (PLAN M4, H4), shared by `test:ollama` and `test:gemini`: the
// synthetic fixture turns one at a time through a real model, counted with the engine's own
// verbatim check (DESIGN §4.6). Prints counts only; no model output.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanHanzi,
  hanziKey,
  occursVerbatim,
  turnTextKey,
  type ExtractTurnInput,
} from "@bamboo/shared";
import { extractTurn, type ChatModel, type ExtractOptions } from "./extract";
import { PROMPTS_DIR, loadPrompt } from "./prompt";

const FIXTURES = join(PROMPTS_DIR, "..", "tests", "fixtures", "turns.json");
type Turn = ExtractTurnInput & { expect_kind: string };

export const evalTurns = (): Turn[] =>
  (JSON.parse(readFileSync(FIXTURES, "utf8")) as { turns: Turn[] }).turns;

export interface EvalCounts {
  turns: number;
  valid: number;
  repaired: number;
  failed: number;
  kindAgrees: number;
  items: number;
  verbatim: number;
  examples: number;
  examplesVerbatim: number;
  cantoneseKept: number;
  /** Items with one pinyin syllable per hanzi (Gemini only). */
  pinyinAligned: number;
  breakdowns: number;
  totalMs: number;
}

export async function runEval(
  model: ChatModel,
  label: string,
  opts: ExtractOptions,
  turns: Turn[] = evalTurns(),
): Promise<{ counts: EvalCounts; verbatimRate: number }> {
  const prompt = loadPrompt();
  const c: EvalCounts = {
    turns: turns.length,
    valid: 0,
    repaired: 0,
    failed: 0,
    kindAgrees: 0,
    items: 0,
    verbatim: 0,
    examples: 0,
    examplesVerbatim: 0,
    cantoneseKept: 0,
    pinyinAligned: 0,
    breakdowns: 0,
    totalMs: 0,
  };
  for (const t of turns) {
    const x = await extractTurn(model, prompt, t, Date.now, opts);
    c.totalMs += x.latencyMs;
    if (x.repaired) c.repaired += 1;
    if (!x.ok) {
      c.failed += 1;
      console.log(`${t.turn_id}: failed (${x.error.split("\n")[0]})`);
      continue;
    }
    c.valid += 1;
    if (x.result.turn_kind === t.expect_kind) c.kindAgrees += 1;
    const key = turnTextKey({ userText: t.user_text, replyText: t.reply_text });
    let ok = 0;
    for (const item of x.result.items) {
      c.items += 1;
      if (occursVerbatim(cleanHanzi(item.hanzi), item.kind, key)) {
        c.verbatim += 1;
        ok += 1;
      }
      if (hanziKey(item.hanzi).includes("肥仔水")) c.cantoneseKept += 1;
      const hanziCount = Array.from(item.hanzi).filter((ch) => /\p{Script=Han}/u.test(ch)).length;
      if (item.pinyin && item.pinyin.length === hanziCount) c.pinyinAligned += 1;
      if (item.breakdown) c.breakdowns += 1;
      for (const e of item.examples ?? (item.example ? [item.example] : [])) {
        c.examples += 1;
        const ex = cleanHanzi(e.hanzi);
        if (occursVerbatim(ex, "sentence", key) && hanziKey(ex).includes(hanziKey(item.hanzi)))
          c.examplesVerbatim += 1;
      }
    }
    console.log(
      `${t.turn_id}: ${x.result.turn_kind} (expected ${t.expect_kind}), ` +
        `${ok}/${x.result.items.length} verbatim${x.repaired ? ", repaired" : ""}, ` +
        `${(x.latencyMs / 1000).toFixed(1)}s`,
    );
  }
  const verbatimRate = c.items === 0 ? 1 : c.verbatim / c.items;
  console.log(
    `eval ${label} ${prompt.version}: ${c.valid}/${c.turns} valid (${c.repaired} repaired, ` +
      `${c.failed} failed); turn kind agrees ${c.kindAgrees}/${c.valid}; items verbatim ` +
      `${c.verbatim}/${c.items} (${(verbatimRate * 100).toFixed(0)}%); examples copied from the reply ` +
      `${c.examplesVerbatim}/${c.examples}; pinyin aligned ${c.pinyinAligned}/${c.items}; ` +
      `breakdowns ${c.breakdowns}/${c.items}; Cantonese-only kept ${c.cantoneseKept}; ` +
      `model time ${(c.totalMs / 1000).toFixed(0)}s`,
  );
  return { counts: c, verbatimRate };
}
