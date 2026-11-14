// Opt-in eval against the real local model (PLAN M4): skipped unless BAMBOO_EVAL_OLLAMA=1, so CI
// never calls a model. Runs the synthetic fixture turns one at a time (concurrency 1, as the
// worker does) and reports counts: contract validity, repairs, and the verbatim pass rate the
// engine's check (DESIGN §4.6) would give. `pnpm --filter @bamboo/worker test:ollama`.
//   OLLAMA_URL (http://localhost:11434), OLLAMA_TEXT_MODEL (qwen3.8:27b),
//   EVAL_MIN_VERBATIM (0.8): the lowest verbatim pass rate that passes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanHanzi,
  hanziKey,
  occursVerbatim,
  sharedConfig,
  turnTextKey,
  type ExtractTurnInput,
} from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { OllamaClient, extractTurn } from "./ollama";
import { PROMPTS_DIR, loadPrompt } from "./prompt";

const FIXTURES = join(PROMPTS_DIR, "..", "tests", "fixtures", "turns.json");
type Turn = ExtractTurnInput & { expect_kind: string };
const { turns } = JSON.parse(readFileSync(FIXTURES, "utf8")) as { turns: Turn[] };

const enabled = process.env.BAMBOO_EVAL_OLLAMA === "1";
const url = process.env.OLLAMA_URL ?? sharedConfig.worker.defaults.ollamaUrl;
const model = process.env.OLLAMA_TEXT_MODEL ?? sharedConfig.worker.defaults.model;
const minVerbatim = Number(process.env.EVAL_MIN_VERBATIM ?? 0.8);

describe.skipIf(!enabled)(`extract_turn eval on ${model}`, () => {
  it(
    "fixture turns give valid results whose hanzi is copied from the turn",
    async () => {
      const client = new OllamaClient(url, model);
      expect(await client.hasModel(), `${model} is not pulled at ${url}`).toBe(true);
      const prompt = loadPrompt();
      const c = {
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
        totalMs: 0,
      };
      for (const t of turns) {
        const x = await extractTurn(client, prompt, t);
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
          if (item.example) {
            c.examples += 1;
            const ex = cleanHanzi(item.example.hanzi);
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
      const rate = c.items === 0 ? 1 : c.verbatim / c.items;
      console.log(
        `eval ${model} ${prompt.version}: ${c.valid}/${c.turns} valid (${c.repaired} repaired, ` +
          `${c.failed} failed); turn kind agrees ${c.kindAgrees}/${c.valid}; items verbatim ` +
          `${c.verbatim}/${c.items} (${(rate * 100).toFixed(0)}%); examples verbatim ` +
          `${c.examplesVerbatim}/${c.examples}; Cantonese-only kept ${c.cantoneseKept}; ` +
          `model time ${(c.totalMs / 1000).toFixed(0)}s`,
      );
      expect(c.valid).toBe(c.turns);
      expect(rate).toBeGreaterThanOrEqual(minVerbatim);
    },
    30 * 60_000,
  );
});
