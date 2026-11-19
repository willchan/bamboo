// Opt-in eval against the real local model (PLAN M4): skipped unless BAMBOO_EVAL_OLLAMA=1, so CI
// never calls a model. The synthetic fixture turns through the fallback path (v4 prompt, reply cut
// for Ollama, no pinyin kept); counts only. `pnpm --filter @bamboo/worker test:ollama`.
//   OLLAMA_URL (http://localhost:11434), OLLAMA_TEXT_MODEL (qwen3.8:27b),
//   EVAL_MIN_VERBATIM (0.8): the lowest verbatim pass rate that passes.
import { sharedConfig } from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { runEval } from "./eval-run";
import { OllamaClient } from "./ollama";

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
      const { counts, verbatimRate } = await runEval(client, model, { keepPinyin: false });
      expect(counts.valid).toBe(counts.turns);
      expect(verbatimRate).toBeGreaterThanOrEqual(minVerbatim);
    },
    30 * 60_000,
  );
});
