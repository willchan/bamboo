// Opt-in eval against real Gemini (PLAN H4): skipped unless BAMBOO_EVAL_GEMINI=1, so CI never
// calls a model. Run on the Mac as openclaw-agent (the key is in its agent.env; never printed):
//   BAMBOO_EVAL_GEMINI=1 pnpm --filter @bamboo/worker test:gemini
//   BAMBOO_EVAL_GEMINI=1 BAMBOO_EVAL_GEMINI_KEY=paid pnpm --filter @bamboo/worker test:gemini
// Only the synthetic fixture turns (worker/tests/fixtures/turns.json) and the prompt are sent;
// one turn per request at the configured rate (it waits out the per-minute limit, and stops if
// the daily quota is used up). Counts only. GEMINI_MODEL, GEMINI_RPM, GEMINI_RPD override the
// config; EVAL_MIN_VERBATIM (0.8) is the lowest verbatim pass rate that passes.
import { sharedConfig } from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { readGeminiKeys } from "./config";
import { runEval } from "./eval-run";
import { GeminiClient } from "./gemini";
import { RateLimiter } from "./rate-limit";

const G = sharedConfig.worker.gemini;
const enabled = process.env.BAMBOO_EVAL_GEMINI === "1";
const model = process.env.GEMINI_MODEL ?? G.model;
const minVerbatim = Number(process.env.EVAL_MIN_VERBATIM ?? 0.8);

describe.skipIf(!enabled)(`extract_turn eval on ${model}`, () => {
  it(
    "fixture turns give contract-valid results whose hanzi is copied from the turn",
    async () => {
      // The free key (everyday work, DESIGN §5.5.7), or the paid one with
      // BAMBOO_EVAL_GEMINI_KEY=paid (H7: check the backfill's key on synthetic turns).
      const paid = process.env.BAMBOO_EVAL_GEMINI_KEY === "paid";
      const key = (paid ? readGeminiKeys().paid : readGeminiKeys().free)?.key;
      expect(
        key,
        `${paid ? "BAMBOO_GEMINI_API_KEY_PAID" : "BAMBOO_GEMINI_API_KEY_FREE"} is not set (agent.env)`,
      ).toBeTruthy();
      const limiter = new RateLimiter({
        requestsPerMinute: Number(
          (paid ? process.env.GEMINI_PAID_RPM : process.env.GEMINI_RPM) ??
            (paid ? G.paid.requestsPerMinute : G.requestsPerMinute),
        ),
        requestsPerDay: Number(
          (paid ? process.env.GEMINI_PAID_RPD : process.env.GEMINI_RPD) ??
            (paid ? G.paid.requestsPerDay : G.requestsPerDay),
        ),
        timeZone: G.quotaTimeZone,
      });
      const client = new GeminiClient(model, key!, limiter, { log: (l) => console.log(l) });
      const { counts, verbatimRate } = await runEval(client, model, {
        maxReplyChars: Infinity,
        keepPinyin: true,
      });
      expect(counts.valid).toBe(counts.turns);
      expect(verbatimRate).toBeGreaterThanOrEqual(minVerbatim);
    },
    60 * 60_000,
  );
});
