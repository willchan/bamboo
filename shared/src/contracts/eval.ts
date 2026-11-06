// The tutor evaluation (docs/ROADMAP.md › Tutor › Local tutor evaluation), with the AGENT token:
// a seeded sample of Will's past questions and Gemini's answers, read by `bamboo-eval` on the Mac.
import { z } from "zod";
import { sharedConfig } from "../config";

const E = sharedConfig.tutorEval;

/** `GET /api/agent/eval/turns?limit=&seed=` query. */
export const EvalTurnsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(E.maxLimit).default(E.defaultLimit),
  seed: z.string().min(1).max(E.maxSeedChars).default(E.defaultSeed),
});
export type EvalTurnsQuery = z.infer<typeof EvalTurnsQuery>;

/** One sampled turn: the question and Gemini's answer, as stored. */
export const EvalTurn = z.object({
  turn_id: z.string(),
  import_id: z.string(),
  user_text: z.string(),
  reply_text: z.string(),
});
export type EvalTurn = z.infer<typeof EvalTurn>;

/**
 * The sample, spread across imports, image-only turns skipped; the same seed and data give the
 * same sample. `pool` counts what it was drawn from.
 */
export const EvalTurnsResponse = z.object({
  turns: z.array(EvalTurn),
  pool: z.object({ turns: z.number().int(), imports: z.number().int() }),
});
export type EvalTurnsResponse = z.infer<typeof EvalTurnsResponse>;
