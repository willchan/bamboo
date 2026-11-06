// File formats of a tutor evaluation run (DESIGN §5.4). All of them live in the run's output
// directory outside the repo (`~/bamboo-eval/<run id>/`), never in a checkout:
//
//   turns.json     the sample as the engine returned it (Will's questions, Gemini's answers)
//   answers.json   every answer with its timings; rewritten after each answer, so a run resumes
//   judge.html     the blind judging page: answers labeled A, B, C… with no model names
//   key.json       label → source, plus latency and errors; never embedded in judge.html
//   results.json   Will's ratings, exported from judge.html (or saved by `bamboo-eval serve`)
import { EvalTurnsResponse } from "@bamboo/shared";
import { z } from "zod";

/** The answer key's name for Gemini's own answer. */
export const GEMINI = "gemini";

export const ModelAnswer = z.object({
  /** The model's reply as returned (null on error). */
  text: z.string().nullable(),
  /** Wall time of the chat call (the model was loaded beforehand). */
  latency_ms: z.number(),
  eval_count: z.number().nullable(),
  /** `eval_count / eval_duration`, when Ollama reports both. */
  tokens_per_sec: z.number().nullable(),
  error: z.string().nullable(),
});
export type ModelAnswer = z.infer<typeof ModelAnswer>;

export const AnswersQuestion = z.object({
  /** `q1`, `q2`…: the id the page and the key use. */
  id: z.string(),
  turn_id: z.string(),
  import_id: z.string(),
  question: z.string(),
  gemini: z.string(),
  /** By model name. */
  answers: z.record(z.string(), ModelAnswer),
});
export type AnswersQuestion = z.infer<typeof AnswersQuestion>;

export const AnswersFile = z.object({
  version: z.literal(1),
  run_id: z.string(),
  seed: z.string(),
  created_at: z.string(),
  prompt_sha: z.string(),
  ollama_url: z.string(),
  think: z.boolean(),
  models: z.array(z.string()),
  /** By model name: the warm-up call's time (loading the model). */
  load_ms: z.record(z.string(), z.number()),
  pool: EvalTurnsResponse.shape.pool,
  questions: z.array(AnswersQuestion),
});
export type AnswersFile = z.infer<typeof AnswersFile>;

export const KeyEntry = z.object({
  /** `gemini` or the model name. */
  source: z.string(),
  latency_ms: z.number().nullable(),
  tokens_per_sec: z.number().nullable(),
});

export const KeyFile = z.object({
  version: z.literal(1),
  run_id: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      turn_id: z.string(),
      /** By label (A, B…). */
      labels: z.record(z.string(), KeyEntry),
      /** Sources not shown for this question: the model failed or answered nothing. */
      missing: z.array(z.object({ source: z.string(), error: z.string() })),
    }),
  ),
});
export type KeyFile = z.infer<typeof KeyFile>;

const Score = z.number().int().min(1).max(5);

/** What judge.html exports. */
export const ResultsFile = z.object({
  run_id: z.string(),
  exported_at: z.string().optional(),
  questions: z.record(
    z.string(),
    z.object({
      ratings: z
        .record(z.string(), z.object({ accuracy: Score.nullish(), naturalness: Score.nullish() }))
        .default({}),
      preferred: z.string().nullish(),
    }),
  ),
});
export type ResultsFile = z.infer<typeof ResultsFile>;
